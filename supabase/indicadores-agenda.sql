-- FLUXOGRAMA: Indicadores "a história da agenda" -> pega todas as marcações do Klingo (relatório #14359, tabela jornada_exame) cujo exame/consulta cai no período
--   -> conta, na ordem em que as coisas acontecem: agendados > saíram (cancelados e remarcados) > ficaram na agenda > confirmaram > vieram (atendidos) > faltaram
--   -> repete por dia, por consulta/exame e por unidade; mostra "hoje" e os próximos 3 dias; mostra por onde as marcações novas entram (origem no Klingo) e quantas pessoas do chat têm marcação no Klingo
-- Versão 1.0 — 17/11/2026 / Mudança: `ind_agenda_periodo` (interna, só servidor) e `painel_indicadores_agenda` (admin e atendente), aplicadas como `indicadores_agenda_parte1..5`. Só números, nenhum dado de paciente. Conversas de teste ficam fora, como nos outros indicadores.
-- Regras (conferidas com os dados reais em 17/11/2026, ver docs/auditoria-indicadores-2026-11-17.md):
--   * "Agendados" = toda marcação do Klingo com data de exame no período (a remarcação aparece no Klingo como "Cancelada" com motivo "Remarcad…": aqui fica separada dos cancelamentos).
--   * "Ficaram na agenda" = agendados - cancelados - remarcados.
--   * "Confirmaram" = ficaram com "Confirm Status" = Confirmado no Klingo (vale para dia passado também: o status do exame muda para atendido/faltou, mas a confirmação fica).
--   * "Vieram (atendidos)" = Atendido = S no Klingo. "Faltaram" = dia já passou e o Klingo não marcou atendimento (não existe campo "faltou" no Klingo; é regra do sistema).
--   * "Aguardando fechamento" = dia já passou mas a marcação ainda aparece aberta (a leitura do Klingo não voltou a ela). Fica separada para não virar falta falsa.
--   * "Chegaram (check-in)" só existe desde 16/11/2026 (o Klingo só passou a informar a chegada nessa data); `checkin_desde` diz desde quando.
-- Rollback: drop function public.painel_indicadores_agenda(date, date, text, boolean); drop function public.ind_agenda_periodo(date, date, text, boolean);

-- public.ind_agenda_periodo(p_de date, p_ate date, p_un text, p_teste boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ind_agenda_periodo(p_de date, p_ate date, p_un text, p_teste boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v jsonb;
begin
  with
  teste_m as (select 'm' || z.m as m from public.klingo_conferencia z join public.conversas c on c.id = z.conversa_id where c.teste),
  ex as (
    select e.marcacao_id,
           (e.agendado_para at time zone 'America/Sao_Paulo')::date as dia,
           case when e.procedimento ~* '^consulta' then 'consulta' else 'exame' end as tipo,
           coalesce(public.unidade_chave(e.unidade), 'sem') as un,
           (coalesce(e.confirm_status, '') ilike 'confirmad%') as conf,
           (e.checkin_em is not null and (e.checkin_em at time zone 'America/Sao_Paulo')::date = (e.agendado_para at time zone 'America/Sao_Paulo')::date) as chegou,
           case e.status when 'remarcado' then 'remarcada' when 'cancelado' then 'cancelada' when 'atendido' then 'atendida' when 'faltou' then 'faltou'
                else case when (e.agendado_para at time zone 'America/Sao_Paulo')::date >= v_hoje then 'por_vir' else 'sem_fechamento' end end as r
      from public.jornada_exame e
     where e.status <> 'pedido'
       and (p_teste or e.marcacao_id not in (select m from teste_m))
       and (p_un is null or public.unidade_chave(e.unidade) is null or public.unidade_chave(e.unidade) = p_un)),
  base as (select * from ex where dia between p_de and p_ate),
  ag as (
    select g.grp, g.chave,
           count(*) as agendados,
           count(*) filter (where b.r = 'cancelada') as canceladas,
           count(*) filter (where b.r = 'remarcada') as remarcadas,
           count(*) filter (where b.r not in ('cancelada', 'remarcada')) as ficaram,
           count(*) filter (where b.r not in ('cancelada', 'remarcada') and b.conf) as confirmaram,
           count(*) filter (where b.r = 'atendida') as atendidas,
           count(*) filter (where b.r = 'faltou') as faltaram,
           count(*) filter (where b.r = 'por_vir') as por_vir,
           count(*) filter (where b.r = 'sem_fechamento') as sem_fechamento,
           count(*) filter (where b.r not in ('cancelada', 'remarcada') and b.chegou) as chegaram,
           count(*) filter (where b.r = 'atendida' and b.conf) as conf_atendidas,
           count(*) filter (where b.r = 'faltou' and b.conf) as conf_faltaram,
           count(*) filter (where b.r = 'atendida' and not b.conf) as nconf_atendidas,
           count(*) filter (where b.r = 'faltou' and not b.conf) as nconf_faltaram
      from base b cross join lateral (values ('total', 'todos'), ('tipo', b.tipo), ('un', b.un), ('dia', b.dia::text)) g(grp, chave)
     group by g.grp, g.chave),
  lin as (select grp, chave, to_jsonb(ag) - 'grp' - 'chave' as o from ag),
  hoje as (select count(*) filter (where r not in ('cancelada', 'remarcada')) as ficaram, count(*) filter (where r not in ('cancelada', 'remarcada') and conf) as confirmaram,
                  count(*) filter (where r not in ('cancelada', 'remarcada') and chegou) as chegaram, count(*) filter (where r = 'atendida') as atendidas,
                  count(*) filter (where r in ('cancelada', 'remarcada')) as saiu, count(*) as agendados
             from ex where dia = v_hoje),
  prox as (select dia, count(*) filter (where r not in ('cancelada', 'remarcada')) as ficaram, count(*) filter (where r not in ('cancelada', 'remarcada') and conf) as confirmaram
             from ex where dia > v_hoje and dia <= v_hoje + 3 group by dia),
  nov as (select coalesce(nullif(k.origem, ''), 'sem_origem') as origem, count(*) as total, count(*) filter (where k.status_klingo <> 'Cancelada') as ativas, count(*) filter (where k.ligacao is not null) as do_chat
            from public.klingo_conferencia k left join public.conversas c on c.id = k.conversa_id
           where k.marcado_em between p_de and p_ate and (p_teste or c.id is null or not c.teste) and (p_un is null or k.unidade is null or k.unidade = p_un)
           group by 1),
  pu as (select x.conversa_id, x.pessoa from public.painel_conversa_pessoa_un() x where p_un is null or x.chaves is null or cardinality(x.chaves) = 0 or p_un = any (x.chaves)),
  site as (select count(distinct pu.pessoa) filter (where cardinality(coalesce(pa.klingo_marcacoes, '{}')) > 0) as com_marcacao,
                  count(distinct pu.pessoa) filter (where exists (select 1 from unnest(coalesce(pa.klingo_marcacoes, '{}')) u
                                                                    where exists (select 1 from public.klingo_conferencia z where z.m = u::text and z.status_klingo <> 'Cancelada'))) as com_marcacao_ativa
             from public.conversas c join pu on pu.conversa_id = c.id join public.pre_agendamentos pa on pa.conversa_id = c.id
            where (p_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate),
  spd as (select (c.criado_em at time zone 'America/Sao_Paulo')::date as dia, count(distinct pu.pessoa) as pessoas,
                 count(distinct pu.pessoa) filter (where c.motivo_encerramento = 'agendado' or exists (select 1 from public.pre_agendamentos pa where pa.conversa_id = c.id and pa.status = 'agendado')) as agendaram
            from public.conversas c join pu on pu.conversa_id = c.id
           where (p_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate group by 1)
  select jsonb_build_object(
    'total', coalesce((select o from lin where grp = 'total'), jsonb_build_object('agendados', 0, 'canceladas', 0, 'remarcadas', 0, 'ficaram', 0, 'confirmaram', 0, 'atendidas', 0, 'faltaram', 0, 'por_vir', 0, 'sem_fechamento', 0, 'chegaram', 0,
                                                                                    'conf_atendidas', 0, 'conf_faltaram', 0, 'nconf_atendidas', 0, 'nconf_faltaram', 0)),
    'por_tipo', coalesce((select jsonb_object_agg(chave, o) from lin where grp = 'tipo'), '{}'::jsonb),
    'por_unidade', coalesce((select jsonb_object_agg(chave, o) from lin where grp = 'un'), '{}'::jsonb),
    'por_dia', coalesce((select jsonb_agg(o || jsonb_build_object('dia', chave) order by chave) from lin where grp = 'dia'), '[]'::jsonb),
    'hoje', (select to_jsonb(hoje) from hoje),
    'proximos', coalesce((select jsonb_agg(jsonb_build_object('dia', dia, 'ficaram', ficaram, 'confirmaram', confirmaram) order by dia) from prox), '[]'::jsonb),
    'novas_por_origem', coalesce((select jsonb_agg(jsonb_build_object('origem', origem, 'total', total, 'ativas', ativas, 'do_chat', do_chat) order by total desc) from nov), '[]'::jsonb),
    'site', (select to_jsonb(site) from site),
    'site_por_dia', coalesce((select jsonb_agg(jsonb_build_object('dia', dia, 'pessoas', pessoas, 'agendaram', agendaram) order by dia) from spd), '[]'::jsonb),
    'dados_desde', (select min((agendado_para at time zone 'America/Sao_Paulo')::date) from public.jornada_exame where status <> 'pedido'),
    'checkin_desde', (select min((checkin_em at time zone 'America/Sao_Paulo')::date) from public.jornada_exame where checkin_em is not null and (checkin_em at time zone 'America/Sao_Paulo')::date = (agendado_para at time zone 'America/Sao_Paulo')::date)
  ) into v;
  return v;
end $function$;

-- public.painel_indicadores_agenda(p_de date, p_ate date, p_unidade text, p_incluir_teste boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_indicadores_agenda(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_len integer;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje);
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;
  v_len := v_ate - v_de + 1;
  return jsonb_build_object('periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'anterior_periodo', jsonb_build_object('de', v_de - v_len, 'ate', v_de - 1),
    'unidade', v_un, 'gerado_em', now(),
    'atual', public.ind_agenda_periodo(v_de, v_ate, v_un, coalesce(p_incluir_teste, false)),
    'anterior', public.ind_agenda_periodo(v_de - v_len, v_de - 1, v_un, coalesce(p_incluir_teste, false)));
end $function$;

-- Permissões (aplicadas em parte4): a interna só o servidor; a pública só quem está logado.
-- revoke all on function public.ind_agenda_periodo(date,date,text,boolean) from public, anon, authenticated; grant execute on function public.ind_agenda_periodo(date,date,text,boolean) to service_role;
-- revoke all on function public.painel_indicadores_agenda(date,date,text,boolean) from public, anon; grant execute on function public.painel_indicadores_agenda(date,date,text,boolean) to authenticated, service_role;
