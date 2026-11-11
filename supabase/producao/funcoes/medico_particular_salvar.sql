-- public.medico_particular_salvar(p_prof text, p_valor boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.medico_particular_salvar(p_prof text, p_valor boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare k record;
begin
  perform public.medico_admin();
  select * into k from public.medico_klingo() m where public.norm_nome(m.profissional) = public.norm_nome(p_prof) limit 1;
  if not found then raise exception 'Médico não encontrado na agenda do Klingo.' using errcode = '22023'; end if;
  if p_valor then insert into public.medico_particular (profissional, criado_por) values (public.norm_nome(k.profissional), (select auth.uid())) on conflict do nothing;
  else delete from public.medico_particular where profissional = public.norm_nome(k.profissional); end if;
  return jsonb_build_object('particular', coalesce(p_valor, false));
end $function$;

