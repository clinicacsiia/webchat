-- public.medico_excecao_salvar(p_prof text, p_ini date, p_fim date, p_motivo text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.medico_excecao_salvar(p_prof text, p_ini date, p_fim date, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare k record; v_id bigint;
begin
  perform public.medico_admin();
  select * into k from public.medico_klingo() m where public.norm_nome(m.profissional) = public.norm_nome(p_prof) limit 1;
  if not found then raise exception 'Médico não encontrado na agenda do Klingo.' using errcode = '22023'; end if;
  if p_ini is null then raise exception 'Informe a data.' using errcode = '22023'; end if;
  p_fim := coalesce(p_fim, p_ini);
  if p_fim < p_ini then raise exception 'A data final tem de ser igual ou depois da inicial.' using errcode = '22023'; end if;
  if p_fim < current_date then raise exception 'Essa data já passou.' using errcode = '22023'; end if;
  if p_fim - p_ini > 365 then raise exception 'Período longo demais (máximo 1 ano).' using errcode = '22023'; end if;
  insert into public.medico_excecao (profissional, data_ini, data_fim, motivo, criado_por)
    values (public.norm_nome(k.profissional), p_ini, p_fim, nullif(left(btrim(coalesce(p_motivo, '')), 120), ''), (select auth.uid())) returning id into v_id;
  return jsonb_build_object('id', v_id);
end $function$;

