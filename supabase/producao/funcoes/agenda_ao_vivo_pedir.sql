-- public.agenda_ao_vivo_pedir(p_dias date[])
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_ao_vivo_pedir(p_dias date[])
 RETURNS TABLE(dia_ref date, acao text, lido timestamp with time zone, iniciado timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d date; r public.agenda_ao_vivo%rowtype; v_agora timestamptz := clock_timestamp(); v_lendo integer;
  v_val integer := public.agenda_ao_vivo_inteiro('agenda_ao_vivo_validade_s', 15, 0, 3600);
  v_trava integer := public.agenda_ao_vivo_inteiro('agenda_ao_vivo_trava_s', 40, 5, 600);
  v_max integer := public.agenda_ao_vivo_inteiro('agenda_ao_vivo_max_dias', 14, 1, 62);
begin
  if p_dias is null or cardinality(p_dias) = 0 or cardinality(p_dias) > 15 then raise exception 'Dias inválidos.' using errcode = '22023'; end if;
  foreach d in array p_dias loop
    insert into public.agenda_ao_vivo (dia) values (d) on conflict do nothing;
    select * into r from public.agenda_ao_vivo a where a.dia = d for update;
    dia_ref := d; lido := r.lido_em; iniciado := null;
    if v_val > 0 and r.ok and r.lido_em is not null and r.lido_em > v_agora - make_interval(secs => v_val) then
      acao := 'fresco';
    elsif r.lendo_desde is not null and r.lendo_desde > v_agora - make_interval(secs => v_trava) then
      acao := 'lendo';
    else
      select count(*) into v_lendo from public.agenda_ao_vivo a where a.lendo_desde is not null and a.lendo_desde > v_agora - make_interval(secs => v_trava);
      if v_lendo >= v_max then
        acao := 'ocupado';
      else
        update public.agenda_ao_vivo a set lendo_desde = v_agora, atualizado_em = now() where a.dia = d;
        acao := 'ler'; iniciado := v_agora;
      end if;
    end if;
    return next;
  end loop;
end $function$;

