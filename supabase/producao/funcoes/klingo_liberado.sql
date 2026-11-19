-- public.klingo_liberado(p_conversa uuid, p_proc integer, p_tipo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_liberado(p_conversa uuid, p_proc integer, p_tipo text) returns boolean
  language plpgsql stable security definer set search_path to ''
as $function$
declare d jsonb; v_nasc date; v_idade integer; v_sexo text; pr record; v_cbos text;
begin
  if public.klingo_cfg('klingo_so_liberados', 'nao') <> 'sim' then return true; end if;
  if p_proc is null then return false; end if;
  if not public.klingo_automatizavel(p_proc, p_tipo)
     and not (p_tipo = 'consulta' and p_proc::text = any (string_to_array(replace(public.klingo_cfg('consultas_sem_api', ''), ' ', ''), ','))) then
    return false;
  end if;
  d := public.klingo_dados_conversa(p_conversa);
  v_nasc := nullif(d ->> 'nascimento', '')::date;
  v_idade := case when v_nasc is null then null else extract(year from age((now() at time zone 'America/Bahia')::date, v_nasc))::integer end;
  v_sexo := upper(left(coalesce(d ->> 'sexo', ''), 1));
  select idade_min, idade_max, sexo into pr from public.catalogo_procedimento where id = p_proc;
  if v_idade is not null and (v_idade < coalesce(pr.idade_min, 0) or v_idade > coalesce(pr.idade_max, 999)) then return false; end if;
  if coalesce(pr.sexo, '') <> '' and v_sexo in ('M', 'F') and upper(left(pr.sexo, 1)) <> v_sexo then return false; end if;
  if p_tipo = 'consulta' and v_idade is not null then
    select e.cbos into v_cbos from public.klingo_especialidade e where e.liberada_api and p_proc = any (e.procedimentos) limit 1;
    if v_cbos is not null and exists (select 1 from public.klingo_profissional m where v_cbos = any (m.cbos))
       and not exists (select 1 from public.klingo_profissional m where v_cbos = any (m.cbos) and (m.idade_max is null or m.idade_max >= v_idade)) then
      return false;
    end if;
  end if;
  return true;
end $function$;
