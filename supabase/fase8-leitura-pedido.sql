-- Fase 8: leitura do pedido médico.
-- 1) O celular lê o texto impresso (Tesseract 7) e manda as linhas com a posição de cada uma na foto.
-- 2) A IA (Edge Function ler-pedido) lê a letra do médico e diz quantos exames há, o que entendeu e, quando não tem certeza,
--    quais exames diferentes podem ser. A IA não conversa com o paciente: só devolve opções para ele marcar.
-- 3) A equipe confere a leitura no painel. O que ela confirma vira memória (ocr_aprendido): da próxima vez que a mesma
--    escrita aparecer, o exame já vem certo. Tudo fica guardado para treinar e medir a leitura (view ocr_treino).
-- Nada aqui muda o que o chat atual faz: são colunas e funções novas, e painel_anexo só devolve campos a mais.

-- ===== 1. Colunas novas da foto =====
alter table public.conversa_anexo
  add column if not exists largura integer,
  add column if not exists altura integer,
  add column if not exists ocr_motor text,
  add column if not exists ocr_linhas jsonb,
  add column if not exists ia_leitura jsonb,
  add column if not exists ia_modelo text,
  add column if not exists ia_ms integer,
  add column if not exists ia_erro text,
  add column if not exists ia_em timestamptz,
  add column if not exists escolha jsonb,
  add column if not exists escolha_em timestamptz,
  add column if not exists gabarito jsonb,
  add column if not exists gabarito_por uuid references public.agentes(id) on delete set null,
  add column if not exists gabarito_em timestamptz;
comment on column public.conversa_anexo.ocr_linhas is 'Linhas lidas no celular: [{t: texto, c: confiança 0-100, b: [x0,y0,x1,y1] em pixels da foto guardada}].';
comment on column public.conversa_anexo.ia_leitura is 'Leitura da IA (Edge Function ler-pedido): total de exames, o que está escrito, o que entendeu, certeza e opções do catálogo.';
comment on column public.conversa_anexo.escolha is 'O que o paciente marcou a partir da leitura: [{linha, procedimento_id, lado, texto}].';
comment on column public.conversa_anexo.gabarito is 'O que a equipe confirmou ser o pedido: [{linha, procedimento_id, lado}]. É o "certo" para treinar e medir a leitura.';

-- ===== 2. Memória da letra dos médicos =====
create table if not exists public.ocr_aprendido (
  texto_norm text not null,
  procedimento_id integer not null references public.catalogo_procedimento(id) on delete cascade,
  vezes integer not null default 1,
  exemplo text,
  atualizado_em timestamptz not null default now(),
  primary key (texto_norm, procedimento_id)
);
alter table public.ocr_aprendido enable row level security;
comment on table public.ocr_aprendido is 'Escrita de pedido médico (normalizada) -> exame, confirmada pela equipe no painel. Só a linha do exame, nunca dado do paciente.';
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ocr_aprendido' and policyname = 'ocr_aprendido_select') then
    create policy ocr_aprendido_select on public.ocr_aprendido for select using ((select public.papel_atual()) = 'admin');
  end if;
end $$;

-- Chave da memória: o texto normalizado sem o lado (o lado é lido à parte), sem números soltos e sem palavras de pedido.
create or replace function public.ocr_chave(t text) returns text language sql stable set search_path to '' as $$
  select nullif(btrim(regexp_replace(regexp_replace(public.fluxo_norm_exame(left(coalesce(t, ''), 200)),
    '\m(DIREITO|DIREITA|ESQUERDO|ESQUERDA|DIR|ESQ|BILATERAL|AMBOS|LADO|LADOS|SOLICITO|SOLICITACAO|PEDIDO|REALIZAR|FAVOR|EXAME|EXAMES|\d+)\M', ' ', 'g'),
    '\s+', ' ', 'g')), '')
$$;

-- Um exame do catálogo no mesmo formato que chat_exames_buscar devolve (o chat desenha os dois do mesmo jeito).
create or replace function public.ocr_exame_json(p_id integer, p_lado text, p_linha text) returns jsonb language sql stable set search_path to '' as $$
  select jsonb_build_object('id', x.id, 'nome', x.nome, 'modalidade', x.modalidade, 'regiao', reg.codigo, 'regiao_nome', reg.nome,
           'tem_lado', coalesce(reg.tem_lado, false), 'bilateral', x.nome ~* 'BILATERAL', 'lado', nullif(p_lado, 'N'), 'linha', left(p_linha, 120))
  from public.fluxo_exames x
  left join lateral (select g.codigo, g.nome, g.tem_lado from public.catalogo_regiao g
                     where regexp_replace(public.norm_nome(x.nome), 'NAO INCLUI.*$', '') ~ g.padrao order by g.ordem limit 1) reg on true
  where x.id = p_id
$$;

create or replace function public.ocr_lado(t text) returns text language sql stable set search_path to '' as $$
  select case when n ~ '\mBILATERA|\mAMBOS\M|\mDOIS LADOS' then 'A' when n ~ '\mDIREIT|\mDIR\M| D$' then 'D' when n ~ '\mESQUERD|\mESQ\M| E$' then 'E' end
  from (select coalesce(public.norm_nome(t), '') n) q
$$;

-- ===== 3. Leitura do celular (Tesseract): linhas -> grupos de exame para o paciente conferir =====
-- Um grupo por exame encontrado no pedido. certeza: alta (um exame só, ou já aprendido), media (achou, mas há parecidos),
-- nenhum (a linha parece um exame, mas não está no catálogo: o atendente confere pela foto).
create or replace function public.chat_pedido_ler(p_conversa uuid, p_token text, p_anexo bigint, p_texto text, p_linhas jsonb,
                                                  p_largura integer default null, p_altura integer default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_linhas jsonb; l jsonb; t text; k text; v_lado text; v_apr integer; v_ops jsonb; v_grupos jsonb := '[]'::jsonb;
        v_vistos integer[] := '{}'; v_id integer; n integer := 0; v_crianca boolean;
begin
  perform public.chat_valida(p_conversa, p_token);
  if not exists (select 1 from public.conversa_anexo where id = p_anexo and conversa_id = p_conversa) then
    raise exception 'Foto não encontrada.' using errcode = '22023';
  end if;
  v_linhas := case when jsonb_typeof(p_linhas) = 'array' and jsonb_array_length(p_linhas) > 0 then p_linhas
                   else coalesce((select jsonb_agg(jsonb_build_object('t', x)) from regexp_split_to_table(left(coalesce(p_texto, ''), 4000), '[\n;]+') x
                                  where length(btrim(x)) >= 4), '[]'::jsonb) end;
  update public.conversa_anexo set ocr_texto = left(coalesce(p_texto, ocr_texto), 4000), ocr_motor = 'tesseract.js 7',
    ocr_linhas = (select jsonb_agg(e) from (select e from jsonb_array_elements(v_linhas) e limit 40) q),
    largura = coalesce(p_largura, largura), altura = coalesce(p_altura, altura)
  where id = p_anexo;
  select paciente_tipo = 'filho' into v_crianca from public.conversas where id = p_conversa;

  for l in select e from jsonb_array_elements(v_linhas) e limit 40 loop
    exit when n >= 12;
    -- Sem o número da lista e sem riscos da borda: "| 2) USG abdome total" vira "USG abdome total".
    t := regexp_replace(left(btrim(coalesce(l ->> 't', '')), 160), '^[|•*·.\-\s]*(\d{1,2}\s*[).\-]\s*)?', '');
    k := public.ocr_chave(t);
    continue when k is null or length(replace(k, ' ', '')) < 3;
    v_lado := public.ocr_lado(t);
    select a.procedimento_id into v_apr from public.ocr_aprendido a join public.fluxo_exames x on x.id = a.procedimento_id
     where a.texto_norm = k order by a.vezes desc, a.atualizado_em desc limit 1;
    if v_apr is not null then
      continue when v_apr = any (v_vistos);
      v_ops := jsonb_build_array(jsonb_build_object('exame', public.ocr_exame_json(v_apr, v_lado, t)));
    else
      -- Escrita curta demais ("RM J") só vale pela memória: sozinha, a busca acharia qualquer coisa.
      continue when length(replace(k, ' ', '')) < 4;
      -- Exame de criança (ou fetal) só vem primeiro quando o pedido diz ou quando o paciente é criança.
      select coalesce(jsonb_agg(jsonb_build_object('exame', c.v - 'sugerido') order by c.fora, c.ord), '[]'::jsonb) into v_ops
      from (select v, ord, public.norm_nome(v ->> 'nome') ~ case when v_crianca then 'FETAL|OBSTETR|GESTA' else 'PEDIATR|INFANTIL|NEONAT|FETAL' end
                           and k !~ case when v_crianca then 'FETAL|OBSTETR|GESTA' else 'PEDIATR|INFANTIL|NEONAT|FETAL' end as fora
            from jsonb_array_elements(public.chat_exames_buscar(p_conversa, p_token, t, true)) with ordinality q(v, ord)) c;
      -- A mesma linha repetida no pedido (ou lida duas vezes) não vira um segundo exame.
      continue when jsonb_array_length(v_ops) > 0 and (v_ops -> 0 -> 'exame' ->> 'id')::int = any (v_vistos);
      select coalesce(jsonb_agg(o), '[]'::jsonb) into v_ops from jsonb_array_elements(v_ops) o where (o -> 'exame' ->> 'id')::int <> all (v_vistos);
    end if;
    if jsonb_array_length(v_ops) = 0 then
      -- Linha sem exame no catálogo: só vira grupo se tiver cara de exame (cabeçalho, nome do médico e endereço ficam de fora).
      continue when k !~ '\m(RM|TC|US|RX|DOPPLER|MAMOGRAF|DENSITOMETR|ECOCARDIO|ELETRO|ANGIO|CINTILOGRAF|ENDOSCOP|COLONOSCOP|HOLTER|MAPA|ERGOMETR|ESPIROMETR|AUDIOMETR|BIOPSIA|PUNCAO|ELASTOGRAF)';
      v_grupos := v_grupos || jsonb_build_object('linha', t, 'caixa', l -> 'b', 'origem', 'leitura', 'certeza', 'nenhum', 'lado', v_lado, 'opcoes', '[]'::jsonb);
    else
      v_id := (v_ops -> 0 -> 'exame' ->> 'id')::int;
      v_vistos := v_vistos || v_id;
      v_grupos := v_grupos || jsonb_build_object('linha', t, 'caixa', l -> 'b', 'origem', case when v_apr is not null then 'aprendido' else 'leitura' end,
        'certeza', case when v_apr is not null or jsonb_array_length(v_ops) = 1 then 'alta' else 'media' end, 'lado', v_lado, 'opcoes', v_ops);
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('anexo', p_anexo, 'grupos', v_grupos, 'total', jsonb_array_length(v_grupos));
end $$;

-- O que o paciente marcou a partir da leitura (vai junto do pedido; serve para medir onde a leitura erra).
create or replace function public.chat_pedido_escolha(p_conversa uuid, p_token text, p_anexo bigint, p_escolha jsonb) returns void
language plpgsql security definer set search_path to '' as $$
begin
  perform public.chat_valida(p_conversa, p_token);
  if jsonb_typeof(p_escolha) <> 'array' or jsonb_array_length(p_escolha) > 20 or length(p_escolha::text) > 20000 then
    raise exception 'Escolha inválida.' using errcode = '22023';
  end if;
  update public.conversa_anexo set escolha = p_escolha, escolha_em = now() where id = p_anexo and conversa_id = p_conversa;
end $$;

-- ===== 4. Leitura pela IA (só a Edge Function ler-pedido chama, com a chave de serviço) =====
-- Entrega a foto, o catálogo e o que a equipe já ensinou. Se a foto já foi lida, devolve a leitura guardada (não paga duas vezes).
create or replace function public.ocr_ia_contexto(p_conversa uuid, p_token text, p_anexo bigint) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare a record; v_tipo text;
begin
  perform public.chat_valida(p_conversa, p_token);
  select id, mime, dados, ia_leitura into a from public.conversa_anexo where id = p_anexo and conversa_id = p_conversa;
  if a.id is null then raise exception 'Foto não encontrada.' using errcode = '22023'; end if;
  if a.ia_leitura is not null then return jsonb_build_object('pronto', public.ocr_ia_grupos(p_anexo)); end if;
  select paciente_tipo into v_tipo from public.conversas where id = p_conversa;
  return jsonb_build_object(
    'mime', a.mime, 'base64', encode(a.dados, 'base64'), 'paciente', case when v_tipo = 'filho' then 'criança ou adolescente' else 'adulto' end,
    'catalogo', (select jsonb_agg(jsonb_build_array(x.id, x.nome, x.modalidade) order by x.id) from public.fluxo_exames x),
    'aprendido', coalesce((select jsonb_agg(jsonb_build_array(q.exemplo, q.procedimento_id) order by q.vezes desc)
                           from (select ap.exemplo, ap.procedimento_id, ap.vezes from public.ocr_aprendido ap
                                 join public.fluxo_exames x on x.id = ap.procedimento_id
                                 where ap.exemplo is not null order by ap.vezes desc, ap.atualizado_em desc limit 120) q), '[]'::jsonb));
end $$;

-- Converte a leitura guardada em grupos para o chat. Só aceita exames que estão no catálogo (o que a IA inventar some).
-- certeza: alta (um exame só), duvida (exames diferentes: o paciente escolhe), nenhum (ilegível ou fora do catálogo).
create or replace function public.ocr_ia_grupos(p_anexo bigint) returns jsonb language sql stable set search_path to '' as $$
  select jsonb_build_object('anexo', a.id,
    'total', coalesce((a.ia_leitura ->> 'total_exames')::int, 0),
    'legibilidade', a.ia_leitura ->> 'legibilidade',
    'e_pedido', coalesce((a.ia_leitura ->> 'e_pedido_medico')::boolean, true),
    'grupos', coalesce((
      select jsonb_agg(g order by g.ord) from (
        select e.ord, jsonb_build_object('linha', left(e.v ->> 'escrito', 160), 'explicacao', left(e.v ->> 'entendido', 160), 'origem', 'ia',
                 'lado', nullif(e.v ->> 'lado', 'N'),
                 'certeza', case when cardinality(o.ops) = 0 then 'nenhum' when cardinality(o.ops) > 1 then 'duvida'
                                 when e.v ->> 'certeza' = 'baixa' then 'media' else 'alta' end,
                 'opcoes', to_jsonb(o.ops)) as g
        from jsonb_array_elements(coalesce(a.ia_leitura -> 'exames', '[]'::jsonb)) with ordinality e(v, ord)
        cross join lateral (
          select coalesce(array_agg(jsonb_build_object('rotulo', left(op.v ->> 'rotulo', 120), 'exame', ex.j) order by op.ord), '{}') as ops
          from jsonb_array_elements(coalesce(e.v -> 'opcoes', '[]'::jsonb)) with ordinality op(v, ord)
          cross join lateral (select public.ocr_exame_json(i.id, e.v ->> 'lado', e.v ->> 'escrito') as j
                              from (select (x #>> '{}')::int as id from jsonb_array_elements(coalesce(op.v -> 'ids', '[]'::jsonb)) x
                                    where jsonb_typeof(x) = 'number') i
                              join public.fluxo_exames fx on fx.id = i.id
                              order by fx.demanda desc limit 1) ex
          where ex.j is not null and op.ord <= 4) o
        where e.ord <= 12) g), '[]'::jsonb))
  from public.conversa_anexo a where a.id = p_anexo
$$;

create or replace function public.ocr_ia_salvar(p_anexo bigint, p_leitura jsonb, p_modelo text, p_ms integer, p_erro text) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  update public.conversa_anexo set ia_leitura = case when jsonb_typeof(p_leitura) = 'object' then p_leitura end,
    ia_modelo = left(p_modelo, 60), ia_ms = p_ms, ia_erro = left(p_erro, 500), ia_em = now()
  where id = p_anexo;
  return case when p_leitura is null then null else public.ocr_ia_grupos(p_anexo) end;
end $$;

-- ===== 5. Painel: ver a foto com as leituras e conferir (ensina o sistema) =====
create or replace function public.painel_anexo(p_id bigint) returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare r jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select jsonb_build_object('mime', a.mime, 'base64', encode(a.dados, 'base64'), 'ocr', a.ocr_texto, 'criado_em', a.criado_em,
    'ocr_linhas', a.ocr_linhas, 'ia', case when a.ia_leitura is not null then public.ocr_ia_grupos(a.id) end, 'ia_modelo', a.ia_modelo, 'ia_ms', a.ia_ms,
    'ia_erro', a.ia_erro, 'escolha', a.escolha, 'gabarito', a.gabarito, 'gabarito_em', a.gabarito_em,
    'itens', coalesce((select jsonb_agg(jsonb_build_object('procedimento_id', i.procedimento_id, 'procedimento', i.procedimento, 'lado', i.lado) order by i.id)
                       from public.pre_agendamento_itens i where i.conversa_id = a.conversa_id and i.ativo), '[]'::jsonb))
    into r
  from public.conversa_anexo a where a.id = p_id;
  return r;
end $$;

-- Exames do catálogo para o atendente escolher ao conferir (busca pelo nome, como no chat).
create or replace function public.painel_exames_buscar(p_termo text) returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare k text := public.fluxo_norm_exame(left(coalesce(p_termo, ''), 120));
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'nome', q.nome) order by q.demanda desc, q.nome) from (
    select x.id, x.nome, x.demanda from public.fluxo_exames x
    where k <> '' and (select bool_and(x.chave ~ ('\m' || w)) from unnest(string_to_array(k, ' ')) w where length(w) >= 2)
    order by x.demanda desc limit 15) q), '[]'::jsonb);
end $$;

-- A equipe confirma o que está no pedido: [{linha: "como está escrito", procedimento_id, lado}].
-- Cada linha confirmada entra na memória (ocr_aprendido) e a leitura seguinte já acerta sozinha.
create or replace function public.painel_anexo_conferir(p_id bigint, p_itens jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare it jsonb; k text; v_id integer; n integer := 0;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  if jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) > 20 then raise exception 'Conferência inválida.' using errcode = '22023'; end if;
  if not exists (select 1 from public.conversa_anexo where id = p_id) then raise exception 'Foto não encontrada.' using errcode = '22023'; end if;
  for it in select e from jsonb_array_elements(p_itens) e loop
    v_id := nullif(it ->> 'procedimento_id', '')::int;
    continue when v_id is null or not exists (select 1 from public.catalogo_procedimento where id = v_id);
    k := public.ocr_chave(it ->> 'linha');
    continue when k is null or length(replace(k, ' ', '')) < 3;
    insert into public.ocr_aprendido as ap (texto_norm, procedimento_id, vezes, exemplo)
    values (k, v_id, 1, left(btrim(it ->> 'linha'), 120))
    on conflict (texto_norm, procedimento_id) do update set vezes = ap.vezes + 1, atualizado_em = now();
    n := n + 1;
  end loop;
  update public.conversa_anexo set gabarito = p_itens, gabarito_por = (select auth.uid()), gabarito_em = now() where id = p_id;
  return jsonb_build_object('ok', true, 'aprendidos', n);
end $$;

-- ===== 6. Material de treino e medição =====
-- Uma linha por foto conferida: o que o celular leu, o que a IA leu, o que o paciente marcou e o que a equipe confirmou.
create or replace view public.ocr_treino with (security_invoker = true) as
  select a.id, a.criado_em, a.ocr_motor, a.ocr_texto, a.ia_modelo, a.ia_ms, a.ia_leitura, a.escolha, a.gabarito, a.gabarito_em,
         (select count(*) from jsonb_array_elements(coalesce(a.gabarito, '[]'::jsonb)) g
          where exists (select 1 from jsonb_array_elements(coalesce(a.ia_leitura -> 'exames', '[]'::jsonb)) e,
                                      jsonb_array_elements(coalesce(e -> 'opcoes', '[]'::jsonb)) o, jsonb_array_elements(coalesce(o -> 'ids', '[]'::jsonb)) i
                        where i::text = g ->> 'procedimento_id')) as ia_acertos,
         jsonb_array_length(coalesce(a.gabarito, '[]'::jsonb)) as exames_confirmados
  from public.conversa_anexo a
  where a.gabarito is not null;
revoke all on public.ocr_treino from anon, authenticated;

-- ===== 7. Permissões =====
revoke all on function public.ocr_chave(text), public.ocr_exame_json(integer, text, text), public.ocr_lado(text),
  public.ocr_ia_contexto(uuid, text, bigint), public.ocr_ia_grupos(bigint), public.ocr_ia_salvar(bigint, jsonb, text, integer, text) from public, anon, authenticated;
grant execute on function public.ocr_ia_contexto(uuid, text, bigint), public.ocr_ia_salvar(bigint, jsonb, text, integer, text) to service_role;
grant execute on function public.chat_pedido_ler(uuid, text, bigint, text, jsonb, integer, integer), public.chat_pedido_escolha(uuid, text, bigint, jsonb) to anon, authenticated;
revoke all on function public.painel_exames_buscar(text), public.painel_anexo_conferir(bigint, jsonb) from public, anon;
grant execute on function public.painel_exames_buscar(text), public.painel_anexo_conferir(bigint, jsonb) to authenticated;
