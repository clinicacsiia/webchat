-- public.app_laudos_pessoas(p_pac uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_laudos_pessoas(p_pac uuid)
 RETURNS TABLE(pessoa text, nome text, nascimento date, cpf text, eu boolean, ih text, ord integer, criado timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select 'eu'::text, a.nome, a.nascimento, a.cpf, true, case when a.cpf is not null then public.klingo_hash(a.cpf || '|' || a.nascimento::text) end, 0, a.criado_em
    from public.app_paciente a where a.id = p_pac
  union all
  select f.id::text, f.nome, f.nascimento, f.cpf, false, case when f.cpf is not null then public.klingo_hash(f.cpf || '|' || f.nascimento::text) end, 1, f.criado_em
    from public.app_filho f where f.responsavel_id = p_pac and f.removido_em is null
$function$;

