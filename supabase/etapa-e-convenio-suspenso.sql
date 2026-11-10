-- FLUXOGRAMA: entrada (gerência/TI suspende um convênio com motivo; a rotina diária olha os suspensos) -> validação (só TI e gerência; Particular nunca suspende; nada é gravado no Klingo) -> lógica (suspenso = o paciente NÃO consegue escolher o convênio e recebe um aviso de "temporariamente suspenso por decisão administrativa" com a oferta de outro; vale 1 mês para REVISAR: passado o prazo vira aviso no sino da gestão e NÃO reativa sozinho; reativar e renovar são ações da gestão) -> saída (colunas novas em convenio_config, convenio_ativo e convenio_msg atualizadas, convenio_suspender/reativar/renovar, convenios_suspensos, convenios_revisar + rotina diária)
-- Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (CAT-01; Q-17 e C-12 do planejamento de 10/11/2026).
-- Pré-requisitos: convenios-e-foto.sql (convenio_config, convenio_chave, convenio_ativo, convenio_msg), etapa-b-estrutura.sql (org_nivel), c1-reentrada.sql (equipe_notificacao). Aditivo.
-- LIMITE CONHECIDO: o convênio suspenso some da lista do chat e é recusado se o paciente digitar o nome (com o aviso próprio). A lista "esmaecida com o aviso entre parênteses" ainda NÃO existe: exige mexer no gerador de opções do motor e no chat.
-- DESLIGAR: select public.convenio_reativar('NOME DO CONVENIO');  ou  update public.convenio_config set suspenso_em = null, suspenso_ate = null where suspenso_em is not null;
-- ROLLBACK: reaplicar convenio_ativo e convenio_msg de convenios-e-foto.sql; select cron.unschedule('convenios-revisar'); (as colunas podem ficar)

alter table public.convenio_config add column if not exists suspenso_em timestamptz;
alter table public.convenio_config add column if not exists suspenso_ate timestamptz;
alter table public.convenio_config add column if not exists suspenso_por uuid;
alter table public.convenio_config add column if not exists suspenso_motivo text;
alter table public.convenio_config add column if not exists revisao_avisada_em timestamptz;
insert into public.config (chave, valor) values ('convenio_suspenso_texto', 'O convênio {convenio} está temporariamente suspenso por decisão administrativa. Posso te ajudar a escolher outro convênio ou o atendimento particular?') on conflict (chave) do nothing;

create or replace function public.convenio_ativo(p_operadora text) returns boolean
language sql stable security definer set search_path to '' as $$
  select case when public.convenio_chave(p_operadora) ~ '^(|PARTICULAR.*)$' then true
    else coalesce((select c.ativo and c.suspenso_em is null from public.convenio_config c where c.operadora = public.convenio_chave(p_operadora)), true) end
$$;

create or replace function public.convenio_msg(p_operadora text, p_tipo text) returns text
language plpgsql stable security definer set search_path to '' as $$
declare c public.convenio_config; t text;
begin
  select * into c from public.convenio_config where operadora = public.convenio_chave(p_operadora);
  t := case p_tipo
    when 'inativo' then case when c.suspenso_em is not null then (select valor from public.config where chave = 'convenio_suspenso_texto')
                             else coalesce(nullif(btrim(c.mensagem_inativo), ''), public.fluxo_t('convenio_inativo')) end
    when 'varios' then coalesce(nullif(btrim(c.msg_varios), ''), public.fluxo_t('convenio_varios'))
    when 'aviso' then nullif(btrim(c.aviso), '')
  end;
  if t is null then return null; end if;
  return replace(t, '{convenio}', initcap(lower(btrim(p_operadora))));
end $$;

create or replace function public.convenio_suspender(p_operadora text, p_motivo text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_ch text := public.convenio_chave(p_operadora); v_ate timestamptz := now() + interval '1 month'; v_mot text := nullif(left(btrim(coalesce(p_motivo, '')), 300), '');
begin
  if coalesce(public.org_nivel(), '') not in ('ti', 'gerente') then raise exception 'Somente TI e gerência suspendem convênios.' using errcode = '42501'; end if;
  if v_ch ~ '^(|PARTICULAR.*)$' then raise exception 'O atendimento particular não pode ser suspenso.' using errcode = '22023'; end if;
  insert into public.convenio_config (operadora, ativo, suspenso_em, suspenso_ate, suspenso_por, suspenso_motivo, revisao_avisada_em)
  values (v_ch, true, now(), v_ate, (select auth.uid()), v_mot, null)
  on conflict (operadora) do update set suspenso_em = now(), suspenso_ate = v_ate, suspenso_por = (select auth.uid()), suspenso_motivo = v_mot, revisao_avisada_em = null;
  insert into public.org_alteracao_log (por, acao, alvo, depois) values ((select auth.uid()), 'convenio_suspenso', 'convenio:' || v_ch, jsonb_build_object('motivo', v_mot, 'revisar_em', v_ate));
  return jsonb_build_object('ok', true, 'operadora', v_ch, 'revisar_em', v_ate);
end $$;
revoke all on function public.convenio_suspender(text, text) from public, anon;
grant execute on function public.convenio_suspender(text, text) to authenticated;

create or replace function public.convenio_reativar(p_operadora text) returns boolean
language plpgsql security definer set search_path to '' as $$
declare v_ch text := public.convenio_chave(p_operadora); v_n integer;
begin
  if coalesce(public.org_nivel(), '') not in ('ti', 'gerente') and current_user <> 'postgres' then raise exception 'Somente TI e gerência reativam convênios.' using errcode = '42501'; end if;
  update public.convenio_config set suspenso_em = null, suspenso_ate = null, suspenso_por = null, suspenso_motivo = null, revisao_avisada_em = null where operadora = v_ch and suspenso_em is not null;
  get diagnostics v_n = row_count;
  if v_n > 0 then insert into public.org_alteracao_log (por, acao, alvo) values ((select auth.uid()), 'convenio_reativado', 'convenio:' || v_ch); end if;
  return v_n > 0;
end $$;
revoke all on function public.convenio_reativar(text) from public, anon;
grant execute on function public.convenio_reativar(text) to authenticated;

create or replace function public.convenio_renovar(p_operadora text) returns timestamptz
language plpgsql security definer set search_path to '' as $$
declare v_ch text := public.convenio_chave(p_operadora); v_ate timestamptz := now() + interval '1 month'; v_n integer;
begin
  if coalesce(public.org_nivel(), '') not in ('ti', 'gerente') then raise exception 'Somente TI e gerência renovam a suspensão.' using errcode = '42501'; end if;
  update public.convenio_config set suspenso_ate = v_ate, revisao_avisada_em = null where operadora = v_ch and suspenso_em is not null;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'Este convênio não está suspenso.' using errcode = '22023'; end if;
  insert into public.org_alteracao_log (por, acao, alvo, depois) values ((select auth.uid()), 'convenio_suspensao_renovada', 'convenio:' || v_ch, jsonb_build_object('revisar_em', v_ate));
  return v_ate;
end $$;
revoke all on function public.convenio_renovar(text) from public, anon;
grant execute on function public.convenio_renovar(text) to authenticated;

create or replace function public.convenios_suspensos() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce(public.org_nivel(), '') not in ('ti', 'gerente') then raise exception 'Somente TI e gerência.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('operadora', c.operadora, 'motivo', c.suspenso_motivo, 'suspenso_em', c.suspenso_em, 'revisar_em', c.suspenso_ate,
            'revisar_agora', c.suspenso_ate <= now(), 'por', (select a.nome from public.agentes a where a.id = c.suspenso_por)) order by c.suspenso_em)
          from public.convenio_config c where c.suspenso_em is not null), '[]'::jsonb);
end $$;
revoke all on function public.convenios_suspensos() from public, anon;
grant execute on function public.convenios_suspensos() to authenticated;

-- Rotina diária: passou 1 mês -> aviso de revisão no sino de TI/gerência (uma vez por suspensão). NÃO reativa sozinho.
create or replace function public.convenios_revisar() returns integer
language plpgsql security definer set search_path to '' as $$
declare r record; v_n integer := 0;
begin
  for r in select operadora, suspenso_motivo from public.convenio_config where suspenso_em is not null and suspenso_ate <= now() and revisao_avisada_em is null loop
    insert into public.equipe_notificacao (agente_id, tipo, detalhe)
    select distinct x.id, 'convenio_revisar', jsonb_build_object('convenio', r.operadora, 'motivo', r.suspenso_motivo, 'aviso', 'A suspensão deste convênio completou 1 mês: reative, renove ou mantenha.')
      from (select a.id from public.agentes a where a.ativo and a.papel = 'admin'
            union select m.agente_id from public.org_membro m where m.ativo and m.funcao in ('ti', 'gerente') and m.agente_id is not null) x;
    update public.convenio_config set revisao_avisada_em = now() where operadora = r.operadora;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.convenios_revisar() from public, anon, authenticated;
grant execute on function public.convenios_revisar() to service_role;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and not exists (select 1 from cron.job where jobname = 'convenios-revisar') then
    perform cron.schedule('convenios-revisar', '5 11 * * *', 'select public.convenios_revisar()');
  end if;
end $$;
