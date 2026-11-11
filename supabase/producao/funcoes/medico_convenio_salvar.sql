-- public.medico_convenio_salvar(p_prof text, p_operadora text, p_proc integer, p_aceita boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.medico_convenio_salvar(p_prof text, p_operadora text, p_proc integer, p_aceita boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare k record; v_op text := public.convenio_chave(p_operadora); v_proc integer := coalesce(p_proc, 0);
begin
  perform public.medico_admin();
  select * into k from public.medico_klingo() m where public.norm_nome(m.profissional) = public.norm_nome(p_prof) limit 1;
  if not found then raise exception 'Médico não encontrado na agenda do Klingo.' using errcode = '22023'; end if;
  if v_op ~ '^(|PARTICULAR.*)$' then raise exception 'Particular não tem restrição: o médico sempre atende particular. Para atender só particular, use a chave "100%% particular".' using errcode = '22023'; end if;
  if not exists (select 1 from public.catalogo_plano where public.convenio_chave(operadora) = v_op) then raise exception 'Convênio não encontrado.' using errcode = '22023'; end if;
  if v_proc < 0 then raise exception 'Exame inválido.' using errcode = '22023'; end if;
  if v_proc > 0 and not exists (select 1 from public.catalogo_agenda a where public.norm_nome(a.profissional) = public.norm_nome(k.profissional) and a.procedimento_id = v_proc) then
    raise exception 'O Klingo não liga esse exame a este médico.' using errcode = '22023';
  end if;
  if p_aceita then
    delete from public.medico_convenio_bloqueio where profissional = public.norm_nome(k.profissional) and operadora = v_op and procedimento_id = v_proc;
  else
    insert into public.medico_convenio_bloqueio (profissional, operadora, procedimento_id, criado_por) values (public.norm_nome(k.profissional), v_op, v_proc, (select auth.uid())) on conflict do nothing;
  end if;
  return jsonb_build_object('ok', true);
end $function$;

