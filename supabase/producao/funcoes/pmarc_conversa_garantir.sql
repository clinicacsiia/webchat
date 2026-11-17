-- public.pmarc_conversa_garantir(p_id uuid, p_por uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_conversa_garantir(p_id uuid, p_por uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p public.pmarc_pessoa; v_tel text; v_nome text; v_email text; v_contato uuid; v_conv uuid; v_n integer; v_prox jsonb; v_resumo text;
begin
  select * into p from public.pmarc_pessoa where id = p_id for update;
  if not found then return null; end if;
  if p.conversa_id is not null and exists (select 1 from public.conversas where id = p.conversa_id) then return p.conversa_id; end if;
  v_tel := coalesce(public.pmarc_telefone(p.informado ->> 'celular'), public.pmarc_telefone(p.celular), public.pmarc_telefone(p.telefone));
  if v_tel is null then return null; end if;
  v_nome := left(coalesce(nullif(btrim(p.informado ->> 'nome'), ''), nullif(btrim(p.nome), ''), 'Paciente sem nome'), 120);
  if char_length(v_nome) < 2 then v_nome := 'Paciente sem nome'; end if;
  v_email := coalesce(nullif(btrim(p.informado ->> 'email'), ''), nullif(btrim(p.email), ''));
  if v_email is not null and (v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 200) then v_email := null; end if;

  insert into public.contatos (nome, telefone, email, origem, aceitou_lgpd_em)
  values (v_nome, v_tel, v_email, 'previsao', p.aceitou_lgpd_em)
  on conflict (telefone) do update set ultimo_contato_em = now(), email = coalesce(public.contatos.email, excluded.email),
    aceitou_lgpd_em = coalesce(public.contatos.aceitou_lgpd_em, excluded.aceitou_lgpd_em)
  returning id into v_contato;

  v_prox := public.pmarc_itens(p.chave);
  v_n := jsonb_array_length(v_prox);
  v_resumo := 'PREVISÃO DE MARCAÇÃO (canal separado, sem robô). ' ||
    case when v_n = 0 then 'Não há marcação aberta no Klingo para esta pessoa.'
         else v_n || ' marcação(ões) aberta(s) no Klingo; a primeira: ' || (v_prox -> 0 ->> 'procedimento') || ' em ' ||
              to_char(((v_prox -> 0 ->> 'quando')::timestamptz) at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || '.' end ||
    ' Ainda NÃO é confirmação: a previsão precisa ser vista e confirmada pela equipe (webchat, WhatsApp e telefone). Veja o botão Previsão para os detalhes.';

  insert into public.conversas (contato_id, nome_informado, email_informado, triagem_resumo)
  values (v_contato, v_nome, v_email, v_resumo) returning id into v_conv;
  update public.conversas set ia_ativa = false where id = v_conv;
  insert into public.conversa_segredo (conversa_id) values (v_conv);
  if p_por is not null then
    -- aberta pela atendente: já fica com ela e ninguém está esperando resposta
    update public.conversas set status = 'em_atendimento', agente_id = p_por, cliente_aguarda_desde = null where id = v_conv;
  end if;
  update public.pmarc_pessoa set conversa_id = v_conv, contato_id = v_contato, atualizado_em = now() where id = p.id;
  return v_conv;
end $function$;

