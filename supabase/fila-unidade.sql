-- FILA POR UNIDADE (05/11/2026). Aplicado no projeto em duas migrações: fila_unidade_parte1_chave e fila_unidade_parte2_funcao. Só cria funções (sem drop, sem mexer em tabela).
-- unidade_chave(): normaliza o nome da unidade vindo do Klingo ("CSI 1", "CSI 2", "CSI Pediatria"), da agenda ("CLÍNICA DE SAÚDE E IMAGEM - RM/TC") ou do chat ("rmtc") para csi | rmtc | desenvoar. Dúvida = null.
--   Dedução pelos dados: "CSI 2" = RM/TC (590 de 622 exames são RM/TC); "CSI Pediatria" = Desenvoar (consultas pediátricas); "CSI 1" = CSI.
-- fila_unidades_hoje(): unidade provável de cada pessoa na fila de hoje. Fontes (usa a primeira que responder): 1) exame de hoje no Klingo; 2) pedido do chat dos últimos 3 dias; 3) unidade escolhida no formulário do chat.
--   Sem resposta = lista vazia = o painel mostra a pessoa em TODAS as unidades. Só equipe (fila_equipe_ok). Só leitura.
-- ROLLBACK: drop function public.fila_unidades_hoje(); drop function public.unidade_chave(text);

create or replace function public.unidade_chave(p text) returns text language sql immutable set search_path = '' as $$
  select case
    when p is null or btrim(p) = '' then null
    when lower(p) ~ 'desenvoar|pediatria' then 'desenvoar'
    when lower(p) ~ 'rm.?/?.?tc|csi 2' then 'rmtc'
    when lower(p) ~ 'csi' then 'csi'
    else null end
$$;

create or replace function public.fila_unidades_hoje() returns jsonb language plpgsql stable security definer set search_path = '' as $$
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
end $$;
revoke all on function public.fila_unidades_hoje() from public, anon;
grant execute on function public.fila_unidades_hoje() to authenticated;
