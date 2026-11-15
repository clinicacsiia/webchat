-- FLUXOGRAMA: entrada (o chat real, depois que a pessoa digitou o PIN do acesso rápido, chama app_chat_dados com o código do aparelho + o código da conversa) -> validação (aparelho desbloqueado; conversa é deste celular; pessoa da conversa = titular ou um filho do cadastro) -> lógica (1º: guarda o CPF e o e-mail que a pessoa digitou nesta conversa, se o cadastro ainda não tem; 2º: se o motor está perguntando cpf_nasc, cpf_confirma ou identidade e o cadastro já tem a resposta, responde pelo MESMO caminho do chat — chat_responder) -> saída (a conversa passa direto para a próxima pergunta; o CPF nunca volta para o navegador, só a máscara)
-- Versão 1.0 — 14/11/2026 / Mudança: Implementação inicial (acesso rápido dentro do chat real; fim do "CPF e data de nascimento toda hora")
--
-- POR QUE: o motor do chat trata "CPF + nascimento" como a PRIMEIRA coisa de toda conversa nova (fluxo_proximo: cpf-primeiro), e depois ainda pode pedir
-- o CPF de novo (cpf_confirma) e o nascimento (identidade). Nada guardava isso entre conversas. Agora quem entrou pelo acesso rápido (celular + PIN)
-- tem o CPF e o nascimento de cada pessoa guardados no cadastro e o chat só pergunta uma vez na vida.
--
-- DEPENDE DE: supabase/acesso-rapido-paciente.sql (tabelas e funções app_*). O interruptor é o mesmo: config.app_acesso_modo.
-- Nenhuma função do motor (fluxo_*, chat_*) é alterada: esta função só CHAMA chat_responder como se a pessoa tivesse digitado.
--
-- SEGURANÇA:
--   * o PIN é a prova de identidade (o motor aceita o CPF guardado como "confirmado" porque quem chama já digitou o PIN nos últimos 30 min);
--   * o CPF fica em app_paciente / app_filho (RLS sem regra, como o resto). O navegador recebe só "***.***.***-12" e se há CPF salvo;
--   * a conversa precisa ser do celular do cadastro, e a criança da conversa precisa ser um filho DESTE cadastro (pelo nome);
--   * quem acompanha como número de confiança nunca recebe CPF (confiam_em_mim não tem esse campo).
--
-- ROLLBACK:
--   drop function if exists public.app_chat_dados(text, uuid, text), public.app_pessoa_cpf_salvar(text, text, text), public.app_ativo(), public.app_cpf_mascara(text);
--   (restaurar app_perfil_json: reaplicar a PARTE 2 de supabase/acesso-rapido-paciente.sql)
--   alter table public.app_paciente drop column if exists cpf, drop column if exists email; alter table public.app_filho drop column if exists cpf;
-- Pode ser aplicado mais de uma vez.

alter table public.app_paciente add column if not exists cpf text check (cpf is null or cpf ~ '^[0-9]{11}$');
alter table public.app_paciente add column if not exists email text check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
alter table public.app_filho add column if not exists cpf text check (cpf is null or cpf ~ '^[0-9]{11}$');
comment on column public.app_paciente.cpf is 'CPF do titular, guardado na primeira vez que ele o digitou no chat (ou em Meus dados). Nunca sai do banco inteiro: a página recebe só a máscara.';
comment on column public.app_filho.cpf is 'CPF da criança (ou do responsável, se ela não tiver), como digitado no chat. Nunca sai do banco inteiro.';

create or replace function public.app_cpf_mascara(p text) returns text language sql immutable set search_path to '' as $$
  select case when p ~ '^[0-9]{11}$' then '***.***.***-' || right(p, 2) end $$;

-- A página do chat só mostra o acesso rápido quando o interruptor está ligado.
create or replace function public.app_ativo() returns boolean language sql stable security definer set search_path to '' as $$ select public.app_modo() $$;

-- Perfil como a página precisa: igual ao anterior, mais e-mail e "tem CPF salvo" (com máscara) do titular e de cada filho.
create or replace function public.app_perfil_json(p_pac uuid) returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'nome', a.nome, 'nascimento', a.nascimento, 'telefone', a.telefone, 'selecao', a.ultima_selecao, 'email', a.email,
    'cpf_salvo', a.cpf is not null, 'cpf_mascara', public.app_cpf_mascara(a.cpf),
    'filhos', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nome', f.nome, 'nascimento', f.nascimento, 'cpf_salvo', f.cpf is not null, 'cpf_mascara', public.app_cpf_mascara(f.cpf))
                                         order by f.criado_em, f.id)
                        from public.app_filho f where f.responsavel_id = a.id and f.removido_em is null), '[]'::jsonb),
    'confiaveis', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'telefone', c.telefone, 'relacao', c.relacao,
                              'vinculado', c.vinculado_em is not null, 'codigo', case when c.vinculado_em is null then c.codigo end,
                              'codigo_invalido', c.vinculado_em is null and c.codigo_falhas >= 5) order by c.criado_em, c.id)
                            from public.app_contato_confianca c where c.responsavel_id = a.id and c.removido_em is null), '[]'::jsonb),
    'marcacoes', public.app_marcacoes_json(a.id),
    'confiam_em_mim', coalesce((select jsonb_agg(jsonb_build_object('contato_id', c.id, 'titular_nome', t.nome,
                              'filhos', coalesce((select jsonb_agg(jsonb_build_object('nome', f.nome, 'nascimento', f.nascimento) order by f.criado_em, f.id)
                                                  from public.app_filho f where f.responsavel_id = t.id and f.removido_em is null), '[]'::jsonb),
                              'marcacoes', public.app_marcacoes_json(t.id)) order by c.vinculado_em, c.id)
                            from public.app_contato_confianca c join public.app_paciente t on t.id = c.responsavel_id
                            where c.vinculado_a = a.id and c.removido_em is null and c.vinculado_em is not null), '[]'::jsonb))
  from public.app_paciente a where a.id = p_pac $$;

-- Meus dados: guardar, trocar ou apagar o CPF de uma pessoa do cadastro ('eu' ou o id de um filho). p_cpf vazio apaga.
create or replace function public.app_pessoa_cpf_salvar(p_token text, p_pessoa text, p_cpf text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record; v_cpf text := nullif(regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'), ''); v_id uuid;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if v_cpf is not null and not public.fluxo_cpf_ok(v_cpf) then return jsonb_build_object('ok', false, 'erro', 'cpf', 'mensagem', 'Os números do CPF não conferem. Confira, por favor.'); end if;
  if p_pessoa = 'eu' then
    update public.app_paciente set cpf = v_cpf, atualizado_em = now() where id = s.o_pac;
  elsif coalesce(p_pessoa, '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    update public.app_filho set cpf = v_cpf where id = p_pessoa::uuid and responsavel_id = s.o_pac and removido_em is null returning id into v_id;
    if v_id is null then return jsonb_build_object('ok', false, 'erro', 'pessoa', 'mensagem', 'Pessoa não encontrada no seu cadastro.'); end if;
  else
    return jsonb_build_object('ok', false, 'erro', 'pessoa', 'mensagem', 'Pessoa não encontrada no seu cadastro.');
  end if;
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $$;

-- O chat chama isto logo depois de abrir cada conversa (e quando o motor mostra uma das perguntas abaixo).
create or replace function public.app_chat_dados(p_token text, p_conversa uuid, p_conv_token text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  s record; a public.app_paciente%rowtype; c public.conversas; f public.app_filho%rowtype; pa public.pre_agendamentos; d jsonb;
  v_tel text; v_eu boolean; v_cpf text; v_nasc date; v_digitado text; v_passo text; v_depois text; v_valor jsonb; v_n integer := 0; v_guardou boolean := false;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  begin perform public.chat_valida(p_conversa, p_conv_token);
  exception when others then return jsonb_build_object('ok', false, 'erro', 'conversa'); end;
  select * into a from public.app_paciente where id = s.o_pac;
  select * into c from public.conversas where id = p_conversa;
  select regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g') into v_tel from public.contatos ct where ct.id = c.contato_id;
  if v_tel is distinct from a.telefone then return jsonb_build_object('ok', false, 'erro', 'celular'); end if;   -- conversa de outro celular: não mexe

  v_eu := coalesce(c.paciente_tipo, 'proprio') = 'proprio';
  if v_eu then v_cpf := a.cpf; v_nasc := a.nascimento;
  else
    select * into f from public.app_filho where responsavel_id = a.id and removido_em is null and public.app_norm(nome) = public.app_norm(c.paciente_nome) limit 1;
    if not found then return jsonb_build_object('ok', false, 'erro', 'pessoa'); end if;   -- criança digitada à mão que não está no cadastro: o chat pergunta normalmente
    v_cpf := f.cpf; v_nasc := f.nascimento;
  end if;

  -- 1) guardar o que a pessoa digitou nesta conversa (só o que o cadastro ainda não tem)
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

  -- 2) responder, pelo caminho normal do chat, o que o cadastro já sabe (no máximo 3 perguntas seguidas)
  for i in 1..3 loop
    select passo into v_passo from public.conversa_fluxo where conversa_id = p_conversa;
    v_valor := case
      when v_passo = 'cpf_nasc' and v_cpf is not null and v_nasc is not null then jsonb_build_object('cpf', v_cpf, 'dt_nasc', to_char(v_nasc, 'DD/MM/YYYY'))
      when v_passo = 'cpf_confirma' and v_cpf is not null then jsonb_build_object('cpf', v_cpf)
      when v_passo = 'identidade' and v_nasc is not null then jsonb_build_object('dt_nasc', to_char(v_nasc, 'DD/MM/YYYY'))
    end;
    exit when v_valor is null;
    begin
      perform public.chat_responder(p_conversa, p_conv_token, v_passo, v_valor, 'Usei os dados salvos no meu acesso rápido.', null);
    exception when others then exit;
    end;
    select passo into v_depois from public.conversa_fluxo where conversa_id = p_conversa;
    exit when v_depois is not distinct from v_passo;   -- o motor recusou (por ex.: CPF não confere): deixa a pergunta aparecer para a pessoa
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'respondeu', v_n, 'guardou', v_guardou);
end $$;

revoke all on function public.app_cpf_mascara(text), public.app_ativo(), public.app_pessoa_cpf_salvar(text, text, text), public.app_chat_dados(text, uuid, text), public.app_perfil_json(uuid) from public, anon, authenticated;
grant execute on function public.app_ativo(), public.app_pessoa_cpf_salvar(text, text, text), public.app_chat_dados(text, uuid, text) to anon, authenticated;
