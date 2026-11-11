-- public.medico_regra_gravar(p_prof text, p_unid text, p_dias integer[], p_ini text, p_fim text, p_nota text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.medico_regra_gravar(p_prof text, p_unid text, p_dias integer[], p_ini text, p_fim text, p_nota text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare k record; v_dias integer[]; v_ini text := nullif(btrim(p_ini), ''); v_fim text := nullif(btrim(p_fim), ''); v_nota text := nullif(left(btrim(coalesce(p_nota, '')), 200), '');
begin
  select * into k from public.medico_klingo() m where public.norm_nome(m.profissional) = public.norm_nome(p_prof) and public.norm_nome(m.unidade) = public.norm_nome(p_unid);
  if not found then raise exception 'Médico ou unidade não encontrado na agenda do Klingo.' using errcode = '22023'; end if;
  if p_dias is not null then
    select coalesce(array_agg(distinct d order by d), '{}') into v_dias from unnest(p_dias) d where d = any(k.dias);
    if cardinality(v_dias) = 0 then raise exception 'Marque ao menos um dia em que o médico atende, ou bloqueie o médico.' using errcode = '22023'; end if;
    if v_dias = k.dias then v_dias := null; end if;
  end if;
  if v_ini is not null and v_ini !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Hora inicial inválida.' using errcode = '22023'; end if;
  if v_fim is not null and v_fim !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Hora final inválida.' using errcode = '22023'; end if;
  if v_ini is not null and v_fim is not null and v_ini >= v_fim then raise exception 'A hora inicial tem de ser antes da final.' using errcode = '22023'; end if;
  if v_ini is not null and v_ini <= k.hora_ini then v_ini := null; end if;
  if v_fim is not null and v_fim >= k.hora_fim then v_fim := null; end if;
  if v_ini is not null and v_ini >= k.hora_fim then raise exception 'A hora inicial fica depois do fim da grade do Klingo (%).', k.hora_fim using errcode = '22023'; end if;
  if v_fim is not null and v_fim <= k.hora_ini then raise exception 'A hora final fica antes do início da grade do Klingo (%).', k.hora_ini using errcode = '22023'; end if;
  if v_dias is null and v_ini is null and v_fim is null and v_nota is null then
    delete from public.medico_regra where public.norm_nome(profissional) = public.norm_nome(k.profissional) and public.norm_nome(unidade) = public.norm_nome(k.unidade);
    return jsonb_build_object('regra', false);
  end if;
  insert into public.medico_regra (profissional, unidade, dias, hora_ini, hora_fim, nota, atualizado_em, atualizado_por)
    values (k.profissional, k.unidade, v_dias, v_ini, v_fim, v_nota, now(), (select auth.uid()))
    on conflict (profissional, unidade) do update set dias = excluded.dias, hora_ini = excluded.hora_ini, hora_fim = excluded.hora_fim, nota = excluded.nota, atualizado_em = now(), atualizado_por = excluded.atualizado_por;
  return jsonb_build_object('regra', true, 'dias', v_dias, 'hora_ini', v_ini, 'hora_fim', v_fim);
end $function$;

