-- public.chat_nova_conversa(p_conversa_anterior uuid, p_token_anterior text, p_nome text, p_telefone text, p_email text, p_aceite boolean, p_aceite_previsao boolean, p_origem text, p_unidade text, p_medico text, p_paciente_tipo text, p_paciente_nome text, p_irmaos jsonb, p_irmaos_modo text, p_motivo text, p_motivo_texto text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_nova_conversa(p_conversa_anterior uuid, p_token_anterior text, p_nome text, p_telefone text, p_email text DEFAULT NULL::text, p_aceite boolean DEFAULT false, p_aceite_previsao boolean DEFAULT false, p_origem text DEFAULT NULL::text, p_unidade text DEFAULT NULL::text, p_medico text DEFAULT NULL::text, p_paciente_tipo text DEFAULT 'proprio'::text, p_paciente_nome text DEFAULT NULL::text, p_irmaos jsonb DEFAULT NULL::jsonb, p_irmaos_modo text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text, p_motivo_texto text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a public.conversas; v_dias integer; v_ult timestamptz; v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_motivo text := nullif(btrim(coalesce(p_motivo, '')), ''); v_texto text := nullif(left(btrim(coalesce(p_motivo_texto, '')), 1000), '');
  v_mesmo_dia boolean := false; v_auto text; v_res jsonb; v_nova uuid; v_rep record;
begin
  if v_motivo is not null and v_motivo not in ('sem_retorno', 'outro_assunto') then raise exception 'Motivo inválido.' using errcode = '22023'; end if;
  if p_conversa_anterior is not null then
    select c2.* into a from public.conversas c2 join public.conversa_segredo s on s.conversa_id = c2.id
     where c2.id = p_conversa_anterior and s.token = p_token_anterior for update of c2;
    if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
    select c3.id, s2.token into v_rep from public.conversas c3 join public.conversa_segredo s2 on s2.conversa_id = c3.id
     where c3.reentrada_de = a.id and c3.criado_em > now() - interval '2 minutes' order by c3.criado_em desc limit 1;
    if v_rep.id is not null then
      return jsonb_build_object('conversa_id', v_rep.id, 'token', v_rep.token, 'repetida', true, 'respostas', public.chat_respostas(v_rep.id, 0));
    end if;
    select greatest(a.criado_em, coalesce(max(m.criado_em), a.criado_em)) into v_ult from public.mensagens m where m.conversa_id = a.id;
    v_mesmo_dia := (v_ult at time zone 'America/Sao_Paulo')::date = v_hoje;
    if v_mesmo_dia then
      v_auto := case when a.primeiro_humano_em is null or a.encerramento_origem = 'inatividade' then 'sem_retorno' else 'outro_assunto' end;
    end if;
    if a.status <> 'encerrada' then
      update public.conversas set status = 'encerrada', ia_ativa = false, atualizado_em = now(),
             motivo_encerramento = 'nova_conversa', encerramento_origem = 'paciente'
       where id = a.id;
      if a.status = 'em_atendimento' and a.agente_id is not null then
        insert into public.equipe_notificacao (agente_id, tipo, conversa_id, detalhe)
        values (a.agente_id, 'paciente_abriu_nova', a.id, jsonb_build_object('aviso', 'O paciente encerrou esta conversa para abrir uma nova.'));
      end if;
    end if;
  end if;
  v_res := public.chat_iniciar(p_nome, p_telefone, p_email, v_texto, p_aceite, p_origem, p_unidade, p_medico, p_paciente_tipo, p_paciente_nome, p_irmaos, p_irmaos_modo);
  v_nova := (v_res ->> 'conversa_id')::uuid;
  update public.conversas set
      previsao_aceita_em = case when coalesce(p_aceite_previsao, false) then now() end,
      reentrada_de = p_conversa_anterior,
      reentrada_motivo = case when v_mesmo_dia then v_motivo end,
      reentrada_motivo_auto = v_auto,
      reentrada_texto_informado = case when v_mesmo_dia and v_motivo is not null then v_texto is not null end
   where id = v_nova;
  if p_conversa_anterior is not null then
    if exists (select 1 from public.v_remarcacao_pendente r where r.conversa_id = p_conversa_anterior) then
      begin perform public.agendamento_preparar_remarcacao(v_nova, p_conversa_anterior); exception when others then null; end;
    end if;
    begin
      update public.conversa_evento set detalhe = detalhe || jsonb_build_object('reentrada_de', p_conversa_anterior, 'motivo', case when v_mesmo_dia then v_motivo end,
             'motivo_auto', v_auto, 'texto_informado', case when v_mesmo_dia and v_motivo is not null then v_texto is not null end)
       where conversa_id = v_nova and tipo = 'criada';
    exception when others then null; end;
  end if;
  return v_res;
end $function$;

