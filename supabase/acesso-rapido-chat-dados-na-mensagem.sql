-- FLUXOGRAMA: entrada (o chat chama app_chat_dados quando o motor pergunta cpf_nasc, cpf_confirma ou identidade e o cadastro do acesso rápido já tem a resposta) -> validação (igual à de antes: aparelho com PIN, conversa do celular do cadastro, pessoa da conversa = titular ou filho do cadastro) -> lógica (igual à de antes; a única mudança é o TEXTO da mensagem do paciente, que deixa de ser só "Usei os dados salvos no meu acesso rápido." e passa a trazer também Nome, CPF mascarado e Nascimento, no mesmo formato das mensagens do passo dados_ident) -> saída (a equipe vê no painel de quem são os dados usados; o CPF continua sem aparecer inteiro: só ***.***.***-NN)
-- Versão 1.0 — 18/11/2026 / Mudança: Implementação inicial (a mensagem "Usei os dados salvos no meu acesso rápido." passa a mostrar os dados do paciente)
--
-- POR QUE: quem usa o acesso rápido não digita CPF e nascimento, e na conversa aparecia só "Usei os dados salvos no meu acesso rápido.". A atendente (e o próprio
-- paciente, ao reler a conversa) não via de quem eram os dados. As mensagens de formulário do chat (dados_ident) já mostram "Nome / Nascimento / CPF" com o CPF
-- escondido; agora esta mensagem faz o mesmo.
--
-- O QUE MUDA: somente o 5º argumento (p_texto) da chamada a chat_responder dentro de app_chat_dados. Nada do motor (fluxo_*, chat_*) é tocado e o retorno da função é o mesmo.
-- SEGURANÇA: o CPF aparece só mascarado (public.app_cpf_mascara: ***.***.***-NN), igual ao que o navegador já recebia em app_chat_dados_resumo. Nome e nascimento são
-- da pessoa da conversa (titular ou filho do cadastro) e já constam do pedido que a equipe vê.
--
-- BASE: cópia da função que está na PRODUÇÃO (supabase/producao/funcoes/app_chat_dados.sql, 18/11/2026), não do arquivo acesso-rapido-chat.sql (que está mais antigo).
--
-- NOTA: o texto da mensagem é montado em v_texto (só os campos que o passo respondeu; CPF mascarado). Aplicada na produção em 19/11/2026 (migração acesso_rapido_chat_dados_na_mensagem); o corpo é idêntico ao do banco.
--
-- ROLLBACK: reaplicar supabase/producao/funcoes/app_chat_dados.sql (texto fixo "Usei os dados salvos no meu acesso rápido.").
-- Pode ser aplicado mais de uma vez (create or replace; sem drop, sem confirmação da ferramenta de migração).

create or replace function public.app_chat_dados(p_token text, p_conversa uuid, p_conv_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  s record; a public.app_paciente%rowtype; c public.conversas; f public.app_filho%rowtype; pa public.pre_agendamentos; d jsonb;
  v_tel text; v_eu boolean; v_cpf text; v_nasc date; v_nome text; v_digitado text; v_passo text; v_depois text; v_valor jsonb; v_texto text; v_n integer := 0; v_guardou boolean := false;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  begin perform public.chat_valida(p_conversa, p_conv_token);
  exception when others then return jsonb_build_object('ok', false, 'erro', 'conversa'); end;
  select * into a from public.app_paciente where id = s.o_pac;
  select * into c from public.conversas where id = p_conversa;
  select regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g') into v_tel from public.contatos ct where ct.id = c.contato_id;
  if v_tel is distinct from a.telefone then return jsonb_build_object('ok', false, 'erro', 'celular'); end if;

  v_eu := coalesce(c.paciente_tipo, 'proprio') = 'proprio';
  if v_eu then v_cpf := a.cpf; v_nasc := a.nascimento; v_nome := a.nome;
  else
    select * into f from public.app_filho where responsavel_id = a.id and removido_em is null and public.app_norm(nome) = public.app_norm(c.paciente_nome) limit 1;
    if not found then return jsonb_build_object('ok', false, 'erro', 'pessoa'); end if;
    v_cpf := f.cpf; v_nasc := f.nascimento; v_nome := f.nome;
  end if;

  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  v_digitado := regexp_replace(coalesce(d -> 'digitado' ->> 'cpf', ''), '\D', '', 'g');
  if v_cpf is null and v_digitado <> '' and public.fluxo_cpf_ok(v_digitado) and regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g') = v_digitado then
    if v_eu then update public.app_paciente set cpf = v_digitado, atualizado_em = now() where id = a.id;
    else update public.app_filho set cpf = v_digitado where id = f.id; end if;
    v_cpf := v_digitado; v_guardou := true;
  end if;
  if a.email is null and btrim(coalesce(c.email_informado, '')) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    update public.app_paciente set email = lower(btrim(c.email_informado)) where id = a.id;
  end if;

  for i in 1..3 loop
    select passo into v_passo from public.conversa_fluxo where conversa_id = p_conversa;
    v_valor := case
      when v_passo = 'cpf_nasc' and v_cpf is not null and v_nasc is not null then jsonb_build_object('cpf', v_cpf, 'dt_nasc', to_char(v_nasc, 'DD/MM/YYYY'))
      when v_passo = 'cpf_confirma' and v_cpf is not null then jsonb_build_object('cpf', v_cpf)
      when v_passo = 'identidade' and v_nasc is not null then jsonb_build_object('dt_nasc', to_char(v_nasc, 'DD/MM/YYYY'))
    end;
    exit when v_valor is null;
    v_texto := concat_ws(E'\n', 'Usei os dados salvos no meu acesso rápido.',
                         case when nullif(btrim(coalesce(v_nome, '')), '') is not null then 'Nome: ' || left(btrim(v_nome), 120) end,
                         case when v_valor ? 'cpf' then 'CPF: ' || public.app_cpf_mascara(v_cpf) end,
                         case when v_valor ? 'dt_nasc' then 'Nascimento: ' || (v_valor ->> 'dt_nasc') end);
    begin
      perform public.chat_responder(p_conversa, p_conv_token, v_passo, v_valor, v_texto, null);
    exception when others then exit;
    end;
    select passo into v_depois from public.conversa_fluxo where conversa_id = p_conversa;
    exit when v_depois is not distinct from v_passo;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'respondeu', v_n, 'guardou', v_guardou);
end $function$;
