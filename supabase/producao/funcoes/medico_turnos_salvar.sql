-- public.medico_turnos_salvar(p_prof text, p_unid text, p_turnos jsonb, p_nota text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.medico_turnos_salvar(p_prof text, p_unid text, p_turnos jsonb, p_nota text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare k record; t record; v_n integer := 0; v_dias integer; v_igual boolean; v_nota text := nullif(left(btrim(coalesce(p_nota, '')), 200), '');
        nomes text[] := array['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
begin
  perform public.medico_admin();
  select * into k from public.medico_klingo() m where public.norm_nome(m.profissional) = public.norm_nome(p_prof) and public.norm_nome(m.unidade) = public.norm_nome(p_unid);
  if not found then raise exception 'Médico ou unidade não encontrado na agenda do Klingo.' using errcode = '22023'; end if;
  if p_turnos is null or jsonb_typeof(p_turnos) <> 'array' then raise exception 'Turnos inválidos.' using errcode = '22023'; end if;
  if jsonb_array_length(p_turnos) > 28 then raise exception 'Turnos demais.' using errcode = '22023'; end if;
  for t in select (x ->> 'dia')::int as dia, nullif(btrim(x ->> 'hora_ini'), '') as hi, nullif(btrim(x ->> 'hora_fim'), '') as hf from jsonb_array_elements(p_turnos) x loop
    if t.dia is null or t.dia < 0 or t.dia > 6 then raise exception 'Dia inválido.' using errcode = '22023'; end if;
    if not (t.dia = any(k.dias)) then raise exception 'O Klingo não tem agenda na %.', nomes[t.dia + 1] using errcode = '22023'; end if;
    if t.hi is null or t.hf is null or t.hi !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or t.hf !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Horário inválido na %.', nomes[t.dia + 1] using errcode = '22023'; end if;
    if t.hi >= t.hf then raise exception 'Na %, a hora inicial tem de ser antes da final.', nomes[t.dia + 1] using errcode = '22023'; end if;
    if t.hi < k.hora_ini or t.hf > k.hora_fim then raise exception 'Na %, o turno % às % fica fora da grade do Klingo (% às %).', nomes[t.dia + 1], t.hi, t.hf, k.hora_ini, k.hora_fim using errcode = '22023'; end if;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'Marque ao menos um turno, ou bloqueie o médico no chat.' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_to_recordset(p_turnos) a(dia int, hora_ini text, hora_fim text) join jsonb_to_recordset(p_turnos) b(dia int, hora_ini text, hora_fim text) on a.dia = b.dia
             where a.hora_ini < b.hora_fim and b.hora_ini < a.hora_fim and (a.hora_ini, a.hora_fim) <> (b.hora_ini, b.hora_fim)) then
    raise exception 'Há turnos que se sobrepõem no mesmo dia.' using errcode = '22023';
  end if;
  select count(distinct x.dia), bool_and(x.hora_ini = k.hora_ini and x.hora_fim = k.hora_fim) into v_dias, v_igual from jsonb_to_recordset(p_turnos) x(dia int, hora_ini text, hora_fim text);
  v_igual := v_igual and v_dias = cardinality(k.dias) and (select count(distinct (x.dia, x.hora_ini)) from jsonb_to_recordset(p_turnos) x(dia int, hora_ini text, hora_fim text)) = v_dias;
  delete from public.medico_turno where public.norm_nome(profissional) = public.norm_nome(k.profissional) and public.norm_nome(unidade) = public.norm_nome(k.unidade);
  if not v_igual then
    insert into public.medico_turno (profissional, unidade, dia, hora_ini, hora_fim)
      select distinct k.profissional, k.unidade, x.dia, x.hora_ini, x.hora_fim from jsonb_to_recordset(p_turnos) x(dia int, hora_ini text, hora_fim text);
  end if;
  perform public.medico_regra_gravar(k.profissional, k.unidade, null, null, null, v_nota);
  return jsonb_build_object('regra', not v_igual);
end $function$;

