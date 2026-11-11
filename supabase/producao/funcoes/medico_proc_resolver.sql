-- public.medico_proc_resolver(p_ids bigint[])
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.medico_proc_resolver(p_ids bigint[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer;
begin
  perform public.medico_admin();
  insert into public.medico_proc_base (profissional, procedimento_id, conferido_em)
    select a.profissional, a.procedimento_id, now() from public.medico_proc_aviso a where a.id = any(p_ids) and a.status = 'pendente' on conflict (profissional, procedimento_id) do update set conferido_em = now();
  update public.medico_proc_aviso set status = 'ativo', resolvido_em = now(), resolvido_por = (select auth.uid()) where id = any(p_ids) and status = 'pendente';
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'ativados', n);
end $function$;

