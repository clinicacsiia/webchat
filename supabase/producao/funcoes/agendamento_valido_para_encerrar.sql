-- public.agendamento_valido_para_encerrar(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agendamento_valido_para_encerrar(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_mem uuid[] := public.pessoa_membros(p_conversa);
  v_a integer; v_k integer; v_sal text; v_erro text; v_em timestamptz; v_atrasado boolean; v_ate timestamptz;
  v_pront text[];
begin
  -- A) exame marcado pelo chat e ainda sem desfecho
  select count(*) into v_a from public.v_agendamento_aberto v where v.conversa_id = any (v_mem);
  if v_a > 0 then return jsonb_build_object('ok', true, 'fonte', 'chat', 'exames', v_a); end if;

  -- B) cartão do Klingo com exame vigente, ligado à pessoa por prontuário confirmado OU por nome + marca do telefone.
  --    1º: quais prontuários são dessa pessoa (a ficha de cada conversa é calculada UMA vez).
  select valor into v_sal from public.config where chave = 'ia_segredo';
  with q as materialized (
    select public.pessoa_ficha(m.id) ->> 'nome' as nome,
           encode(sha256(convert_to(right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) || coalesce(v_sal, ''), 'UTF8')), 'hex') as fh
      from unnest(v_mem) as m(id)
      join public.conversas cv on cv.id = m.id
      join public.contatos ct on ct.id = cv.contato_id)
  select array_agg(distinct x.prontuario) into v_pront from (
    select pv.prontuario from public.pessoa_klingo_vinculo pv where pv.conversa_id = any (v_mem)
    union
    select p.prontuario from q join public.jornada_paciente p on p.fone_chave = q.fh where public.nome_confere(p.nome, q.nome)) x;

  --    2º: exame vigente só nesses prontuários.
  select count(distinct c.paciente_chave), min(e.agendado_para) into v_k, v_ate
    from public.jornada_card c
    join public.jornada_exame e on e.card_id = c.id
   where c.paciente_chave = any (coalesce(v_pront, '{}'::text[])) and c.arquivado_em is null
     and e.status in ('agendado', 'confirmado') and e.agendado_para >= now() - interval '1 day';
  if v_k = 1 then return jsonb_build_object('ok', true, 'fonte', 'klingo', 'exames', 1, 'ate', v_ate); end if;
  if v_k > 1 then
    return jsonb_build_object('ok', false, 'codigo', 'AGENDADO_AMBIGUO',
      'mensagem', 'Encontrei mais de um paciente possível no Klingo. Confirme na conversa que é a mesma pessoa ou escolha outro motivo.');
  end if;

  -- Nada encontrado: a leitura do Klingo está em dia?
  select klingo_em, klingo_erro into v_em, v_erro from public.jornada_sync_estado limit 1;
  v_atrasado := v_em is null or v_em < now() - interval '15 minutes' or coalesce(v_erro, '') <> '';
  if v_atrasado then
    return jsonb_build_object('ok', false, 'codigo', 'AGENDADO_AGENDA_INDISPONIVEL',
      'mensagem', 'Não consegui conferir a agenda agora (a leitura do Klingo está atrasada). Tente de novo em instantes ou escolha Apenas informações.');
  end if;
  return jsonb_build_object('ok', false, 'codigo', 'AGENDADO_SEM_AGENDAMENTO',
    'mensagem', 'Não encontrei agendamento vigente para este paciente. Confira o horário no Klingo ou escolha outro motivo.');
end $function$;

