-- public.medico_detectar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.medico_detectar()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer;
begin
  perform pg_advisory_xact_lock(hashtext('medico_detectar'));
  if not exists (select 1 from public.catalogo_agenda) then return 0; end if;
  if not exists (select 1 from public.medico_base) then
    insert into public.medico_base (profissional, unidade, dias, hora_ini, hora_fim)
      select k.profissional, k.unidade, k.dias, k.hora_ini, k.hora_fim from public.medico_klingo() k where not k.sala;
    perform public.medico_detectar_procs();
    return 0;
  end if;
  insert into public.medico_aviso (profissional, unidade, tipo, antes, depois)
    select d.profissional, d.unidade, d.tipo, d.antes, d.depois from public.medico_diferencas() d
    on conflict (profissional, unidade) where status = 'pendente'
    do update set tipo = excluded.tipo, antes = excluded.antes, depois = excluded.depois;
  get diagnostics n = row_count;
  update public.medico_aviso a set status = 'automatico', resolvido_em = now()
    where a.status = 'pendente' and not exists (select 1 from public.medico_diferencas() m where m.profissional = a.profissional and m.unidade = a.unidade);
  perform public.medico_detectar_procs();
  return n;
end $function$;

