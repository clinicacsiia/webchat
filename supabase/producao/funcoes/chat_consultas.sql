-- public.chat_consultas(p_conversa uuid, p_token text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_consultas(p_conversa uuid, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_cat text; v_med text;
begin
  perform public.chat_valida(p_conversa, p_token);
  select u.catalogo, c.medico_preferido into v_cat, v_med
  from public.conversas c left join public.unidade_config u on u.chave = c.unidade_inicial where c.id = p_conversa;
  return jsonb_build_object('medico_preferido', v_med, 'consultas', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'rotulo', x.rotulo, 'do_medico', coalesce(v_med = any(x.medicos), false))
                     order by coalesce(v_med = any(x.medicos), false) desc, x.profissionais desc, x.rotulo)
    from (select * from public.consultas_da_unidade(v_cat) limit 24) x), '[]'::jsonb));
end $function$;

