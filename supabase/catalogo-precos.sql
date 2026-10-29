-- Fase 1: preços, demanda e lista de limpeza. JÁ APLICADO no projeto webchat-atendimento (29/10/2026).
-- Fontes (relatórios do Klingo lidos pela API, sem dado de paciente guardado):
--   convênio:   #13983 pedido por operadora (filtro :parm0 = id da operadora; ids 1 a 60, os que não existem voltam vazios)
--   Particular: #13825 (marcações) dos últimos 90 dias, só o valor das marcações abertas de Particular, agregado por procedimento
--   demanda:    contagem de marcações abertas por procedimento nos últimos 90 dias (catalogo_procedimento.demanda_90d)
-- Confiança:
--   convênio  alta = tabela que não é CBHPM e valor >= 10 (CBHPM guarda coeficiente/porte, não R$); baixa = o resto (a IA não usa)
--   Particular alta = valor mais recente repetido em 2+ marcações e nunca variou; média = repetido mas já variou; baixa = 1 marcação (a IA não usa)

create table if not exists public.catalogo_preco (
  id bigint generated always as identity primary key,
  chave text not null unique,
  fonte text not null check (fonte in ('convenio','particular')),
  operadora_id integer, operadora text,
  tabela_id integer, tabela text,
  procedimento_id integer not null, procedimento text,
  item_codigo text, item_descricao text,
  valor numeric(12,2), moeda text,
  amostras integer, valor_min numeric(12,2), valor_max numeric(12,2), ultima_marcacao date,
  confianca text check (confianca in ('alta','media','baixa')),
  status text not null default 'ativo' check (status in ('ativo','removido')),
  vigente_desde timestamptz not null default now(),
  visto_em timestamptz not null default now(),
  removido_em timestamptz
);
create index if not exists catalogo_preco_proc on public.catalogo_preco (procedimento_id) where status = 'ativo';
create index if not exists catalogo_preco_operadora on public.catalogo_preco (operadora_id) where fonte = 'convenio';
comment on table public.catalogo_preco is 'Preço por procedimento. convenio: relatório Klingo 13983 (por operadora e tabela). particular: valor das marcações recentes do relatório 13825, só agregado (sem dado de paciente). A IA só usa status ativo e confiança alta/média; valor é referência, o atendente confirma.';
alter table public.catalogo_preco enable row level security;

create or replace function public.catalogo_preco_confianca_trg()
returns trigger language plpgsql set search_path to '' as $$
begin
  if new.fonte = 'convenio' then
    new.confianca := case when coalesce(new.tabela, '') !~* 'cbhpm' and new.valor >= 10 then 'alta' else 'baixa' end;
  end if;
  return new;
end $$;
create or replace trigger catalogo_preco_confianca before insert or update on public.catalogo_preco
  for each row execute function public.catalogo_preco_confianca_trg();

-- Preços de UMA operadora (convênio), comparando com o que já existe. Primeira carga = uma linha-resumo em catalogo_mudanca.
create or replace function public.catalogo_preco_sincronizar(p_operadora_id integer, p_linhas jsonb, p_forcar boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_lote uuid := gen_random_uuid();
  v_antes integer; v_novas integer; v_total integer; v_primeira boolean; v_nome text;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' or jsonb_array_length(p_linhas) = 0 then
    raise exception 'Preços vazios: nada foi alterado.';
  end if;
  perform pg_advisory_xact_lock(hashtext('catalogo_preco:' || p_operadora_id));
  create temp table _pstg on commit drop as
    select distinct on (q.chave) q.* from (
      select x.*, 'convenio|' || x.operadora_id || '|' || coalesce(x.tabela_id, 0) || '|' || x.procedimento_id || '|' || coalesce(x.item_codigo, '') as chave
      from jsonb_to_recordset(p_linhas) as x(operadora_id int, operadora text, tabela_id int, tabela text, procedimento_id int,
        procedimento text, item_codigo text, item_descricao text, valor numeric, moeda text)
      where x.operadora_id = p_operadora_id and x.procedimento_id is not null and x.valor is not null) q
    order by q.chave;
  select count(*) into v_novas from pg_temp._pstg;
  select min(operadora) into v_nome from pg_temp._pstg;
  select count(*) into v_antes from public.catalogo_preco where fonte = 'convenio' and operadora_id = p_operadora_id and status = 'ativo';
  select not exists (select 1 from public.catalogo_preco where fonte = 'convenio' and operadora_id = p_operadora_id) into v_primeira;
  if v_novas = 0 then raise exception 'Nenhum preço válido para a operadora %: nada foi alterado.', p_operadora_id; end if;
  if not p_forcar and v_antes > 0 and v_novas < v_antes * 0.5 then
    raise exception 'Operadora % veio com % preços (hoje há % ativos): menos da metade, nada foi alterado.', p_operadora_id, v_novas, v_antes;
  end if;

  if v_primeira then
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      values (v_lote, 'preco', 'novo', 'operadora ' || p_operadora_id, v_nome || ': ' || v_novas || ' preços carregados (primeira carga)');
  else
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'preco', case when p.status = 'removido' then 'reativado' else 'novo' end, s.chave, s.operadora || ' · ' || coalesce(s.tabela, '') || ' · ' || coalesce(s.procedimento, '')
      from pg_temp._pstg s left join public.catalogo_preco p on p.chave = s.chave where p.id is null or p.status = 'removido';
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao, campo, antes, depois)
      select v_lote, 'preco', 'alterado', s.chave, s.operadora || ' · ' || coalesce(s.tabela, '') || ' · ' || coalesce(s.procedimento, ''), 'valor', p.valor::text, s.valor::text
      from pg_temp._pstg s join public.catalogo_preco p on p.chave = s.chave where p.status = 'ativo' and p.valor is distinct from s.valor;
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'preco', 'removido', p.chave, p.operadora || ' · ' || coalesce(p.tabela, '') || ' · ' || coalesce(p.procedimento, '')
      from public.catalogo_preco p where p.fonte = 'convenio' and p.operadora_id = p_operadora_id and p.status = 'ativo'
        and not exists (select 1 from pg_temp._pstg s where s.chave = p.chave);
  end if;

  update public.catalogo_preco p set
    vigente_desde = case when p.status = 'ativo' and p.valor is not distinct from s.valor then p.vigente_desde else now() end,
    valor = s.valor, moeda = s.moeda, operadora = s.operadora, tabela = s.tabela, procedimento = s.procedimento, item_descricao = s.item_descricao,
    status = 'ativo', removido_em = null, visto_em = now()
  from pg_temp._pstg s where s.chave = p.chave;
  insert into public.catalogo_preco (chave, fonte, operadora_id, operadora, tabela_id, tabela, procedimento_id, procedimento, item_codigo, item_descricao, valor, moeda)
    select s.chave, 'convenio', s.operadora_id, s.operadora, s.tabela_id, s.tabela, s.procedimento_id, s.procedimento, s.item_codigo, s.item_descricao, s.valor, s.moeda
    from pg_temp._pstg s where not exists (select 1 from public.catalogo_preco p where p.chave = s.chave);
  update public.catalogo_preco p set status = 'removido', removido_em = now()
    where p.fonte = 'convenio' and p.operadora_id = p_operadora_id and p.status = 'ativo' and not exists (select 1 from pg_temp._pstg s where s.chave = p.chave);
  select count(*) into v_total from public.catalogo_preco where fonte = 'convenio' and operadora_id = p_operadora_id and status = 'ativo';

  return jsonb_build_object('operadora_id', p_operadora_id, 'operadora', v_nome, 'antes', v_antes, 'recebidos', v_novas, 'ativos_agora', v_total, 'primeira_carga', v_primeira,
    'mudancas', coalesce((select jsonb_object_agg(evento, n) from (select evento, count(*) n from public.catalogo_mudanca where lote = v_lote group by evento) m), '{}'::jsonb));
end $$;
revoke all on function public.catalogo_preco_sincronizar(integer, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.catalogo_preco_sincronizar(integer, jsonb, boolean) to service_role;

-- Preço Particular (já agregado por procedimento pela Edge Function) e demanda dos últimos 90 dias.
-- Casa os procedimentos pelo nome (sem acento, maiúsculas, espaços únicos); os que não casam voltam em sem_correspondencia_exemplos.
create or replace function public.catalogo_preco_particular_sincronizar(p_linhas jsonb, p_demanda jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_lote uuid := gen_random_uuid();
  v_recebidas integer; v_casadas integer; v_primeira boolean; v_sem jsonb; v_dem integer;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then raise exception 'Formato inválido.'; end if;
  perform pg_advisory_xact_lock(hashtext('catalogo_preco_particular'));
  create temp table _nome on commit drop as
    select distinct on (n) n, id from (select upper(extensions.unaccent(regexp_replace(trim(nome), '\s+', ' ', 'g'))) n, id from public.catalogo_procedimento where ativo) q order by n, id;
  create temp table _part on commit drop as
    select distinct on (m.id) m.id as procedimento_id, x.procedimento, x.valor, x.amostras, x.valor_min, x.valor_max, x.ultima_marcacao, x.confianca
    from jsonb_to_recordset(p_linhas) as x(procedimento text, valor numeric, amostras int, valor_min numeric, valor_max numeric, ultima_marcacao date, confianca text)
    join pg_temp._nome m on m.n = upper(extensions.unaccent(regexp_replace(trim(x.procedimento), '\s+', ' ', 'g')))
    where x.valor is not null and x.valor > 0
    order by m.id, x.amostras desc;
  select jsonb_array_length(p_linhas) into v_recebidas;
  select count(*) into v_casadas from pg_temp._part;
  select coalesce(jsonb_agg(x.procedimento), '[]'::jsonb) into v_sem from (
    select x.procedimento from jsonb_to_recordset(p_linhas) as x(procedimento text, valor numeric)
    where not exists (select 1 from pg_temp._nome m where m.n = upper(extensions.unaccent(regexp_replace(trim(x.procedimento), '\s+', ' ', 'g')))) limit 25) x;
  select not exists (select 1 from public.catalogo_preco where fonte = 'particular') into v_primeira;
  if v_casadas = 0 and v_recebidas > 0 then raise exception 'Nenhum procedimento do Particular casou com o catálogo: nada foi alterado.'; end if;

  if v_primeira then
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      values (v_lote, 'preco', 'novo', 'particular', v_casadas || ' preços Particular carregados (primeira carga)');
  else
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao, campo, antes, depois)
      select v_lote, 'preco', 'alterado', p.chave, 'PARTICULAR · ' || coalesce(s.procedimento, ''), 'valor', p.valor::text, s.valor::text
      from pg_temp._part s join public.catalogo_preco p on p.chave = 'particular|' || s.procedimento_id where p.status = 'ativo' and p.valor is distinct from s.valor;
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'preco', 'novo', 'particular|' || s.procedimento_id, 'PARTICULAR · ' || coalesce(s.procedimento, '')
      from pg_temp._part s where not exists (select 1 from public.catalogo_preco p where p.chave = 'particular|' || s.procedimento_id and p.status = 'ativo');
    insert into public.catalogo_mudanca (lote, tipo, evento, chave, descricao)
      select v_lote, 'preco', 'removido', p.chave, 'PARTICULAR · ' || coalesce(p.procedimento, '') || ' (sem marcação recente)'
      from public.catalogo_preco p where p.fonte = 'particular' and p.status = 'ativo' and not exists (select 1 from pg_temp._part s where 'particular|' || s.procedimento_id = p.chave);
  end if;

  update public.catalogo_preco p set
    vigente_desde = case when p.status = 'ativo' and p.valor is not distinct from s.valor then p.vigente_desde else now() end,
    valor = s.valor, procedimento = s.procedimento, amostras = s.amostras, valor_min = s.valor_min, valor_max = s.valor_max,
    ultima_marcacao = s.ultima_marcacao, confianca = s.confianca, status = 'ativo', removido_em = null, visto_em = now()
  from pg_temp._part s where p.chave = 'particular|' || s.procedimento_id;
  insert into public.catalogo_preco (chave, fonte, operadora, procedimento_id, procedimento, valor, moeda, amostras, valor_min, valor_max, ultima_marcacao, confianca)
    select 'particular|' || s.procedimento_id, 'particular', 'PARTICULAR', s.procedimento_id, s.procedimento, s.valor, 'R$', s.amostras, s.valor_min, s.valor_max, s.ultima_marcacao, s.confianca
    from pg_temp._part s where not exists (select 1 from public.catalogo_preco p where p.chave = 'particular|' || s.procedimento_id);
  update public.catalogo_preco p set status = 'removido', removido_em = now()
    where p.fonte = 'particular' and p.status = 'ativo' and not exists (select 1 from pg_temp._part s where 'particular|' || s.procedimento_id = p.chave);

  if jsonb_typeof(p_demanda) = 'array' and jsonb_array_length(p_demanda) > 0 then
    create temp table _dem on commit drop as
      select m.id as procedimento_id, sum(x.marcacoes)::int as marcacoes
      from jsonb_to_recordset(p_demanda) as x(procedimento text, marcacoes int)
      join pg_temp._nome m on m.n = upper(extensions.unaccent(regexp_replace(trim(x.procedimento), '\s+', ' ', 'g')))
      group by m.id;
    update public.catalogo_procedimento p set demanda_90d = coalesce(d.marcacoes, 0)
      from public.catalogo_procedimento p2 left join pg_temp._dem d on d.procedimento_id = p2.id where p2.id = p.id;
    select count(*) into v_dem from pg_temp._dem;
  end if;

  return jsonb_build_object('recebidas', v_recebidas, 'casadas', v_casadas, 'primeira_carga', v_primeira, 'procedimentos_com_demanda', coalesce(v_dem, 0), 'sem_correspondencia_exemplos', v_sem);
end $$;
revoke all on function public.catalogo_preco_particular_sincronizar(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.catalogo_preco_particular_sincronizar(jsonb, jsonb) to service_role;

create or replace function public.catalogo_preco_operadoras()
returns table (operadora_id integer, atualizado_em timestamptz) language sql security definer set search_path to '' as $$
  select p.operadora_id, max(p.visto_em) from public.catalogo_preco p where p.fonte = 'convenio' group by p.operadora_id;
$$;
revoke all on function public.catalogo_preco_operadoras() from public, anon, authenticated;
grant execute on function public.catalogo_preco_operadoras() to service_role;

-- Lista do que limpar no cadastro do Klingo (só administrador).
create or replace function public.catalogo_limpeza()
returns jsonb language plpgsql security definer set search_path to '' as $$
begin
  if (select public.papel_atual()) is distinct from 'admin' then
    raise exception 'Somente administrador.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'gerado_em', now(),
    'ativos', (select count(*) from public.catalogo_procedimento where ativo),
    'removidos', (select count(*) from public.catalogo_procedimento where not ativo),
    'sem_agenda_vigente', (
      select jsonb_build_object('total', count(*),
             'exemplos', coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'classe', x.classe) order by x.nome) filter (where x.rn <= 30), '[]'::jsonb))
      from (select p.id, p.nome, p.classe, row_number() over (order by p.nome) rn
            from public.catalogo_procedimento p
            where p.ativo and not exists (select 1 from public.catalogo_agenda a
                     where a.procedimento_id = p.id and a.vig_fim >= current_date and a.profissional !~* 'teste')) x),
    'nomes_duplicados', (
      select coalesce(jsonb_agg(jsonb_build_object('nome', d.nome, 'ids', d.ids)), '[]'::jsonb)
      from (select min(nome) nome, jsonb_agg(id order by id) ids
            from public.catalogo_procedimento where ativo group by upper(trim(nome)) having count(*) > 1) d),
    'agenda_teste', (
      select jsonb_build_object('linhas', count(*), 'profissionais', coalesce(jsonb_agg(distinct profissional), '[]'::jsonb))
      from public.catalogo_agenda where profissional ~* 'teste'),
    'sem_preco_com_agenda', (
      select jsonb_build_object('total', count(*),
             'exemplos', coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'marcacoes_90d', x.demanda_90d) order by x.demanda_90d desc nulls last) filter (where x.rn <= 30), '[]'::jsonb))
      from (select p.id, p.nome, p.demanda_90d, row_number() over (order by p.demanda_90d desc nulls last, p.nome) rn
            from public.catalogo_procedimento p
            where p.ativo
              and exists (select 1 from public.catalogo_agenda a where a.procedimento_id = p.id and a.vig_fim >= current_date and a.profissional !~* 'teste')
              and not exists (select 1 from public.catalogo_preco pr where pr.procedimento_id = p.id and pr.status = 'ativo' and pr.confianca in ('alta','media'))) x),
    'sem_preparo', (select count(*) from public.catalogo_procedimento where ativo and coalesce(preparo, '') = ''),
    'mais_pedidos_sem_preparo', (
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'nome', t.nome, 'marcacoes_90d', t.demanda_90d) order by t.demanda_90d desc), '[]'::jsonb)
      from (select id, nome, demanda_90d from public.catalogo_procedimento where ativo and coalesce(preparo, '') = '' and demanda_90d > 0 order by demanda_90d desc limit 20) t),
    'precos_cbhpm_sem_valor_em_reais', (select count(*) from public.catalogo_preco where fonte = 'convenio' and status = 'ativo' and confianca = 'baixa'),
    'precos_particular_confianca_baixa', (select count(*) from public.catalogo_preco where fonte = 'particular' and status = 'ativo' and confianca = 'baixa'));
end $$;
revoke all on function public.catalogo_limpeza() from public, anon;
grant execute on function public.catalogo_limpeza() to authenticated;

-- Atualização noturna (Brasília = UTC-3): 03:00 base (job sync-catalogo-klingo, já existente), 03:10 convênio, 03:25 Particular e demanda.
-- select cron.schedule('catalogo-precos-convenio', '10 6 * * *', $job$ select net.http_post(url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-catalogo-klingo',
--   headers := jsonb_build_object('Content-Type','application/json','x-sync-key',(select valor from public.config where chave='ia_segredo')),
--   body := '{"precos":"convenio"}'::jsonb, timeout_milliseconds := 150000); $job$);
-- select cron.schedule('catalogo-precos-particular', '25 6 * * *', ... body := '{"precos":"particular"}'::jsonb ...);

-- ia_catalogo (versão vigente: ativos, preços de referência e demanda):
-- A IA só oferece o que está ativo no Klingo, recebe preços de referência (confiança alta/média) e a demanda de cada exame.
create or replace function public.ia_catalogo(p_segredo text, p_conversa uuid)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_seg text; v_txt text; v_palavras text[]; v_q tsquery; v_qp tsquery;
  v_ids int[]; v_procs jsonb; v_agenda jsonb; v_planos jsonb; v_precos jsonb; r jsonb;
  v_ignorar text[] := array['quero','queria','gostaria','preciso','marcar','agendar','agendamento','fazer','realizar','boa','bom','dia','tarde','noite','ola','favor','obrigado','obrigada','pode','poderia','tenho','minha','meu','para','paciente','plano','convenio','particular','valor','filho','filha','exame','exames','horario','horarios','atendimento','agenda','marcacao','saude'];
  v_sin jsonb := jsonb_build_object(
    'rm','ressonancia','rnm','ressonancia','resonancia','ressonancia','ressonancea','ressonancia','ressonancias','ressonancia','resonancias','ressonancia',
    'tc','tomografia','tomo','tomografia','tomografias','tomografia','tomografica','tomografia','tomogafia','tomografia','tumografia','tomografia',
    'us','ultrassonografia','usg','ultrassonografia','ultrassom','ultrassonografia','ultrasom','ultrassonografia','ultrasson','ultrassonografia',
    'ultra','ultrassonografia','ultrasonografia','ultrassonografia','ultrassonografica','ultrassonografia','ecografia','ultrassonografia','ultrassons','ultrassonografia',
    'rx','radiografia','raio','radiografia','raios','radiografia','radiografias','radiografia',
    'mamo','mamografia','dexa','densitometria','eletro','eletrocardiograma','ecg','eletrocardiograma','eco','ecocardiograma');
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if v_seg is null or p_segredo is distinct from v_seg then
    raise exception 'Não autorizado.' using errcode = '28000';
  end if;

  select string_agg(texto, ' ') into v_txt
  from (select texto from public.mensagens where conversa_id = p_conversa and autor = 'cliente' order by id desc limit 4) t;

  select array_agg(distinct x)
  into v_palavras
  from unnest(regexp_split_to_array(lower(extensions.unaccent(coalesce(v_txt, ''))), '[^a-z0-9]+')) w,
       lateral unnest(array[w, coalesce(v_sin ->> w, w)]) x
  where (length(w) >= 4 or v_sin ? w) and not (w = any(v_ignorar));

  r := jsonb_build_object(
    'unidades', (select coalesce(jsonb_agg(u order by u), '[]'::jsonb) from (select distinct unidade u from public.catalogo_agenda where unidade is not null) x),
    'especialidades_com_agenda', (select coalesce(jsonb_agg(e order by e), '[]'::jsonb)
       from (select distinct especialidade e from public.catalogo_agenda where especialidade is not null and vig_fim >= current_date and profissional !~* 'teste') x));

  if v_palavras is null then
    return r || jsonb_build_object('procedimentos', '[]'::jsonb, 'agenda', '[]'::jsonb, 'planos', '[]'::jsonb, 'precos', '[]'::jsonb);
  end if;

  v_q := to_tsquery('portuguese', array_to_string(v_palavras, ' | '));
  v_qp := to_tsquery('simple', array_to_string(v_palavras, ' | '));

  select coalesce(array_agg(id order by rk desc, tam), '{}'::int[]),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'nome', nome, 'especialidade', especialidade, 'classe', classe,
           'idade_min', idade_min, 'idade_max', idade_max, 'sexo', sexo, 'preparo', left(preparo, 1500), 'marcacoes_90d', demanda_90d) order by rk desc, tam), '[]'::jsonb)
  into v_ids, v_procs
  from (select p.id, p.nome, p.especialidade, p.classe, p.idade_min, p.idade_max, p.sexo, p.preparo, p.demanda_90d, length(p.nome) tam,
               (select count(*) from unnest(v_palavras) w where p.busca @@ to_tsquery('portuguese', w)) * 10 + ts_rank_cd(p.busca, v_q) rk
        from public.catalogo_procedimento p where p.ativo and p.busca @@ v_q
        order by rk desc, length(p.nome) limit 8) m;

  select coalesce(jsonb_agg(to_jsonb(g) - 'pos' order by g.pos, g.unidade, g.profissional), '[]'::jsonb) into v_agenda
  from (select d.unidade, d.local, d.profissional, d.procedimento, min(array_position(v_ids, d.procedimento_id)) pos,
               string_agg(d.dia || ' ' || d.hora_ini || '-' || d.hora_fim, '; ' order by d.dia_num, d.hora_ini) as dias
        from (select distinct a.unidade, a.local, a.profissional, a.procedimento, a.procedimento_id, a.dia_num, a.dia, a.hora_ini, a.hora_fim
              from public.catalogo_agenda a
              where a.procedimento_id = any(v_ids) and a.vig_fim >= current_date and a.vig_ini <= current_date + 60
                    and a.profissional !~* 'teste') d
        group by d.unidade, d.local, d.profissional, d.procedimento
        order by min(array_position(v_ids, d.procedimento_id)), d.unidade, d.profissional limit 12) g;

  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) into v_planos
  from (select c.operadora, (array_agg(c.plano order by c.plano))[1:5] as planos
        from public.catalogo_plano c where c.ativo and c.busca @@ v_qp
        group by c.operadora order by max(ts_rank(c.busca, v_qp)) desc limit 6) g;

  -- Preços de referência dos procedimentos candidatos: Particular e as operadoras que o paciente citou.
  -- Só preço com confiança alta ou média; é referência, quem confirma é o atendente.
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) into v_precos
  from (select pr.procedimento_id, pr.procedimento, pr.fonte, pr.operadora, pr.tabela, pr.valor, pr.valor_min, pr.valor_max,
               pr.confianca, pr.ultima_marcacao, pr.vigente_desde::date as vigente_desde
        from public.catalogo_preco pr
        where pr.status = 'ativo' and pr.confianca in ('alta', 'media') and pr.procedimento_id = any(v_ids)
          and (pr.fonte = 'particular'
               or upper(extensions.unaccent(pr.operadora)) in (select upper(extensions.unaccent(x ->> 'operadora')) from jsonb_array_elements(v_planos) x))
        order by array_position(v_ids, pr.procedimento_id), pr.fonte desc, pr.operadora, pr.valor limit 40) g;

  return r || jsonb_build_object('procedimentos', v_procs, 'agenda', v_agenda, 'planos', v_planos, 'precos', v_precos);
end $$;
revoke all on function public.ia_catalogo(text, uuid) from public;
grant execute on function public.ia_catalogo(text, uuid) to anon, authenticated;

