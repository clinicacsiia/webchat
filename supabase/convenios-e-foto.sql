-- Convênios com chave liga/desliga, regras por convênio, avisos de mudança, pedido unificado e fotos do pedido para o atendente.
-- Criado em 01/11/2026. Ordem de aplicação: depois de fase7-motor.sql, correcao-convenio-quem-volta.sql, fase8-leitura-pedido.sql e catalogo-precos.sql.
--
-- O que muda:
--   * convenio_config: um registro por convênio (operadora do Klingo). Sem registro = ativo, sem regra.
--       - ativo = false: o convênio some da lista do chat; se o paciente digitar o nome, ele recebe a mensagem (própria ou padrão) e escolhe outro,
--         Particular ou atendente. O Particular nunca é desativado.
--       - aviso: nota que o paciente lê ao escolher aquele convênio (opcional).
--       - um_por_vez: o convênio só faz um exame por vez; se o pedido tem mais de um, o paciente é avisado e o atendente recebe uma nota.
--   * convenio_evento: tudo o que muda (preço do convênio, preço Particular, convênio ligado/desligado, regra) fica registrado e aparece como aviso
--     no painel até alguém marcar como visto. O gatilho em catalogo_mudanca registra sozinho as mudanças de preço que a sincronização noturna encontra.
--   * Funções do painel (só administrador): convenios_painel, convenio_detalhe, convenio_salvar, convenio_eventos, convenio_eventos_visto, convenio_aviso_contagem.
--     convenio_inativos serve também ao atendente (aviso de que o convênio escolhido foi desativado depois).
--   * chat_pedido_enviar: envia de uma vez o pedido montado no chat (tipo, parte, lado, exame) junto com os exames lidos da foto e os escritos à mão.
--     As funções antigas chat_pedido_salvar e chat_exames_salvar continuam como estavam (aparelhos com a página antiga guardada ainda as chamam).
--   * Fotos do pedido: painel_anexos_resumo (quantas fotos cada conversa tem e quantas faltam conferir no Klingo) e painel_anexo_klingo_conferido.
--
-- Cada remendo de função falha sem alterar nada se o trecho esperado não for encontrado (ou aparecer mais de uma vez) e pode ser reaplicado sem efeito.
-- Sem comandos destrutivos. Para voltar atrás: reaplique fase7-motor.sql e correcao-convenio-quem-volta.sql (as tabelas novas podem ficar).

-- Auxiliar (existe só nesta sessão): troca trechos exatos no corpo de uma função; cada trecho tem de aparecer UMA vez.
create or replace function pg_temp.remendar(p_funcao regprocedure, p_marca text, p_de text[], p_para text[]) returns text
language plpgsql as $$
declare d text; d2 text; i int; n int;
begin
  d := pg_get_functiondef(p_funcao);
  if position(p_marca in d) > 0 then return 'já aplicado: ' || p_funcao::text; end if;
  d2 := d;
  for i in 1 .. array_length(p_de, 1) loop
    n := (length(d2) - length(replace(d2, p_de[i], ''))) / length(p_de[i]);
    if n <> 1 then
      raise exception '% : o trecho % aparece % vez(es); nada foi alterado.', p_funcao::text, i, n;
    end if;
    d2 := replace(d2, p_de[i], p_para[i]);
  end loop;
  execute d2;
  return 'aplicado: ' || p_funcao::text;
end $$;

-- 1. Textos (a equipe pode editar; "on conflict do nothing" não mexe em texto já editado).
insert into public.fluxo_texto (chave, texto, descricao) values
 ('convenio_inativo', 'No momento não estamos atendendo pelo convênio {convenio}. Você pode escolher outro convênio, seguir como particular ou falar com um atendente.', 'Convênio desativado pela gestão: mensagem padrão'),
 ('convenio_varios', 'Para o convênio {convenio} a clínica faz um exame por vez. Vamos organizar o primeiro agora e o atendente combina os outros com você.', 'Convênio com a regra de um exame por vez: mensagem padrão')
on conflict (chave) do nothing;

-- A pergunta do exame agora começa pela foto do pedido (só se ainda estiver o texto original).
update public.fluxo_texto set texto = 'Você tem o pedido médico? Envie a foto que eu procuro o exame para você. Se preferir, escolha o exame pela lista: tipo, parte do corpo e lado.'
 where chave = 'exame' and texto = 'Escolha o exame. Você pode procurar pelo nome, tirar uma foto do pedido médico ou escolher pelo desenho do corpo.';

-- 2. Tabelas (sem política: só as funções abaixo, que conferem o papel, leem e gravam).
create table if not exists public.convenio_config (
  operadora text primary key,
  ativo boolean not null default true,
  mensagem_inativo text,
  aviso text,
  um_por_vez boolean not null default false,
  msg_varios text,
  motivo text,
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid
);
alter table public.convenio_config enable row level security;
revoke all on public.convenio_config from anon, authenticated;
comment on table public.convenio_config is 'Regras por convênio (nome da operadora do Klingo, em maiúsculas). Sem registro = ativo e sem regra. Só as funções convenio_* leem e gravam.';

create table if not exists public.convenio_evento (
  id bigint generated always as identity primary key,
  criado_em timestamptz not null default now(),
  operadora text not null,
  tipo text not null,
  descricao text not null,
  antes text,
  depois text,
  variacao_pct numeric,
  relevante boolean not null default false,
  origem text not null default 'catalogo',
  visto_em timestamptz,
  visto_por uuid
);
create index if not exists convenio_evento_novos_idx on public.convenio_evento (criado_em desc) where visto_em is null;
create index if not exists convenio_evento_op_idx on public.convenio_evento (operadora, criado_em desc);
alter table public.convenio_evento enable row level security;
revoke all on public.convenio_evento from anon, authenticated;
comment on table public.convenio_evento is 'Mudanças que a gestão precisa ver: preço de convênio, preço Particular, convênio ligado ou desligado, regra alterada.';

alter table public.conversa_anexo add column if not exists klingo_conferido_em timestamptz;
alter table public.conversa_anexo add column if not exists klingo_conferido_por uuid;

-- 3. Auxiliares (chamadas só por outras funções do banco).
create or replace function public.convenio_chave(t text) returns text
language sql immutable set search_path to '' as $$
  select upper(regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g'))
$$;

create or replace function public.convenio_ativo(p_operadora text) returns boolean
language sql stable security definer set search_path to '' as $$
  select case when public.convenio_chave(p_operadora) ~ '^(|PARTICULAR.*)$' then true
    else coalesce((select c.ativo from public.convenio_config c where c.operadora = public.convenio_chave(p_operadora)), true) end
$$;

-- Texto de um convênio: o próprio, se a gestão escreveu, senão o padrão (fluxo_texto). {convenio} vira o nome.
create or replace function public.convenio_msg(p_operadora text, p_tipo text) returns text
language plpgsql stable security definer set search_path to '' as $$
declare c public.convenio_config; t text;
begin
  select * into c from public.convenio_config where operadora = public.convenio_chave(p_operadora);
  t := case p_tipo
    when 'inativo' then coalesce(nullif(btrim(c.mensagem_inativo), ''), public.fluxo_t('convenio_inativo'))
    when 'varios' then coalesce(nullif(btrim(c.msg_varios), ''), public.fluxo_t('convenio_varios'))
    when 'aviso' then nullif(btrim(c.aviso), '')
  end;
  if t is null then return null; end if;
  return replace(t, '{convenio}', initcap(lower(btrim(p_operadora))));
end $$;

-- Dita ao paciente o aviso do convênio escolhido e a regra "um exame por vez" (e deixa uma nota para o atendente).
create or replace function public.convenio_avisar(p_conversa uuid, p_operadora text) returns void
language plpgsql security definer set search_path to '' as $$
declare c public.convenio_config; n int; m text;
begin
  if public.convenio_chave(p_operadora) ~ '^(|PARTICULAR.*)$' then return; end if;
  select * into c from public.convenio_config where operadora = public.convenio_chave(p_operadora);
  if not found then return; end if;
  m := public.convenio_msg(p_operadora, 'aviso');
  if m is not null then perform public.fluxo_dizer(p_conversa, m); end if;
  if c.um_por_vez then
    select count(*) into n from public.pre_agendamento_itens where conversa_id = p_conversa and ativo;
    if n > 1 then
      perform public.fluxo_dizer(p_conversa, public.convenio_msg(p_operadora, 'varios'));
      perform public.fluxo_nota(p_conversa, 'Convênio ' || initcap(lower(btrim(p_operadora))) || ' faz um exame por vez e o pedido tem ' || n || ' exames: combinar a ordem com o paciente');
    end if;
  end if;
end $$;

revoke all on function public.convenio_chave(text) from public, anon, authenticated;
revoke all on function public.convenio_ativo(text) from public, anon, authenticated;
revoke all on function public.convenio_msg(text, text) from public, anon, authenticated;
revoke all on function public.convenio_avisar(uuid, text) from public, anon, authenticated;

-- 4. Motor do chat: convênio desativado não aparece, não é aceito e é explicado.
select pg_temp.remendar('public.fluxo_perguntar(uuid,text,text)'::regprocedure, 'convenios-e-foto',
  array[E'    from (select operadora, count(*) n from public.catalogo_plano where coalesce(ativo, true) and operadora !~* ''^(teste|particular)$'' group by operadora) o;'],
  array[E'    -- convenios-e-foto: convênio desativado pela gestão não entra na lista.\n    from (select operadora, count(*) n from public.catalogo_plano where coalesce(ativo, true) and operadora !~* ''^(teste|particular)$'' and public.convenio_ativo(operadora) group by operadora) o;']);

select pg_temp.remendar('public.fluxo_aplicar(uuid,text,jsonb)'::regprocedure, 'convenios-e-foto',
  array[E'      if v_ok and nullif(btrim(coalesce(x, '''')), '''') is not null then',
        E'    x := btrim(coalesce(v, o ->> ''outro'', ''''));',
        E'    perform public.fluxo_set(p_conversa, ''{"plano_anterior": null}'');\n    -- convenio-quem-volta: corrigiu'],
  array[E'      if v_ok and nullif(btrim(coalesce(x, '''')), '''') is not null and public.convenio_ativo(x) then   -- convenios-e-foto: convênio desativado depois não vira pergunta',
        E'    x := btrim(coalesce(v, o ->> ''outro'', ''''));\n    -- convenios-e-foto: convênio desativado pela gestão não é aceito; a pessoa escolhe outro, Particular ou o atendente.\n    if x <> '''' and not public.convenio_ativo(x) then\n      return jsonb_build_object(''ok'', false, ''erro'', public.convenio_msg(x, ''inativo''));\n    end if;',
        E'    perform public.fluxo_set(p_conversa, ''{"plano_anterior": null}'');\n    perform public.convenio_avisar(p_conversa, x);   -- convenios-e-foto: aviso e regra "um exame por vez"\n    -- convenio-quem-volta: corrigiu']);
-- (O convênio da vez anterior, se foi desativado depois, deixa de virar pergunta "plano_confirma": o paciente cai na lista normal de planos.)

-- 5. Pedido unificado: o que foi montado no chat (tipo, parte, lado, exame), o que veio da foto e o que o paciente escreveu à mão.
-- Cada item: {procedimento_id, modalidade, regiao, lado} ou {texto}. Devolve também as respostas do motor (como chat_exames_salvar).
create or replace function public.chat_pedido_enviar(p_conversa uuid, p_token text, p_itens jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare it jsonb; p record; reg record; v_mod text; v_modnome text; v_lado text; v_qtd int; v_linhas text[] := '{}'; v_nomes text[] := '{}'; v_n int := 0;
  v_msg bigint; v_txt text; v_livre text; v_pid int; v_regnome text; v_plano text;
begin
  perform public.chat_valida(p_conversa, p_token);
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 or jsonb_array_length(p_itens) > 12 then
    raise exception 'Pedido inválido.' using errcode = '22023';
  end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  if exists (select 1 from public.pre_agendamentos where conversa_id = p_conversa and status in ('agendado','cancelado','pronto')) then
    raise exception 'Este pedido já foi enviado. Inicie um novo atendimento.' using errcode = '22023';
  end if;
  update public.pre_agendamento_itens set ativo = false where conversa_id = p_conversa and ativo;
  for it in select * from jsonb_array_elements(p_itens) loop
    v_livre := nullif(left(btrim(coalesce(it ->> 'texto', '')), 160), '');
    v_pid := case when coalesce(it ->> 'procedimento_id', '') ~ '^\d{1,9}$' then (it ->> 'procedimento_id')::int end;
    if v_pid is null then
      if v_livre is not null then
        insert into public.pre_agendamento_itens (conversa_id, modalidade, lado, procedimento_id, procedimento, quantidade) values (p_conversa, 'OUTRO', 'N', null, v_livre, 1);
        v_linhas := v_linhas || ('• ' || v_livre || ' (o atendente confere o exame)'); v_nomes := v_nomes || v_livre; v_n := v_n + 1;
        continue;
      end if;
      -- Sem exame escolhido ("o atendente escolhe"): precisa do tipo e da parte do corpo.
      v_mod := upper(coalesce(it ->> 'modalidade', ''));
      if v_mod not in ('RM','TC','US','RX','MAMO','DENSITO') then raise exception 'Escolha o exame.' using errcode = '22023'; end if;
      v_modnome := case v_mod when 'RM' then 'Ressonância magnética' when 'TC' then 'Tomografia' when 'US' then 'Ultrassom' when 'RX' then 'Raio-X' when 'MAMO' then 'Mamografia' else 'Densitometria óssea' end;
      select g.codigo, g.nome, g.tem_lado into reg from public.catalogo_regiao g where g.codigo = it ->> 'regiao';
      v_regnome := coalesce(reg.nome, case when it ->> 'regiao' = 'outros' then 'Outros exames' end);
      v_lado := upper(coalesce(nullif(it ->> 'lado', ''), 'N'));
      if reg.codigo is not null and reg.tem_lado then
        if v_lado not in ('D','E','A') then raise exception 'Informe o lado (direito, esquerdo ou ambos) de: %.', reg.nome using errcode = '22023'; end if;
      else v_lado := 'N'; end if;
      v_qtd := case when v_lado = 'A' then 2 else 1 end;
      insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
        values (p_conversa, v_mod, nullif(it ->> 'regiao', ''), v_regnome, v_lado, null, null, v_qtd);
      v_linhas := v_linhas || ('• ' || v_modnome || case when v_regnome is not null then ' — ' || v_regnome else '' end
        || case v_lado when 'D' then ' (lado direito)' when 'E' then ' (lado esquerdo)' when 'A' then ' (os dois lados)' else '' end || ': exame a definir com o atendente');
      v_nomes := v_nomes || (v_modnome || ' ' || coalesce(v_regnome, ''));
      v_n := v_n + 1;
      continue;
    end if;
    select pr.id, pr.nome, pr.modalidade into p from public.catalogo_procedimento pr
      where pr.id = v_pid and pr.ativo and pr.modalidade <> 'CONSULTA'
        and exists (select 1 from public.catalogo_agenda a where a.procedimento_id = pr.id and a.vig_fim >= current_date and a.profissional !~* 'teste');
    if p.id is null then raise exception 'Exame não encontrado no cadastro.' using errcode = '22023'; end if;
    select g.codigo, g.nome, g.tem_lado into reg from public.catalogo_regiao g
      where g.codigo = it ->> 'regiao' or regexp_replace(public.norm_nome(p.nome), 'NAO INCLUI.*$', '') ~ g.padrao
      order by (g.codigo = coalesce(it ->> 'regiao', '')) desc, g.ordem limit 1;
    v_lado := upper(coalesce(nullif(it ->> 'lado', ''), 'N'));
    if p.nome ~* 'BILATERAL' then v_lado := case when coalesce(reg.tem_lado, false) then 'A' else 'N' end;
    elsif coalesce(reg.tem_lado, false) then
      if v_lado not in ('D','E','A') then raise exception 'Informe o lado (direito, esquerdo ou os dois) de: %.', initcap(lower(p.nome)) using errcode = '22023'; end if;
    else v_lado := 'N'; end if;
    v_qtd := case when v_lado = 'A' and p.nome !~* 'BILATERAL' then 2 else 1 end;
    insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
      values (p_conversa, p.modalidade, reg.codigo, reg.nome, v_lado, p.id, p.nome, v_qtd);
    v_n := v_n + 1;
    v_linhas := v_linhas || ('• ' || initcap(lower(p.nome)) || case v_lado when 'D' then ' — lado direito' when 'E' then ' — lado esquerdo' when 'A' then ' — os dois lados' else '' end
      || case when v_qtd > 1 then ' (2 unidades)' else '' end);
    v_nomes := v_nomes || p.nome;
  end loop;
  insert into public.pre_agendamentos as pa (conversa_id, tipo, procedimento, etapa, paciente, status)
    values (p_conversa, 'exame', left(array_to_string(v_nomes, ' + '), 160), 'plano', '{}'::jsonb, 'rascunho')
    on conflict (conversa_id) do update set tipo = 'exame', procedimento = excluded.procedimento, escolha_horario = null, data_desejada = null, hora_desejada = null,
      etapa = case when pa.etapa is null or pa.etapa = 'pedido' then 'plano' else pa.etapa end, atualizado_em = now()
      where pa.status = 'rascunho';
  -- Convênio que faz um exame por vez e o pedido ficou com mais de um: nota para o atendente (o aviso ao paciente sai quando ele escolhe o plano).
  select pa.plano into v_plano from public.pre_agendamentos pa where pa.conversa_id = p_conversa;
  if v_n > 1 and v_plano is not null and exists (select 1 from public.convenio_config c where c.operadora = public.convenio_chave(v_plano) and c.um_por_vez) then
    perform public.fluxo_nota(p_conversa, 'Convênio ' || initcap(lower(btrim(v_plano))) || ' faz um exame por vez e o pedido tem ' || v_n || ' exames: combinar a ordem com o paciente');
  end if;
  v_txt := left('Pedido de exames:' || E'\n' || array_to_string(v_linhas, E'\n'), 3900);
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_msg;
  return jsonb_build_object('ok', true, 'itens', v_n, 'mensagem_id', v_msg, 'respostas', public.chat_respostas(p_conversa, v_msg - 1));
end $$;
revoke all on function public.chat_pedido_enviar(uuid, text, jsonb) from public;
grant execute on function public.chat_pedido_enviar(uuid, text, jsonb) to anon, authenticated;

-- 6. Fotos do pedido para o atendente: quantas fotos cada conversa tem e quantas faltam conferir no Klingo.
create or replace function public.painel_anexos_resumo() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('conversa_id', q.conversa_id, 'total', q.n, 'sem_conferir', q.sc, 'ultima', q.ult, 'ids', q.ids) order by q.ult desc)
    from (select a.conversa_id, count(*)::int n, (count(*) filter (where a.klingo_conferido_em is null))::int sc, max(a.criado_em) ult, jsonb_agg(a.id order by a.id) ids
          from public.conversa_anexo a where a.criado_em > now() - interval '120 days' group by a.conversa_id) q), '[]'::jsonb);
end $$;

create or replace function public.painel_anexo_klingo_conferido(p_conversa uuid, p_feito boolean default true) returns integer
language plpgsql security definer set search_path to '' as $$
declare n int;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  update public.conversa_anexo set klingo_conferido_em = case when p_feito then now() end, klingo_conferido_por = case when p_feito then (select auth.uid()) end
   where conversa_id = p_conversa and (klingo_conferido_em is null) = p_feito;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.painel_anexos_resumo() from public, anon;
revoke all on function public.painel_anexo_klingo_conferido(uuid, boolean) from public, anon;
grant execute on function public.painel_anexos_resumo() to authenticated;
grant execute on function public.painel_anexo_klingo_conferido(uuid, boolean) to authenticated;

-- 7. Demanda por convênio (para decidir com dados): as 4 últimas semanas completas dos agendamentos do Klingo (o histórico guardado ainda é curto), últimos 30 dias, previsão simples dos próximos 30.
-- A previsão é uma reta ajustada a essas semanas, limitada a 2x o último mês (mínimo de 4 semanas e 8 agendamentos); sem isso repete o último mês e diz que não é confiável.
create or replace function public.convenio_demanda()
returns table (chave text, semanas int[], total int, ult_30d int, ant_30d int, previsao_30d int, tendencia_pct int, confiavel boolean)
language plpgsql stable security definer set search_path to '' as $$
declare v_ini date; v_fim date; v_n int := 0; v_span boolean;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select (date_trunc('week', min(e.agendado_em)) + interval '1 week')::date, coalesce(min(e.agendado_em) <= now() - interval '60 days', false)
    into v_ini, v_span from public.jornada_exame e where e.agendado_em is not null;
  v_fim := date_trunc('week', now())::date;   -- a semana atual ainda não terminou: fica de fora
  if v_ini is not null and v_ini < v_fim then v_ini := greatest(v_ini, v_fim - 28); v_n := (v_fim - v_ini) / 7; end if;
  return query
  with ops as (select public.convenio_chave(e.operadora) ch from public.jornada_exame e where nullif(btrim(e.operadora), '') is not null group by 1),
  sem as (select g.i, (v_ini + g.i * 7) as ini from generate_series(0, greatest(v_n, 1) - 1) g(i) where v_n > 0),
  cont as (select o.ch, s.i, count(e.id)::int n from ops o cross join sem s
             left join public.jornada_exame e on public.convenio_chave(e.operadora) = o.ch and e.agendado_em >= s.ini and e.agendado_em < s.ini + 7
            group by o.ch, s.i),
  reg as (select c.ch, array_agg(c.n order by c.i) sems, sum(c.n)::int tot, regr_slope(c.n::float8, c.i::float8) b, regr_intercept(c.n::float8, c.i::float8) a, count(*)::int k from cont c group by c.ch),
  rec as (select public.convenio_chave(e.operadora) ch,
            (count(*) filter (where e.agendado_em >= now() - interval '30 days'))::int u30,
            (count(*) filter (where e.agendado_em >= now() - interval '60 days' and e.agendado_em < now() - interval '30 days'))::int a30
          from public.jornada_exame e where nullif(btrim(e.operadora), '') is not null group by 1)
  select o.ch, coalesce(r.sems, '{}'::int[]), coalesce(r.tot, 0), coalesce(rc.u30, 0), coalesce(rc.a30, 0),
    case when coalesce(r.k, 0) >= 4 and coalesce(r.tot, 0) >= 8 then least(greatest(0, round(4.29 * (r.a + r.b * (r.k + 1.65)))), greatest(2 * coalesce(rc.u30, 0), 10))::int else coalesce(rc.u30, 0) end,
    case when v_span and coalesce(rc.a30, 0) > 0 then round((coalesce(rc.u30, 0) - rc.a30) * 100.0 / rc.a30)::int end,
    (coalesce(r.k, 0) >= 4 and coalesce(r.tot, 0) >= 8)
  from ops o left join reg r on r.ch = o.ch left join rec rc on rc.ch = o.ch;
end $$;
revoke all on function public.convenio_demanda() from public, anon;
grant execute on function public.convenio_demanda() to authenticated;

-- 8. Painel de convênios (só administrador).
create or replace function public.convenios_painel() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare r jsonb;
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  with ops as (
    select ch, min(nome) nome from (
      select public.convenio_chave(operadora) ch, operadora nome from public.catalogo_plano where nullif(btrim(operadora), '') is not null and operadora !~* '^teste$'
      union all select public.convenio_chave(operadora), operadora from public.jornada_exame where nullif(btrim(operadora), '') is not null
      union all select public.convenio_chave(operadora), operadora from public.catalogo_preco where fonte = 'convenio' and nullif(btrim(operadora), '') is not null
      union all select operadora, initcap(lower(operadora)) from public.convenio_config
    ) u where ch !~ '^(PARTICULAR.*|TESTE)$' group by ch),
  dem as (select * from public.convenio_demanda()),
  tot as (select greatest(sum(d.ult_30d), 0) t30 from dem d where d.chave !~ '^PARTICULAR'),
  pl as (select public.convenio_chave(operadora) ch, count(*)::int n from public.catalogo_plano where coalesce(ativo, true) group by 1),
  pr as (select public.convenio_chave(operadora) ch, count(distinct procedimento_id)::int procs,
           (count(distinct procedimento_id) filter (where confianca = 'alta'))::int alta, (count(distinct procedimento_id) filter (where confianca = 'media'))::int media,
           (count(distinct procedimento_id) filter (where confianca = 'baixa'))::int baixa, max(visto_em) visto
         from public.catalogo_preco where fonte = 'convenio' and status = 'ativo' group by 1),
  ult as (select distinct on (public.convenio_chave(e.operadora)) public.convenio_chave(e.operadora) ch, e.procedimento, e.agendado_para
          from public.jornada_exame e where nullif(btrim(e.operadora), '') is not null and e.agendado_para <= now() and e.cancelamento_motivo is null and coalesce(e.status, '') !~* 'cancel|desmarc'
          order by public.convenio_chave(e.operadora), e.agendado_para desc),
  val as (select distinct on (public.convenio_chave(o.operadora)) public.convenio_chave(o.operadora) ch, o.procedimento, o.valor_tipico, o.amostras, o.janela_fim
          from public.preco_observado o where o.valor_tipico is not null order by public.convenio_chave(o.operadora), o.atualizado_em desc, o.janela_fim desc),
  ev as (select e.operadora ch, count(*)::int n, (count(*) filter (where e.relevante))::int rel from public.convenio_evento e where e.visto_em is null group by 1),
  chat as (select public.convenio_chave(pa.plano) ch, count(*)::int n30, (count(*) filter (where pa.status = 'rascunho' and pa.atualizado_em < now() - interval '24 hours'))::int aband
           from public.pre_agendamentos pa where pa.plano is not null and pa.criado_em >= now() - interval '30 days' group by 1),
  linhas as (
    select jsonb_build_object(
      'operadora', o.nome, 'chave', o.ch,
      'ativo', coalesce(c.ativo, true), 'mensagem_inativo', c.mensagem_inativo, 'aviso', c.aviso, 'um_por_vez', coalesce(c.um_por_vez, false), 'msg_varios', c.msg_varios, 'motivo', c.motivo,
      'atualizado_em', c.atualizado_em, 'atualizado_por', (select a.nome from public.agentes a where a.id = c.atualizado_por),
      'planos', coalesce(pl.n, 0),
      'precos', jsonb_build_object('procedimentos', coalesce(pr.procs, 0), 'alta', coalesce(pr.alta, 0), 'media', coalesce(pr.media, 0), 'baixa', coalesce(pr.baixa, 0), 'visto_em', pr.visto),
      'ultimo_exame', case when ult.ch is not null then jsonb_build_object('procedimento', ult.procedimento, 'quando', ult.agendado_para) end,
      'ultimo_valor', case when val.ch is not null then jsonb_build_object('procedimento', val.procedimento, 'valor', val.valor_tipico, 'amostras', val.amostras, 'ate', val.janela_fim) end,
      'demanda', jsonb_build_object('semanas', coalesce(d.semanas, '{}'::int[]), 'total', coalesce(d.total, 0), 'ult_30d', coalesce(d.ult_30d, 0), 'ant_30d', coalesce(d.ant_30d, 0),
        'previsao_30d', coalesce(d.previsao_30d, 0), 'tendencia_pct', d.tendencia_pct, 'confiavel', coalesce(d.confiavel, false),
        'participacao_pct', case when tot.t30 > 0 then round(coalesce(d.ult_30d, 0) * 100.0 / tot.t30, 1) else 0 end),
      'chat_30d', coalesce(chat.n30, 0), 'chat_abandonados', coalesce(chat.aband, 0),
      'em_andamento', (select count(*) from public.pre_agendamentos pa where public.convenio_chave(pa.plano) = o.ch and pa.status = 'rascunho'),
      'avisos_novos', coalesce(ev.n, 0), 'avisos_relevantes', coalesce(ev.rel, 0)) j,
      coalesce(d.ult_30d, 0) u30, o.nome
    from ops o left join public.convenio_config c on c.operadora = o.ch left join pl on pl.ch = o.ch left join pr on pr.ch = o.ch left join ult on ult.ch = o.ch left join val on val.ch = o.ch
      left join dem d on d.chave = o.ch left join ev on ev.ch = o.ch left join chat on chat.ch = o.ch cross join tot)
  select jsonb_build_object(
    'gerado_em', now(),
    'convenios', coalesce((select jsonb_agg(j order by u30 desc, nome) from linhas), '[]'::jsonb),
    'particular', jsonb_build_object(
      'precos', (select jsonb_build_object('procedimentos', count(distinct procedimento_id), 'alta', count(distinct procedimento_id) filter (where confianca = 'alta'),
                   'media', count(distinct procedimento_id) filter (where confianca = 'media'), 'baixa', count(distinct procedimento_id) filter (where confianca = 'baixa'), 'visto_em', max(visto_em))
                 from public.catalogo_preco where fonte = 'particular' and status = 'ativo'),
      'mudancas_30d', (select count(*) from public.convenio_evento where tipo = 'preco_particular' and criado_em >= now() - interval '30 days'),
      'avisos_novos', (select count(*) from public.convenio_evento where operadora ~ '^PARTICULAR' and visto_em is null)),
    'padroes', jsonb_build_object('mensagem_inativo', public.fluxo_t('convenio_inativo'), 'msg_varios', public.fluxo_t('convenio_varios')),
    'avisos_novos', (select count(*) from public.convenio_evento where visto_em is null))
  into r;
  return r;
end $$;

-- Os exames de um convênio (ou do Particular): valor no convênio, valor Particular, último valor visto nas marcações, e quando mudou.
create or replace function public.convenio_detalhe(p_operadora text, p_limite integer default 80) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_ch text := public.convenio_chave(p_operadora); v_part boolean := public.convenio_chave(p_operadora) ~ '^PARTICULAR'; r jsonb;
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  with par as (select distinct on (procedimento_id) procedimento_id, valor, confianca, amostras, visto_em, ultima_marcacao from public.catalogo_preco
               where fonte = 'particular' and status = 'ativo' order by procedimento_id, case confianca when 'alta' then 0 when 'media' then 1 else 2 end, visto_em desc),
  cv as (select distinct on (procedimento_id) procedimento_id, valor, confianca, tabela, visto_em from public.catalogo_preco
         where fonte = 'convenio' and status = 'ativo' and public.convenio_chave(operadora) = v_ch order by procedimento_id, case confianca when 'alta' then 0 when 'media' then 1 else 2 end, visto_em desc),
  obs as (select distinct on (o.procedimento_norm) o.procedimento_norm, o.valor_tipico, o.amostras, o.janela_fim from public.preco_observado o
          where public.convenio_chave(o.operadora) = v_ch and o.valor_tipico is not null order by o.procedimento_norm, o.atualizado_em desc),
  mud as (select m.chave, max(m.detectada_em) quando, (array_agg(m.antes order by m.detectada_em desc))[1] antes, (array_agg(m.depois order by m.detectada_em desc))[1] depois
          from public.catalogo_mudanca m where m.tipo = 'preco' and m.evento = 'alterado' and m.detectada_em >= now() - interval '30 days' group by m.chave),
  base as (select p.id, p.nome, p.modalidade, coalesce(p.demanda_90d, 0) demanda from public.catalogo_procedimento p
           where p.ativo and exists (select 1 from public.catalogo_agenda a where a.procedimento_id = p.id and a.vig_fim >= current_date and a.profissional !~* 'teste')
             and (v_part or exists (select 1 from cv where cv.procedimento_id = p.id))
           order by coalesce(p.demanda_90d, 0) desc, p.nome limit greatest(1, least(coalesce(p_limite, 80), 300)))
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'exame', b.nome, 'modalidade', b.modalidade, 'demanda_90d', b.demanda,
      'valor_convenio', cv.valor, 'confianca_convenio', cv.confianca, 'tabela', cv.tabela,
      'valor_particular', par.valor, 'confianca_particular', par.confianca, 'amostras_particular', par.amostras, 'particular_visto_em', par.visto_em,
      'ultimo_valor_marcacao', obs.valor_tipico, 'ultimo_valor_amostras', obs.amostras, 'ultimo_valor_ate', obs.janela_fim,
      'mudou_em', mud.quando, 'mudou_de', mud.antes, 'mudou_para', mud.depois) order by b.demanda desc, b.nome), '[]'::jsonb)
  into r
  from base b left join par on par.procedimento_id = b.id left join cv on cv.procedimento_id = b.id
    left join obs on obs.procedimento_norm = public.norm_nome(b.nome) left join mud on mud.chave = 'particular|' || b.id;
  return r;
end $$;

-- Salva as regras de um convênio e registra a mudança. Devolve o efeito para a gestão ver na hora.
create or replace function public.convenio_salvar(p_operadora text, p_dados jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_ch text := public.convenio_chave(p_operadora); v_nome text := initcap(lower(btrim(coalesce(p_operadora, '')))); c public.convenio_config; n public.convenio_config;
  v_uid uuid := (select auth.uid()); v_em int; v_30 int;
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  if v_ch = '' or length(v_ch) > 120 then raise exception 'Convênio inválido.' using errcode = '22023'; end if;
  if v_ch ~ '^PARTICULAR' and (p_dados ? 'ativo') and not (p_dados ->> 'ativo')::boolean then raise exception 'O Particular não pode ser desativado.' using errcode = '22023'; end if;
  if p_dados is null or jsonb_typeof(p_dados) <> 'object' then raise exception 'Dados inválidos.' using errcode = '22023'; end if;
  select * into c from public.convenio_config where operadora = v_ch;
  n := c;
  n.operadora := v_ch;
  n.ativo := coalesce(case when p_dados ? 'ativo' then (p_dados ->> 'ativo')::boolean end, c.ativo, true);
  n.um_por_vez := coalesce(case when p_dados ? 'um_por_vez' then (p_dados ->> 'um_por_vez')::boolean end, c.um_por_vez, false);
  if p_dados ? 'mensagem_inativo' then n.mensagem_inativo := nullif(left(btrim(p_dados ->> 'mensagem_inativo'), 600), ''); end if;
  if p_dados ? 'aviso' then n.aviso := nullif(left(btrim(p_dados ->> 'aviso'), 600), ''); end if;
  if p_dados ? 'msg_varios' then n.msg_varios := nullif(left(btrim(p_dados ->> 'msg_varios'), 600), ''); end if;
  if p_dados ? 'motivo' then n.motivo := nullif(left(btrim(p_dados ->> 'motivo'), 200), ''); end if;
  n.atualizado_em := now(); n.atualizado_por := v_uid;
  insert into public.convenio_config (operadora, ativo, mensagem_inativo, aviso, um_por_vez, msg_varios, motivo, atualizado_em, atualizado_por)
    values (n.operadora, n.ativo, n.mensagem_inativo, n.aviso, n.um_por_vez, n.msg_varios, n.motivo, n.atualizado_em, n.atualizado_por)
    on conflict (operadora) do update set ativo = excluded.ativo, mensagem_inativo = excluded.mensagem_inativo, aviso = excluded.aviso, um_por_vez = excluded.um_por_vez,
      msg_varios = excluded.msg_varios, motivo = excluded.motivo, atualizado_em = excluded.atualizado_em, atualizado_por = excluded.atualizado_por;
  -- Registro do que mudou (já nasce como visto: quem mudou sabe).
  if coalesce(c.ativo, true) is distinct from n.ativo then
    insert into public.convenio_evento (operadora, tipo, descricao, antes, depois, relevante, origem, visto_em, visto_por)
      values (v_ch, case when n.ativo then 'ativado' else 'desativado' end, v_nome || (case when n.ativo then ' foi ativado' else ' foi desativado' end) || coalesce(' (' || n.motivo || ')', ''),
              case when coalesce(c.ativo, true) then 'ativo' else 'desativado' end, case when n.ativo then 'ativo' else 'desativado' end, true, 'painel', now(), v_uid);
  end if;
  if coalesce(c.um_por_vez, false) is distinct from n.um_por_vez then
    insert into public.convenio_evento (operadora, tipo, descricao, antes, depois, origem, visto_em, visto_por)
      values (v_ch, 'regra', v_nome || (case when n.um_por_vez then ': passou a fazer um exame por vez' else ': deixou de limitar a um exame por vez' end),
              case when coalesce(c.um_por_vez, false) then 'um por vez' else 'sem limite' end, case when n.um_por_vez then 'um por vez' else 'sem limite' end, 'painel', now(), v_uid);
  end if;
  if (coalesce(c.mensagem_inativo, '') is distinct from coalesce(n.mensagem_inativo, '')) or (coalesce(c.aviso, '') is distinct from coalesce(n.aviso, '')) or (coalesce(c.msg_varios, '') is distinct from coalesce(n.msg_varios, '')) then
    insert into public.convenio_evento (operadora, tipo, descricao, origem, visto_em, visto_por) values (v_ch, 'mensagem', v_nome || ': mensagem alterada', 'painel', now(), v_uid);
  end if;
  select count(*) into v_em from public.pre_agendamentos where public.convenio_chave(plano) = v_ch and status = 'rascunho';
  select d.ult_30d into v_30 from public.convenio_demanda() d where d.chave = v_ch;
  return jsonb_build_object('ok', true, 'operadora', v_nome, 'ativo', n.ativo, 'um_por_vez', n.um_por_vez, 'em_andamento', v_em, 'agendamentos_30d', coalesce(v_30, 0));
end $$;

create or replace function public.convenio_eventos(p_limite integer default 100, p_so_novos boolean default false) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(q) order by q.criado_em desc, q.id desc) from (
    select e.id, e.criado_em, e.operadora, e.tipo, e.descricao, e.antes, e.depois, e.variacao_pct, e.relevante, e.origem, (e.visto_em is null) as novo
    from public.convenio_evento e where (not p_so_novos or e.visto_em is null) order by e.criado_em desc, e.id desc limit greatest(1, least(coalesce(p_limite, 100), 500))) q), '[]'::jsonb);
end $$;

create or replace function public.convenio_eventos_visto(p_operadora text default null) returns integer
language plpgsql security definer set search_path to '' as $$
declare n int;
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  update public.convenio_evento set visto_em = now(), visto_por = (select auth.uid())
   where visto_em is null and (p_operadora is null or operadora = public.convenio_chave(p_operadora));
  get diagnostics n = row_count;
  return n;
end $$;

-- Contagem barata para o selo da aba (só administrador; para os demais devolve zero).
create or replace function public.convenio_aviso_contagem() returns jsonb
language sql stable security definer set search_path to '' as $$
  select case when (select public.papel_atual()) = 'admin'
    then jsonb_build_object('novos', (select count(*) from public.convenio_evento where visto_em is null), 'relevantes', (select count(*) from public.convenio_evento where visto_em is null and relevante))
    else jsonb_build_object('novos', 0, 'relevantes', 0) end
$$;

-- Convênios desativados e com regra (o atendente vê o aviso quando o paciente escolheu o convênio antes de ele ser desativado).
create or replace function public.convenio_inativos() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('chave', c.operadora, 'ativo', c.ativo, 'um_por_vez', c.um_por_vez, 'motivo', c.motivo)) from public.convenio_config c where not c.ativo or c.um_por_vez), '[]'::jsonb);
end $$;

revoke all on function public.convenios_painel() from public, anon;
revoke all on function public.convenio_detalhe(text, integer) from public, anon;
revoke all on function public.convenio_salvar(text, jsonb) from public, anon;
revoke all on function public.convenio_eventos(integer, boolean) from public, anon;
revoke all on function public.convenio_eventos_visto(text) from public, anon;
revoke all on function public.convenio_aviso_contagem() from public, anon;
revoke all on function public.convenio_inativos() from public, anon;
grant execute on function public.convenios_painel() to authenticated;
grant execute on function public.convenio_detalhe(text, integer) to authenticated;
grant execute on function public.convenio_salvar(text, jsonb) to authenticated;
grant execute on function public.convenio_eventos(integer, boolean) to authenticated;
grant execute on function public.convenio_eventos_visto(text) to authenticated;
grant execute on function public.convenio_aviso_contagem() to authenticated;
grant execute on function public.convenio_inativos() to authenticated;

-- 9. Aviso de mudança: a sincronização noturna grava em catalogo_mudanca; daqui nasce o aviso do painel.
-- Preço de convênio ou Particular alterado, novo ou removido, e plano novo ou removido. Variação de 10% ou mais (ou preço que some) é "relevante".
create or replace function public.convenio_evento_catalogo_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v_op text; v_tipo text; v_ant numeric; v_dep numeric; v_var numeric; v_rel boolean := false; v_part boolean;
begin
  if new.tipo not in ('preco', 'plano') then return new; end if;
  v_op := public.convenio_chave(coalesce(nullif(split_part(coalesce(new.descricao, ''), ' · ', 1), ''), split_part(coalesce(new.chave, ''), '|', 1)));
  if v_op = '' then return new; end if;
  v_part := v_op ~ '^PARTICULAR';
  -- O Particular é derivado das marcações: "novo" e "removido" são ruído; só a alteração de valor interessa.
  if v_part and (new.tipo <> 'preco' or new.evento <> 'alterado') then return new; end if;
  if new.tipo = 'plano' then
    v_tipo := case new.evento when 'novo' then 'plano_novo' when 'removido' then 'plano_removido' when 'reativado' then 'plano_novo' else 'plano_alterado' end;
    v_rel := new.evento in ('removido');
  else
    v_tipo := (case when v_part then 'preco_particular' else 'preco_convenio' end);
    if new.evento = 'alterado' and new.antes ~ '^-?\d+(\.\d+)?$' and new.depois ~ '^-?\d+(\.\d+)?$' then
      v_ant := new.antes::numeric; v_dep := new.depois::numeric;
      if v_ant <> 0 then v_var := round((v_dep - v_ant) * 100 / v_ant, 1); v_rel := abs(v_var) >= 10; end if;
    elsif new.evento in ('removido', 'novo') then v_rel := new.evento = 'removido';
    end if;
  end if;
  insert into public.convenio_evento (operadora, tipo, descricao, antes, depois, variacao_pct, relevante, origem)
    values (v_op, v_tipo, coalesce(new.descricao, new.chave, '') || case new.evento when 'novo' then ' (novo)' when 'removido' then ' (removido)' when 'reativado' then ' (voltou)' else '' end,
            new.antes, new.depois, v_var, v_rel, 'catalogo');
  return new;
end $$;
revoke all on function public.convenio_evento_catalogo_trg() from public, anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'convenio_evento_catalogo' and tgrelid = 'public.catalogo_mudanca'::regclass) then
    create trigger convenio_evento_catalogo after insert on public.catalogo_mudanca for each row execute function public.convenio_evento_catalogo_trg();
  end if;
end $$;

-- Os últimos 7 dias de mudança de preço entram uma vez só, para a gestão já ver o que mudou (não duplica se o arquivo for aplicado de novo).
insert into public.convenio_evento (criado_em, operadora, tipo, descricao, antes, depois, variacao_pct, relevante, origem)
select m.detectada_em, public.convenio_chave(coalesce(nullif(split_part(coalesce(m.descricao, ''), ' · ', 1), ''), split_part(m.chave, '|', 1))),
       case when m.chave like 'particular|%' then 'preco_particular' else 'preco_convenio' end,
       coalesce(m.descricao, m.chave) || case m.evento when 'novo' then ' (novo)' when 'removido' then ' (removido)' else '' end,
       m.antes, m.depois,
       case when m.evento = 'alterado' and m.antes ~ '^-?\d+(\.\d+)?$' and m.depois ~ '^-?\d+(\.\d+)?$' and m.antes::numeric <> 0 then round((m.depois::numeric - m.antes::numeric) * 100 / m.antes::numeric, 1) end,
       (m.evento = 'removido' and m.chave not like 'particular|%') or (m.evento = 'alterado' and m.antes ~ '^-?\d+(\.\d+)?$' and m.depois ~ '^-?\d+(\.\d+)?$' and m.antes::numeric <> 0
         and abs((m.depois::numeric - m.antes::numeric) * 100 / m.antes::numeric) >= 10),
       'catalogo'
  from public.catalogo_mudanca m
 where m.tipo = 'preco' and m.detectada_em >= now() - interval '7 days'
   and (m.chave not like 'particular|%' or m.evento = 'alterado')
   and not exists (select 1 from public.convenio_evento);
