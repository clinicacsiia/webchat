-- FLUXOGRAMA: entrada (a atendente toca em "Iniciar conversa" na Previsão de marcação; a função pmarc_conversa_garantir cria a conversa com o login dela) -> validação (só quando quem abriu é a atendente, p_por preenchido; o paciente que abre pela própria página continua com o que já valia) -> lógica (o gatilho conversas_conta grava no INSERT o conta_id do login; aqui a conversa é solta dessa conta logo depois de criada; e a conversa da Mirella, já gravada na conta da atendente, é solta e sai do app dela) -> saída (a conversa de paciente deixa de aparecer no "Acompanhe seus pedidos" da atendente que a abriu)
-- Versão 1.0 — 19/11/2026 / Mudança: correção. Atendente que também tem conta de paciente (mesmo login) abriu uma conversa para uma paciente pela Previsão; o gatilho gravou a conversa na conta de paciente da atendente e, ao criar o acesso rápido, a conversa da paciente foi importada para o app dela com o nome da paciente.
-- Pré-requisitos: previsao-marcacao-parte1..4.sql (pmarc_conversa_garantir) e o gatilho conversas_conta (login-paciente.sql). Não mexe no gatilho: o paciente logado que abre o chat continua com a conversa na própria conta.
-- Função: create or replace (mesmo nome, parâmetros e permissões; só service_role).
-- ROLLBACK: recriar pmarc_conversa_garantir com a versão anterior (supabase/producao/funcoes/pmarc_conversa_garantir.sql antes desta mudança: é a mesma sem ", conta_id = null"). Os dados da parte 2 voltam com: insert into public.app_conversa (paciente_id, conversa_id, pessoa_nome, eu) select '249b79d2-1760-468b-b4d3-e368c32e6004', '03da0299-ae30-4835-b47b-bb5fdecb9418', a.nome, true from public.app_paciente a where a.id = '249b79d2-1760-468b-b4d3-e368c32e6004' on conflict do nothing; update public.conversas set conta_id = (select conta_antiga_id from public.app_paciente where id = '249b79d2-1760-468b-b4d3-e368c32e6004') where id = '03da0299-ae30-4835-b47b-bb5fdecb9418';

-- ===== PARTE 1: a função =====
create or replace function public.pmarc_conversa_garantir(p_id uuid, p_por uuid DEFAULT NULL::uuid)
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
    update public.conversas set status = 'em_atendimento', agente_id = p_por, cliente_aguarda_desde = null, conta_id = null where id = v_conv;
    -- 19/11/2026: o gatilho conversas_conta grava no INSERT o login de quem criou; quando é a atendente, a conversa NÃO é da conta de paciente dela (era isso que levava o paciente para o app da atendente).
  end if;
  update public.pmarc_pessoa set conversa_id = v_conv, contato_id = v_contato, atualizado_em = now() where id = p.id;
  return v_conv;
end $function$;

revoke all on function public.pmarc_conversa_garantir(uuid, uuid) from public, anon, authenticated;
grant execute on function public.pmarc_conversa_garantir(uuid, uuid) to service_role;

-- ===== PARTE 2: o caso de 19/11/2026 (uma conversa só; a conferência na produção achou 1 em 11) =====
-- Só solta se a conta dona é de atendente (agentes) e o e-mail e o telefone da conversa NÃO são os da conta.
update public.conversas c set conta_id = null
 where c.id = '03da0299-ae30-4835-b47b-bb5fdecb9418' and c.conta_id is not null
   and exists (select 1 from public.agentes g where g.id = c.conta_id);
delete from public.app_conversa ac
 where ac.conversa_id = '03da0299-ae30-4835-b47b-bb5fdecb9418'
   and ac.paciente_id = '249b79d2-1760-468b-b4d3-e368c32e6004'
   and not exists (select 1 from public.conversas c where c.id = ac.conversa_id and c.conta_id is not null);
