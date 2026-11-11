-- public.jornada_coluna_do_card(p_status text[])
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.jornada_coluna_do_card(p_status text[])
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when 'atendido' = any (p_status) then 'em_atendimento'
    when not exists (select 1 from unnest(p_status) s where s in ('agendado', 'confirmado')) then
      case when 'faltou' = any (p_status) then 'faltou' when 'remarcado' = any (p_status) then 'remarcado' else 'cancelado' end
    when not exists (select 1 from unnest(p_status) s where s = 'agendado') then 'confirmado'
    else 'a_confirmar'
  end;
$function$;

