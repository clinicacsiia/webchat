-- public.pmarc_unidades(p_procedimento integer DEFAULT NULL::integer)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.pmarc_unidades(p_procedimento integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_u jsonb;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('chave', case u.chave when 'csi' then 'CSI' when 'rmtc' then 'RM/TC' when 'desenvoar' then 'DESENVOAR' else upper(u.chave) end, 'rotulo', u.rotulo) order by u.ordem), '[]'::jsonb) into v_u
    from public.unidade_config u
   where u.ativo
     and (p_procedimento is null or exists (select 1 from public.catalogo_agenda a
                                             where a.procedimento_id = p_procedimento and a.unidade = u.catalogo and a.vig_fim >= current_date and a.profissional !~* 'teste'));
  return jsonb_build_object('ok', true, 'unidades', v_u);
end $function$;

