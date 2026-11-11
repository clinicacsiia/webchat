-- public.fila_unidades_hoje()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_unidades_hoje()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; v_sal text; v_fh text; v_fone text; v_ids uuid[]; v_u text[]; v_fonte text; v_out jsonb := '[]'::jsonb;
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
    v_u := null; v_fonte := null;
    select array_agg(distinct public.unidade_chave(e.unidade)) filter (where public.unidade_chave(e.unidade) is not null) into v_u
      from public.jornada_card c join public.jornada_paciente jp on jp.prontuario = c.paciente_chave join public.jornada_exame e on e.card_id = c.id
     where c.arquivado_em is null and c.data_ref = public.fila_dia(now()) and c.paciente_chave not like 'conv:%' and c.paciente_chave not like 'manual:%'
       and v_fh is not null and jp.fone_chave = v_fh and public.nome_confere(jp.nome, coalesce(r.conta_nome, r.nome));
    if coalesce(cardinality(v_u), 0) > 0 then v_fonte := 'klingo'; end if;
    if v_fonte is null then
      v_ids := public.pessoa_conversas_de(coalesce(r.conta_nome, r.nome), coalesce(r.telefone, r.conta_tel), coalesce(r.email, r.conta_email), r.conta_id);
      select array_agg(distinct public.unidade_chave(pa.unidade)) filter (where public.unidade_chave(pa.unidade) is not null) into v_u
        from public.pre_agendamentos pa where pa.conversa_id = any (v_ids) and pa.atualizado_em > now() - interval '3 days';
      if coalesce(cardinality(v_u), 0) > 0 then v_fonte := 'pedido'; end if;
    end if;
    if v_fonte is null then
      select array_agg(distinct public.unidade_chave(u.catalogo)) filter (where public.unidade_chave(u.catalogo) is not null) into v_u
        from public.conversas c join public.unidade_config u on u.chave = c.unidade_inicial
       where c.id = any (coalesce(v_ids, '{}'::uuid[])) and c.criado_em > now() - interval '3 days';
      if coalesce(cardinality(v_u), 0) > 0 then v_fonte := 'formulario'; end if;
    end if;
    v_out := v_out || jsonb_build_object('id', r.id, 'unidades', to_jsonb(case when v_fonte is null then '{}'::text[] else v_u end), 'fonte', v_fonte);
  end loop;
  return v_out;
end $function$;

