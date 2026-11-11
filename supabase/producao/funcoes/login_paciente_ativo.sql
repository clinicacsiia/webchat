-- public.login_paciente_ativo()
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.login_paciente_ativo()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select valor from public.config where chave = 'login_paciente'), 'nao') = 'sim'
     and coalesce((select valor from public.config where chave = 'cadastro_equipe_sem_convite'), 'sim') = 'nao'
$function$;

