-- public.klingo_plano_resolver(p_operadora text, p_plano_cadastro integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_plano_resolver(p_operadora text, p_plano_cadastro integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m public.klingo_plano_map; v_op text := p_operadora; v_id integer;
begin
  -- plano-exato: "OPERADORA#id" = o plano exato que o paciente escolheu (montado por plano_exato_chave)
  if coalesce(p_operadora, '') ~ '#[0-9]+$' then
    v_id := substring(p_operadora from '#([0-9]+)$')::integer;
    v_op := regexp_replace(p_operadora, '#[0-9]+$', '');
  end if;
  select * into m from public.klingo_plano_map where lower(btrim(operadora)) = lower(btrim(coalesce(v_op, ''))) limit 1;
  if m.operadora is null or m.origem = 'nao_atende' then return jsonb_build_object('plano_id', null, 'motivo', 'sem_traducao'); end if;
  if v_id is not null and m.convenio_id is not null
     and exists (select 1 from public.klingo_convenio k where k.plano_id = v_id and k.convenio_id = m.convenio_id) then
    return jsonb_build_object('plano_id', v_id, 'via', 'escolhido');
  end if;
  if public.norm_nome(v_op) = 'PARTICULAR' and m.plano_id is not null then return jsonb_build_object('plano_id', m.plano_id, 'via', 'padrao'); end if;
  if p_plano_cadastro is not null and m.convenio_id is not null
     and exists (select 1 from public.klingo_convenio k where k.plano_id = p_plano_cadastro and k.convenio_id = m.convenio_id) then
    return jsonb_build_object('plano_id', p_plano_cadastro, 'via', 'cadastro');
  end if;
  if m.plano_id is not null then return jsonb_build_object('plano_id', m.plano_id, 'via', 'padrao'); end if;
  return jsonb_build_object('plano_id', null, 'motivo', 'plano_do_cadastro_necessario');
end $function$;

