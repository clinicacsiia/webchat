-- public.klingo_plano_resolver(p_operadora text, p_plano_cadastro integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_plano_resolver(p_operadora text, p_plano_cadastro integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m public.klingo_plano_map;
begin
  select * into m from public.klingo_plano_map where lower(btrim(operadora)) = lower(btrim(coalesce(p_operadora, ''))) limit 1;
  if m.operadora is null or m.origem = 'nao_atende' then return jsonb_build_object('plano_id', null, 'motivo', 'sem_traducao'); end if;
  if public.norm_nome(p_operadora) = 'PARTICULAR' and m.plano_id is not null then return jsonb_build_object('plano_id', m.plano_id, 'via', 'padrao'); end if;
  if p_plano_cadastro is not null and m.convenio_id is not null
     and exists (select 1 from public.klingo_convenio k where k.plano_id = p_plano_cadastro and k.convenio_id = m.convenio_id) then
    return jsonb_build_object('plano_id', p_plano_cadastro, 'via', 'cadastro');
  end if;
  if m.plano_id is not null then return jsonb_build_object('plano_id', m.plano_id, 'via', 'padrao'); end if;
  return jsonb_build_object('plano_id', null, 'motivo', 'plano_do_cadastro_necessario');
end $function$;

