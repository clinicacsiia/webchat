-- public.medico_detectar_procs()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.medico_detectar_procs()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer := 0;
begin
  if not exists (select 1 from public.medico_proc_base) then
    insert into public.medico_proc_base (profissional, procedimento_id) select k.profissional, k.procedimento_id from public.medico_procs_klingo() k on conflict do nothing;
    return 0;
  end if;
  insert into public.medico_proc_aviso (profissional, procedimento_id, procedimento, especialidade)
    select k.profissional, k.procedimento_id, k.procedimento, k.especialidade from public.medico_procs_klingo() k
    where exists (select 1 from public.medico_base b where public.norm_nome(b.profissional) = public.norm_nome(k.profissional))
      and not exists (select 1 from public.medico_proc_base x where public.norm_nome(x.profissional) = public.norm_nome(k.profissional) and x.procedimento_id = k.procedimento_id)
    on conflict (profissional, procedimento_id) where status = 'pendente' do nothing;
  get diagnostics n = row_count;
  update public.medico_proc_aviso a set status = 'automatico', resolvido_em = now()
    where a.status = 'pendente' and not exists (select 1 from public.medico_procs_klingo() k where public.norm_nome(k.profissional) = public.norm_nome(a.profissional) and k.procedimento_id = a.procedimento_id);
  return n;
end $function$;

