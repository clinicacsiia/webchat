-- public.chat_iniciar(p_nome text, p_telefone text, p_email text, p_mensagem text, p_aceite boolean, p_origem text, p_unidade text, p_medico text, p_paciente_tipo text, p_paciente_nome text, p_irmaos jsonb, p_irmaos_modo text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_iniciar(p_nome text, p_telefone text, p_email text DEFAULT NULL::text, p_mensagem text DEFAULT NULL::text, p_aceite boolean DEFAULT false, p_origem text DEFAULT NULL::text, p_unidade text DEFAULT NULL::text, p_medico text DEFAULT NULL::text, p_paciente_tipo text DEFAULT 'proprio'::text, p_paciente_nome text DEFAULT NULL::text, p_irmaos jsonb DEFAULT NULL::jsonb, p_irmaos_modo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tel text; v_contato uuid; v_conv uuid; v_token text; v_url text;
  v_nome text; v_msg text; v_recentes int; v_uni text; v_med text; v_tipo text; v_pnome text; v_irm jsonb := '[]'::jsonb; v_modo text; v_motor text;
begin
  v_tipo := coalesce(nullif(btrim(p_paciente_tipo), ''), 'proprio');
  if v_tipo not in ('proprio', 'filho') then raise exception 'Tipo de paciente inválido.' using errcode = '22023'; end if;
  v_pnome := case when v_tipo = 'filho' then nullif(left(btrim(coalesce(p_paciente_nome, '')), 120), '') end;
  if p_irmaos is not null then
    if jsonb_typeof(p_irmaos) <> 'array' then raise exception 'Lista de filhos inválida.' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(t.n), '[]'::jsonb) into v_irm
    from (select left(btrim(x), 120) as n from jsonb_array_elements_text(p_irmaos) x where btrim(x) <> '' limit 5) t;
  end if;
  if jsonb_array_length(v_irm) > 0 then
    if v_tipo <> 'filho' then raise exception 'Outros filhos só valem quando o atendimento é para um filho(a).' using errcode = '22023'; end if;
    v_modo := coalesce(nullif(btrim(coalesce(p_irmaos_modo, '')), ''), 'um_de_cada_vez');
    if v_modo not in ('um_de_cada_vez', 'juntos') then raise exception 'Modo de agendamento inválido.' using errcode = '22023'; end if;
  end if;
  if not coalesce(p_aceite, false) then raise exception 'Aceite a política de privacidade para continuar.' using errcode = '22023'; end if;
  v_nome := btrim(coalesce(p_nome, ''));
  if char_length(v_nome) < 2 then raise exception 'Informe seu nome.' using errcode = '22023'; end if;
  v_tel := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  if char_length(v_tel) in (12, 13) and left(v_tel, 2) = '55' then v_tel := substr(v_tel, 3); end if;
  if char_length(v_tel) not in (10, 11) then raise exception 'Informe um telefone válido com DDD.' using errcode = '22023'; end if;
  if btrim(coalesce(p_email, '')) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Informe um e-mail válido.' using errcode = '22023'; end if;
  v_msg := btrim(coalesce(p_mensagem, ''));
  if char_length(v_msg) > 4000 then raise exception 'Mensagem muito longa.' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_unidade, '')), '') is not null then
    select u.chave into v_uni from public.unidade_config u where u.chave = btrim(p_unidade) and u.ativo;
    if v_uni is null then raise exception 'Unidade inválida.' using errcode = '22023'; end if;
  end if;
  if nullif(btrim(coalesce(p_medico, '')), '') is not null then
    if v_uni is null then raise exception 'Escolha a unidade para indicar o médico.' using errcode = '22023'; end if;
    select m.nome into v_med from public.unidade_medicos(v_uni) m where m.nome = btrim(p_medico);
    if v_med is null then raise exception 'Médico não encontrado nesta unidade.' using errcode = '22023'; end if;
  end if;
  select c.id into v_contato from public.contatos c where c.telefone = v_tel;
  if v_contato is not null then
    select count(*) into v_recentes from public.conversas where contato_id = v_contato and criado_em > now() - interval '1 hour';
    if v_recentes >= 5 then raise exception 'Muitas tentativas. Tente novamente em alguns minutos.' using errcode = '54000'; end if;
  end if;
  insert into public.contatos (nome, telefone, email, origem, aceitou_lgpd_em)
  values (left(v_nome, 120), v_tel, nullif(left(btrim(coalesce(p_email, '')), 200), ''), nullif(left(btrim(coalesce(p_origem, '')), 100), ''), now())
  on conflict (telefone) do update set ultimo_contato_em = now(), email = coalesce(public.contatos.email, excluded.email),
    aceitou_lgpd_em = coalesce(public.contatos.aceitou_lgpd_em, now())
  returning id into v_contato;
  insert into public.conversas (contato_id, nome_informado, email_informado, unidade_inicial, medico_preferido, paciente_tipo, paciente_nome, irmaos, irmaos_modo)
  values (v_contato, left(v_nome, 120), nullif(left(btrim(coalesce(p_email, '')), 200), ''), v_uni, v_med, v_tipo, v_pnome, v_irm, v_modo)
  returning id, motor into v_conv, v_motor;
  insert into public.conversa_segredo (conversa_id) values (v_conv) returning token into v_token;
  if v_msg = '' and v_tipo = 'filho' and v_pnome is not null and v_motor = 'ia' then v_msg := 'Olá! Quero agendar para ' || v_pnome || '.'; end if;
  if v_msg <> '' then
    insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'cliente', v_msg);
  elsif v_motor = 'fluxo' then
    perform public.fluxo_avancar(v_conv, '{}'::jsonb);
  end if;
  return jsonb_build_object('conversa_id', v_conv, 'token', v_token, 'motor', v_motor, 'respostas', public.chat_respostas(v_conv, 0));
end $function$;

