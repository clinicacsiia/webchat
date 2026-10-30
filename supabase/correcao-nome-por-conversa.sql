-- Correção: o nome (e e-mail) digitado ao abrir o chat passa a valer POR CONVERSA. JÁ APLICADO (30/10/2026) no projeto webchat-atendimento.
-- Bug: contatos é único por telefone e chat_iniciar nunca atualizava contatos.nome. Quando outra pessoa (ex.: Aline) usava o telefone de
-- quem já tinha conversado (ex.: Alisson), a IA e a conferência de identidade continuavam enxergando "Alisson": a IA chamava Aline pelo
-- nome errado e paciente_conferir reaproveitava o cadastro de Alisson (nome, telefone e e-mail "batiam" com o contato antigo).
-- Agora cada conversa guarda o nome/e-mail informado nela (conversas.nome_informado / email_informado) e tudo que decide identidade
-- ou trata o paciente por nome usa esse valor, caindo em contatos só quando a conversa é antiga (colunas nulas).
-- Cada bloco falha sem alterar nada se o ponto de substituição não for encontrado. Sem comandos destrutivos.

alter table public.conversas add column if not exists nome_informado text;
alter table public.conversas add column if not exists email_informado text;
comment on column public.conversas.nome_informado is 'Nome digitado ao abrir ESTA conversa. contatos.nome é do primeiro cadastro do telefone e pode ser de outra pessoa.';

-- 1. chat_iniciar grava o nome/e-mail digitados na conversa nova.
do $$
declare d text; d2 text; alvo text := 'insert into public.conversas (contato_id) values (v_contato) returning id into v_conv;';
begin
  d := pg_get_functiondef('public.chat_iniciar(text,text,text,text,boolean,text)'::regprocedure);
  if position('nome_informado' in d) > 0 then return; end if;
  if length(d) - length(replace(d, alvo, '')) <> length(alvo) then raise exception 'chat_iniciar: ponto de inserção ambíguo ou ausente; nada foi alterado.'; end if;
  d2 := replace(d, alvo, 'insert into public.conversas (contato_id, nome_informado, email_informado) values (v_contato, left(v_nome, 120), nullif(left(btrim(coalesce(p_email, '''')), 200), '''')) returning id into v_conv;');
  execute d2;
end $$;

-- 2. ia_contexto devolve o nome desta conversa.
do $$
declare d text; d2 text; alvo text := '''nome'', ct.nome,';
begin
  d := pg_get_functiondef('public.ia_contexto(text,uuid)'::regprocedure);
  if position('nome_informado' in d) > 0 then return; end if;
  if length(d) - length(replace(d, alvo, '')) <> length(alvo) then raise exception 'ia_contexto: ponto de inserção ambíguo ou ausente; nada foi alterado.'; end if;
  d2 := replace(d, alvo, '''nome'', coalesce(c.nome_informado, ct.nome),');
  execute d2;
end $$;

-- 3. paciente_conferir compara o nome/e-mail desta conversa com o cadastro conhecido (não o do primeiro dono do telefone).
do $$
declare d text; d2 text;
  alvo text := 'select ct.nome, ct.telefone, nullif(btrim(ct.email), '''') as email into v_ct';
begin
  d := pg_get_functiondef('public.paciente_conferir(uuid)'::regprocedure);
  if position('nome_informado' in d) > 0 then return; end if;
  if length(d) - length(replace(d, alvo, '')) <> length(alvo) then raise exception 'paciente_conferir: ponto de inserção ambíguo ou ausente; nada foi alterado.'; end if;
  d2 := replace(d, alvo, 'select coalesce(c.nome_informado, ct.nome) as nome, ct.telefone, nullif(btrim((case when c.nome_informado is not null then c.email_informado else ct.email end)), '''') as email into v_ct');
  execute d2;
end $$;

-- 4. Gatilho do histórico: o paciente "dono" da marcação é achado pelo nome desta conversa.
do $$
declare d text; d2 text; alvo text := 'public.nome_confere(ct.nome, p.nome)';
begin
  d := pg_get_functiondef('public.pre_agendamento_historico_trg()'::regprocedure);
  if position('nome_informado' in d) > 0 then return; end if;
  if length(d) - length(replace(d, alvo, '')) <> length(alvo) then raise exception 'pre_agendamento_historico_trg: ponto de inserção ambíguo ou ausente; nada foi alterado.'; end if;
  d2 := replace(d, alvo, 'public.nome_confere(coalesce(c.nome_informado, ct.nome), p.nome)');
  execute d2;
end $$;

-- 5. ia_pre_agendar: ao criar o paciente conhecido sem nome no formulário, usa o nome desta conversa.
do $$
declare d text; d2 text;
  alvo text := 'select ct.nome, ct.telefone into v_ct from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;';
begin
  d := pg_get_functiondef('public.ia_pre_agendar(text,uuid,jsonb,boolean)'::regprocedure);
  if position('nome_informado' in d) > 0 then return; end if;
  if length(d) - length(replace(d, alvo, '')) <> length(alvo) then raise exception 'ia_pre_agendar: ponto de inserção ambíguo ou ausente; nada foi alterado.'; end if;
  d2 := replace(d, alvo, 'select coalesce(c.nome_informado, ct.nome) as nome, ct.telefone into v_ct from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;');
  execute d2;
end $$;

-- 6. Conferência automática da agenda (Fase 3): também compara com o nome desta conversa.
do $$
declare d text; d2 text; alvo text := 'unnest(array[pa.paciente ->> ''nome'', ct.nome])';
begin
  d := pg_get_functiondef('public.agenda_conferencia_alvos(boolean,boolean)'::regprocedure);
  if position('nome_informado' in d) > 0 then return; end if;
  if length(d) - length(replace(d, alvo, '')) <> length(alvo) then raise exception 'agenda_conferencia_alvos: ponto de inserção ambíguo ou ausente; nada foi alterado.'; end if;
  d2 := replace(d, alvo, 'unnest(array[pa.paciente ->> ''nome'', c.nome_informado, ct.nome])');
  execute d2;
end $$;
