-- FLUXOGRAMA: resumo para a diretoria -> por unidade (chat + marcações), o que mais pedem e planos, com quantos agendaram
-- Versão 1.0 — 17/11/2026 / Mudança: função nova `painel_indicadores_diretoria` (só leitura). Aplicada como migração `indicadores_diretoria_parte1`.
-- Rollback: drop function public.painel_indicadores_diretoria(date,date,boolean);
-- public.painel_indicadores_diretoria(p_de date, p_ate date, p_incluir_teste boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_indicadores_diretoria(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_teste boolean := coalesce(p_incluir_teste, false);
  v_u text; v_un jsonb := '{}'::jsonb; d jsonb; pl jsonb; v_ped jsonb; v_pla jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje);
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;
  foreach v_u in array array['csi', 'rmtc', 'desenvoar'] loop
    d := public.ind_decisao_periodo(v_de, v_ate, v_u, v_teste) -> 'chat';
    pl := public.painel_indicadores_plataforma(v_de, v_ate, v_u, v_teste);
    v_un := v_un || jsonb_build_object(v_u, jsonb_build_object('pessoas', d -> 'funil' -> 'entraram', 'agendaram', d -> 'funil' -> 'agendaram',
                                                               'marcacoes', pl -> 'total', 'por_tipo', pl -> 'por_tipo'));
  end loop;
  with
  it as (select pu.pessoa, pa.status,
                coalesce(nullif(btrim(upper(pa.procedimento)), ''), '(sem procedimento)') as proc,
                case when pa.plano is null or btrim(pa.plano) = '' then null when pa.plano ~* 'partic' then 'PARTICULAR' when pa.plano ~* 'unimed' then 'UNIMED' else upper(btrim(pa.plano)) end as plano
           from public.conversas c
           join public.painel_conversa_pessoa_un() pu on pu.conversa_id = c.id
           join public.pre_agendamentos pa on pa.conversa_id = c.id
          where (v_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate)
  select coalesce((select jsonb_agg(x order by (x ->> 'pessoas')::int desc, x ->> 'nome') from (
            select jsonb_build_object('nome', proc, 'pessoas', count(distinct pessoa), 'agendaram', count(distinct pessoa) filter (where status = 'agendado')) as x
              from it group by proc order by count(distinct pessoa) desc, proc limit 8) q), '[]'::jsonb),
         coalesce((select jsonb_agg(x order by (x ->> 'pessoas')::int desc, x ->> 'nome') from (
            select jsonb_build_object('nome', plano, 'pessoas', count(distinct pessoa), 'agendaram', count(distinct pessoa) filter (where status = 'agendado')) as x
              from it where plano is not null group by plano order by count(distinct pessoa) desc, plano limit 8) q), '[]'::jsonb)
    into v_ped, v_pla;
  return jsonb_build_object('periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'gerado_em', now(), 'unidades', v_un, 'pedidos', v_ped, 'planos', v_pla);
end $function$;
REVOKE ALL ON FUNCTION public.painel_indicadores_diretoria(date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.painel_indicadores_diretoria(date, date, boolean) TO authenticated, service_role;
