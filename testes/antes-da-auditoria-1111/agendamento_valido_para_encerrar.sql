-- Definição que estava na PRODUÇÃO até 11/11/2026 10:23 UTC, ANTES da correção da auditoria.
-- Guardada só para o teste (testes/sql-producao.test.mjs) reproduzir o defeito antes de aplicar a correção. NÃO aplicar no banco.
CREATE OR REPLACE FUNCTION public.agendamento_valido_para_encerrar(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_mem uuid[] := public.pessoa_membros(p_conversa);
  v_a integer; v_k integer; v_sal text; v_erro text; v_em timestamptz; v_atrasado boolean; v_ate timestamptz;
begin
  select count(*) into v_a from public.v_agendamento_aberto v where v.conversa_id = any (v_mem);
  if v_a > 0 then return jsonb_build_object('ok', true, 'fonte', 'chat', 'exames', v_a); end if;

  select valor into v_sal from public.config where chave = 'ia_segredo';
  select count(distinct c.paciente_chave), min(e.agendado_para) into v_k, v_ate
    from public.jornada_card c
    join public.jornada_exame e on e.card_id = c.id
   where c.arquivado_em is null and e.status in ('agendado', 'confirmado') and e.agendado_para >= now() - interval '1 day'
     and (exists (select 1 from public.pessoa_klingo_vinculo pv where pv.prontuario = c.paciente_chave and pv.conversa_id = any (v_mem))
          or exists (select 1 from unnest(v_mem) m
                       join public.conversas cv on cv.id = m
                       join public.contatos ct on ct.id = cv.contato_id
                       join public.jornada_paciente p on p.prontuario = c.paciente_chave
                      where p.fone_chave = encode(sha256(convert_to(right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) || coalesce(v_sal, ''), 'UTF8')), 'hex')
                        and public.nome_confere(p.nome, public.pessoa_ficha(m) ->> 'nome')));
  if v_k = 1 then return jsonb_build_object('ok', true, 'fonte', 'klingo', 'exames', 1, 'ate', v_ate); end if;
  if v_k > 1 then
    return jsonb_build_object('ok', false, 'codigo', 'AGENDADO_AMBIGUO',
      'mensagem', 'Encontrei mais de um paciente possível no Klingo. Confirme na conversa que é a mesma pessoa ou escolha outro motivo.');
  end if;

  select klingo_em, klingo_erro into v_em, v_erro from public.jornada_sync_estado limit 1;
  v_atrasado := v_em is null or v_em < now() - interval '15 minutes' or coalesce(v_erro, '') <> '';
  if v_atrasado then
    return jsonb_build_object('ok', false, 'codigo', 'AGENDADO_AGENDA_INDISPONIVEL',
      'mensagem', 'Não consegui conferir a agenda agora (a leitura do Klingo está atrasada). Tente de novo em instantes ou escolha Apenas informações.');
  end if;
  return jsonb_build_object('ok', false, 'codigo', 'AGENDADO_SEM_AGENDAMENTO',
    'mensagem', 'Não encontrei agendamento vigente para este paciente. Confira o horário no Klingo ou escolha outro motivo.');
end $function$;
