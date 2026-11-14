-- public.medicos_disponiveis_interno(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.medicos_disponiveis_interno(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_med text[]; v_procs int[]; v_agora timestamp := now() at time zone 'America/Bahia'; v_ult public.klingo_consulta; v_out jsonb; v_n int;
begin
  perform set_config('app.conversa', p_conversa::text, true);
  v_med := public.fluxo_medicos(p_conversa);
  v_procs := public.fluxo_procs(p_conversa);
  if v_procs is null or coalesce(cardinality(v_med), 0) = 0 then return '[]'::jsonb; end if;
  if cardinality(v_procs) <> 1 then return '[]'::jsonb; end if;
  if not public.klingo_ativo(p_conversa, 'klingo_api_horarios') then return '[]'::jsonb; end if;
  select * into v_ult from public.klingo_consulta where conversa_id = p_conversa and modo not in ('sombra', 'monitor') and em > now() - interval '30 minutes' order by id desc limit 1;
  if v_ult.id is null or v_ult.resultado not in ('ok_com_horarios', 'api_sem_horarios', 'todos_filtrados') then return '[]'::jsonb; end if;
  select count(*) into v_n from public.klingo_oferta o where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > v_agora;
  select coalesce(jsonb_agg(jsonb_build_object('nome', m,
           'proximo', (select to_char(min(o.data + o.hora::time), 'YYYY-MM-DD HH24:MI') from public.klingo_oferta o
                        where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > v_agora and public.klingo_prof_confere(o.profissional, m)),
           'livres', (select count(*) from public.klingo_oferta o
                        where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > v_agora and public.klingo_prof_confere(o.profissional, m)),
           'fonte', 'api_klingo', 'ofertas_na_consulta', v_n) order by m), '[]'::jsonb)
    into v_out from unnest(v_med) m;
  return v_out;
end $function$;

