-- public.medico_salvar(p_profissional text, p_unidade text, p_dados jsonb)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.medico_salvar(p_profissional text, p_unidade text, p_dados jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_dias integer[];
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  if p_dados ? 'dias' and jsonb_typeof(p_dados -> 'dias') = 'array' then
    select array_agg(x::int) into v_dias from jsonb_array_elements_text(p_dados -> 'dias') x;
  end if;
  return public.medico_regra_gravar(p_profissional, p_unidade, v_dias, p_dados ->> 'hora_ini', p_dados ->> 'hora_fim', p_dados ->> 'nota');
end $function$;

