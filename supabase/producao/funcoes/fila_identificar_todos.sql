-- public.fila_identificar_todos()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_identificar_todos()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; v_sal text; v_fh text; v_fone text; v_sit text; v_pac record; v_out jsonb := '[]'::jsonb; v_ids uuid[]; v_kl jsonb;
begin
  perform public.fila_equipe_ok();
  select valor into v_sal from public.config where chave = 'ia_segredo';
  for r in
    select f.id, f.nome, f.email, f.telefone, f.conta_id, cp.nome as conta_nome, cp.telefone as conta_tel, cp.email as conta_email
      from public.fila_chegada f left join public.contas_paciente cp on cp.id = f.conta_id
     where f.status in ('aguardando', 'chamado') and public.fila_dia(f.chegou_em) = public.fila_dia(now())
  loop
    v_fone := public.fone_chave(coalesce(r.telefone, r.conta_tel));
    v_fh := case when v_fone is not null then encode(sha256(convert_to(right(regexp_replace(coalesce(r.telefone, r.conta_tel, ''), '\D', '', 'g'), 8) || coalesce(v_sal, ''), 'UTF8')), 'hex') end;
    v_pac := null; v_sit := 'novo';
    select p.id, p.nome, public.nome_confere(p.nome, coalesce(r.conta_nome, r.nome)) as nome_ok into v_pac
      from public.pacientes p
     where (v_fone is not null and v_fone = any (p.telefones)) or (coalesce(r.email, r.conta_email, '') <> '' and lower(p.email) = lower(coalesce(r.email, r.conta_email)))
     order by public.nome_confere(p.nome, coalesce(r.conta_nome, r.nome)) desc, p.ultima_visita_em desc limit 1;
    if v_pac.id is not null then v_sit := case when v_pac.nome_ok then 'cadastrado' else 'talvez' end; end if;
    v_ids := public.pessoa_conversas_de(coalesce(r.conta_nome, r.nome), coalesce(r.telefone, r.conta_tel), coalesce(r.email, r.conta_email), r.conta_id);
    select coalesce(jsonb_agg(jsonb_build_object('nome', e.procedimento, 'status', e.status) order by e.id), '[]'::jsonb) into v_kl
      from public.jornada_card c join public.jornada_paciente jp on jp.prontuario = c.paciente_chave join public.jornada_exame e on e.card_id = c.id
     where c.arquivado_em is null and c.data_ref = public.fila_dia(now()) and c.paciente_chave not like 'conv:%' and c.paciente_chave not like 'manual:%'
       and v_fh is not null and jp.fone_chave = v_fh and public.nome_confere(jp.nome, coalesce(r.conta_nome, r.nome));
    v_out := v_out || (jsonb_build_object('id', r.id, 'situacao', v_sit, 'paciente_nome', v_pac.nome, 'klingo', v_kl) || public.pessoa_resumo_de(v_ids));
  end loop;
  return v_out;
end $function$;

