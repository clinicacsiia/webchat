-- INSTALADOR ÚNICO — LOGIN DO PACIENTE (gerado; NÃO edite este arquivo: edite os 3 de baixo e rode "node testes/gerar-instalador.mjs").
-- Cole tudo de uma vez no Supabase > SQL Editor > Run. Pode rodar mais de uma vez sem estragar nada.
-- Contém, em ordem: contas-paciente.sql, protecao-identidade.sql, login-paciente.sql.
-- Depois de rodar, siga docs/login-paciente-passo-a-passo.md. O login do paciente nasce DESLIGADO (config.login_paciente = 'nao').
-- ============================================================================================================================

-- FLUXOGRAMA: entrada (todo usuário novo do Supabase Auth, via gatilho on_auth_user_created) -> validação (primeiro usuário do banco? e-mail convidado pelo administrador? chave config.cadastro_equipe_sem_convite?) -> lógica (equipe vira linha INATIVA em agentes; paciente vira linha em contas_paciente; convite é de uso único) -> saída (agentes, contas_paciente e equipe_convites; RPCs equipe_convidar e equipe_convite_cancelar só para administrador)
-- Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
--
-- POR QUE: o gatilho original (novo_usuario) criava uma linha em public.agentes para QUALQUER cadastro novo. Com o login do paciente
-- (cadastro público por e-mail e senha), cada paciente apareceria como "atendente aguardando liberação" no painel, e um clique errado
-- do administrador daria acesso de equipe a um paciente. Agora:
--   1. primeiro usuário do banco -> administrador ativo (igual ao anterior; só vale para um banco vazio);
--   2. e-mail convidado por um administrador (equipe_convidar) -> agente INATIVO com o papel do convite (o painel libera em seguida);
--   3. config.cadastro_equipe_sem_convite = 'sim' (TRANSIÇÃO, valor inicial) -> comportamento antigo: agente inativo sem convite;
--   4. qualquer outro cadastro -> public.contas_paciente (sem nenhum acesso de equipe).
-- DEPOIS de publicar o painel novo (que convida antes de cadastrar) e ANTES de ligar o login do paciente:
--     update public.config set valor = 'nao' where chave = 'cadastro_equipe_sem_convite';
--
-- ROLLBACK (definição anterior do gatilho, copiada da produção em 31/10/2026):
--   create or replace function public.novo_usuario() returns trigger language plpgsql security definer set search_path to '' as $f$
--   declare v_primeiro boolean;
--   begin
--     select not exists (select 1 from public.agentes) into v_primeiro;
--     insert into public.agentes (id, nome, email, papel, ativo)
--     values (new.id, coalesce(nullif(btrim(new.raw_user_meta_data->>'nome'), ''), split_part(new.email, '@', 1)), new.email,
--             case when v_primeiro then 'admin' else 'atendente' end, v_primeiro);
--     return new;
--   end $f$;
--   (as tabelas e funções novas podem ficar; ou: drop function public.equipe_convidar(text, text), public.equipe_convite_cancelar(text);
--    drop table public.equipe_convites, public.contas_paciente;)
-- Nenhum comando destrutivo neste arquivo. Pode ser aplicado mais de uma vez.

-- 1. Contas de paciente (login opcional). Só o gatilho escreve; o próprio paciente lê a sua linha; a equipe lê para vincular o cadastro.
create table if not exists public.contas_paciente (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  paciente_id uuid references public.pacientes(id) on delete set null,   -- só o cadastro criado pela própria conversa logada (login-paciente.sql) ou a equipe vinculam
  criado_em timestamptz not null default now(),
  ultimo_acesso_em timestamptz
);
comment on table public.contas_paciente is 'Conta de login do paciente (Supabase Auth). Criada pelo gatilho novo_usuario. paciente_id é preenchido quando a PRÓPRIA conversa logada cria o cadastro (ver login-paciente.sql) ou pela equipe depois de validar a identidade. Cadastro que já existia (e-mail digitado antes, sem verificação) nunca é vinculado sozinho.';
create index if not exists contas_paciente_paciente on public.contas_paciente (paciente_id);
alter table public.contas_paciente enable row level security;
revoke all on table public.contas_paciente from anon, authenticated;
grant select on table public.contas_paciente to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contas_paciente' and policyname = 'contas_paciente_select') then
    create policy contas_paciente_select on public.contas_paciente for select
      using (id = (select auth.uid()) or (select public.papel_atual()) = any (array['admin','atendente']));
  end if;
end $$;

-- 2. Convites da equipe. Sem acesso direto: só as funções abaixo (administrador) e o gatilho.
create table if not exists public.equipe_convites (
  email text primary key check (email = lower(btrim(email)) and email <> ''),
  papel text not null default 'atendente' check (papel in ('admin','atendente','marketing')),
  criado_por uuid references auth.users(id) on delete set null,
  criado_em timestamptz not null default now(),
  usado_em timestamptz
);
comment on table public.equipe_convites is 'E-mails que podem virar equipe ao se cadastrar. Uso único (usado_em). Criado por equipe_convidar (administrador).';
alter table public.equipe_convites enable row level security;
revoke all on table public.equipe_convites from anon, authenticated;

create or replace function public.equipe_convidar(p_email text, p_papel text default 'atendente') returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Só administrador convida pessoas para a equipe.' using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.' using errcode = '22023'; end if;
  if coalesce(p_papel, '') not in ('admin','atendente','marketing') then raise exception 'Papel inválido.' using errcode = '22023'; end if;
  insert into public.equipe_convites (email, papel, criado_por) values (v_email, p_papel, (select auth.uid()))
  on conflict (email) do update set papel = excluded.papel, criado_por = excluded.criado_por, criado_em = now(), usado_em = null;
  return jsonb_build_object('ok', true, 'email', v_email, 'papel', p_papel);
end $$;

create or replace function public.equipe_convite_cancelar(p_email text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_n int;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Só administrador cancela convites.' using errcode = '42501'; end if;
  delete from public.equipe_convites where email = lower(btrim(coalesce(p_email, '')));
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'removidos', v_n);
end $$;
revoke all on function public.equipe_convidar(text, text), public.equipe_convite_cancelar(text) from public, anon;
grant execute on function public.equipe_convidar(text, text), public.equipe_convite_cancelar(text) to authenticated;

-- 3. Chave de transição: enquanto o painel antigo estiver no ar, cadastro sem convite continua gerando agente inativo (comportamento anterior).
insert into public.config (chave, valor) values ('cadastro_equipe_sem_convite', 'sim') on conflict (chave) do nothing;

-- 4. Gatilho: decide para onde vai cada cadastro novo.
create or replace function public.novo_usuario() returns trigger language plpgsql security definer set search_path to '' as $$
declare v_primeiro boolean; v_email text := lower(btrim(coalesce(new.email, ''))); v_papel text; v_nome text;
begin
  v_nome := coalesce(nullif(btrim(new.raw_user_meta_data ->> 'nome'), ''), nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'Sem nome');
  select not exists (select 1 from public.agentes) into v_primeiro;
  if v_primeiro then
    insert into public.agentes (id, nome, email, papel, ativo) values (new.id, v_nome, new.email, 'admin', true);
    return new;
  end if;
  if v_email <> '' then
    update public.equipe_convites set usado_em = now() where email = v_email and usado_em is null returning papel into v_papel;
  end if;
  if v_papel is not null then
    insert into public.agentes (id, nome, email, papel, ativo) values (new.id, v_nome, new.email, v_papel, false);
  elsif coalesce((select valor from public.config where chave = 'cadastro_equipe_sem_convite'), 'nao') = 'sim' then
    insert into public.agentes (id, nome, email, papel, ativo) values (new.id, v_nome, new.email, 'atendente', false);
  else
    insert into public.contas_paciente (id, email) values (new.id, new.email) on conflict (id) do nothing;
  end if;
  return new;
end $$;

-- FLUXOGRAMA: entrada (conversa do chat; nome, telefone e e-mail digitados no início + data de nascimento digitada) -> validação (chave config.reaproveitar_cadastro_convidado; cadastros em revisão são ignorados) -> lógica (convidado = sempre "novo", sem reaproveitar cadastro nem histórico; com a chave 'sim' vale a regra anterior: nome E telefone (e e-mail, se o cadastro tem) + data de nascimento; desempate prefere cadastro validado) -> saída (jsonb {situacao, paciente_id, dt_nasc_conferida, ...} ou {situacao: 'novo'})
-- Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
--
-- POR QUE: a data de nascimento era o único segredo real para liberar histórico e reaproveitar cadastro (nome, telefone e e-mail
-- não são verificados), sem limite de tentativas e com resposta visível a quem acerta (ver a auditoria de 31/10/2026).
-- Com o login do paciente, quem precisa de cadastro pré-preenchido ou histórico entra com conta. Quem agenda SEM login passa a ser
-- sempre "paciente novo": o motor não pergunta a data de nascimento, não mostra histórico e não copia pedido anterior.
-- Como todos os pontos de entrada (fluxo_proximo, paciente_historico_para_ia, pre_reaproveitar, ia_pre_agendar, ia_contexto) passam
-- por paciente_conferir, trocar só esta função fecha o caminho do motor 'fluxo' e do motor 'ia'.
--
-- ESTA É A DEFINIÇÃO VIVA DA PRODUÇÃO (copiada de pg_get_functiondef em 31/10/2026), mais as 3 mudanças marcadas com "-- NOVO".
-- Isso também corrige a divergência: a cópia de supabase/pacientes.sql é a versão antiga (regra "2 de 3", sem nome_informado).
--
-- LIGAR DE NOVO (se a recepção precisar do comportamento antigo por algum motivo):
--     update public.config set valor = 'sim' where chave = 'reaproveitar_cadastro_convidado';
-- ROLLBACK COMPLETO: recriar a função sem o bloco "-- NOVO" (a definição anterior está em supabase/correcao-login-nome-telefone-email.sql
-- e no histórico do git, commit 72700ff).
-- Nenhum comando destrutivo. Pode ser aplicado mais de uma vez.

insert into public.config (chave, valor) values ('reaproveitar_cadastro_convidado', 'nao') on conflict (chave) do nothing;

create or replace function public.paciente_conferir(p_conversa uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_ct record; b record; v_dt text; v_conf boolean; v_t int; v_m int; v_sit text;
begin
  -- NOVO: convidado (sem login) nunca reaproveita cadastro nem histórico. Ausente ou diferente de 'sim' = fechado.
  if coalesce((select valor from public.config where chave = 'reaproveitar_cadastro_convidado'), 'nao') <> 'sim' then
    return jsonb_build_object('situacao', 'novo');
  end if;

  select coalesce(c.nome_informado, ct.nome) as nome, ct.telefone, nullif(btrim((case when c.nome_informado is not null then c.email_informado else ct.email end)), '') as email into v_ct
  from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
  if not found then return jsonb_build_object('situacao', 'novo'); end if;
  if (select c.paciente_tipo from public.conversas c where c.id = p_conversa) = 'filho' then
    v_ct.nome := (select coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), c.paciente_nome) from public.conversas c
                  left join public.pre_agendamentos pa on pa.conversa_id = c.id where c.id = p_conversa);
    if v_ct.nome is null then return jsonb_build_object('situacao', 'novo'); end if;
  end if;

  select q.* into b from (
    select p.id, p.email as p_email, p.validado, p.dt_nasc, p.ultima_visita_em, p.atualizado_em,
           public.nome_confere(v_ct.nome, p.nome) as n_ok,
           coalesce(public.fone_chave(v_ct.telefone) = any(p.telefones), false) as t_ok,
           (v_ct.email is not null and p.email is not null and lower(v_ct.email) = lower(p.email)) as e_ok,
           (v_ct.email is not null and p.email is not null) as e_cmp
    from public.pacientes p
    where p.origem_conversa is distinct from p_conversa
      and not p.revisar   -- NOVO: cadastro marcado para revisão (CPF repetido, data divergente) não serve de base para ninguém
      and (public.fone_chave(v_ct.telefone) = any(p.telefones) or public.nome_confere(v_ct.nome, p.nome)
           or (v_ct.email is not null and lower(v_ct.email) = lower(p.email)))) q
  order by (q.n_ok::int + q.t_ok::int + q.e_ok::int) desc, q.validado desc, q.atualizado_em desc limit 1;   -- NOVO: validado desempata antes do mais recente
  if not found then return jsonb_build_object('situacao', 'novo'); end if;

  v_t := 2 + b.e_cmp::int;
  v_m := b.n_ok::int + b.t_ok::int + b.e_ok::int;
  v_sit := case when b.n_ok and b.t_ok and (b.p_email is null or b.e_ok) then 'completo' else 'novo' end;
  if v_sit = 'novo' then return jsonb_build_object('situacao', 'novo'); end if;

  select paciente ->> 'dt_nasc' into v_dt from public.pre_agendamentos where conversa_id = p_conversa;
  v_conf := case when public.data_ou_nula(v_dt) is not null and b.dt_nasc is not null then public.data_ou_nula(v_dt) = b.dt_nasc else null end;
  return jsonb_build_object('situacao', v_sit, 'paciente_id', b.id,
    'batem', to_jsonb(array_remove(array[case when b.n_ok then 'nome' end, case when b.t_ok then 'telefone' end, case when b.e_ok then 'email' end], null)),
    'diferem', to_jsonb(array_remove(array[case when not b.n_ok then 'nome' end, case when not b.t_ok then 'telefone' end, case when b.e_cmp and not b.e_ok then 'email' end], null)),
    'validado', b.validado, 'dt_nasc_conferida', v_conf, 'ultima_visita_em', b.ultima_visita_em::date);
end $function$;

-- FLUXOGRAMA: entrada (paciente logado inicia uma conversa no chat; JWT do Supabase Auth) -> validação (conta_id vem de auth.uid() no gatilho, nunca do cliente; só conta de paciente, só atendimento "proprio"; vínculo só com o cadastro CRIADO por aquela conversa) -> lógica (conversa guarda a conta; o primeiro cadastro criado pela conversa vira o cadastro da conta; nas próximas conversas paciente_conferir reconhece a conta e reaproveita cadastro e histórico sem perguntar a data de nascimento) -> saída (conversas.conta_id, contas_paciente.paciente_id, paciente_conferir com 'conta': true, RPCs conta_paciente_resumo e conta_paciente_perfil)
-- Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
--
-- DEPENDE de supabase/contas-paciente.sql (tabela contas_paciente) e de supabase/protecao-identidade.sql (trava do convidado).
-- Este arquivo SUBSTITUI paciente_conferir pela versão de protecao-identidade.sql + o ramo da conta (marcado "-- NOVO (login)").
--
-- REGRAS:
--  * Convidado (sem login) continua sempre "paciente novo" (trava config.reaproveitar_cadastro_convidado).
--  * Conta de paciente: o PRIMEIRO cadastro criado por uma conversa feita logado, "para mim", vira o cadastro da conta. Cadastros que já
--    existiam (digitados antes, sem verificação) NUNCA são vinculados sozinhos: isso é feito pela equipe.
--  * Nas conversas seguintes da conta, a identidade é a própria conta: sem pergunta de data de nascimento, com cadastro e histórico.
--  * Atendimento "para meu filho(a)" não usa conta nesta versão (dependentes ficam para uma próxima etapa).
-- ROLLBACK: recriar paciente_conferir com supabase/protecao-identidade.sql; drop trigger conversas_conta on public.conversas;
--   drop trigger pre_agendamento_vincula_conta on public.pre_agendamentos; drop function public.conta_paciente_resumo(), public.conta_paciente_perfil(text, text, boolean);
--   (as colunas novas podem ficar). Nenhum comando destrutivo neste arquivo. Pode ser aplicado mais de uma vez.

-- 1. Perfil na conta (o chat pré-preenche nome e telefone) e registro do aceite (LGPD).
alter table public.contas_paciente add column if not exists nome text;
alter table public.contas_paciente add column if not exists telefone text;
alter table public.contas_paciente add column if not exists aceitou_lgpd_em timestamptz;

-- 2. A conversa guarda a conta que a abriu.
alter table public.conversas add column if not exists conta_id uuid references auth.users(id) on delete set null;
create index if not exists conversas_conta_idx on public.conversas (conta_id) where conta_id is not null;

-- conta_id é SEMPRE derivado do login (auth.uid()) e só existe para conta de paciente: o cliente não consegue informar outro valor.
create or replace function public.conversas_conta_trg() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  new.conta_id := (select cp.id from public.contas_paciente cp where cp.id = (select auth.uid()));
  return new;
end $$;
create or replace trigger conversas_conta before insert on public.conversas for each row execute function public.conversas_conta_trg();

-- 3. Vínculo conta -> cadastro: só com o cadastro CRIADO pela própria conversa logada ("para mim"), e só se a conta ainda não tem um.
create or replace function public.pre_agendamento_vincula_conta_trg() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.paciente_id is null or (tg_op = 'UPDATE' and new.paciente_id is not distinct from old.paciente_id) then return new; end if;
  update public.contas_paciente cp set paciente_id = new.paciente_id
    from public.conversas c, public.pacientes p
   where c.id = new.conversa_id and cp.id = c.conta_id and cp.paciente_id is null
     and c.paciente_tipo = 'proprio'
     and p.id = new.paciente_id and p.origem_conversa = new.conversa_id;
  return new;
end $$;
create or replace trigger pre_agendamento_vincula_conta after insert or update of paciente_id on public.pre_agendamentos
  for each row execute function public.pre_agendamento_vincula_conta_trg();

-- 4. paciente_conferir: versão de protecao-identidade.sql + o ramo da conta.
create or replace function public.paciente_conferir(p_conversa uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_ct record; b record; v_dt text; v_conf boolean; v_t int; v_m int; v_sit text; v_pac record;
begin
  -- NOVO (login): conversa aberta por conta de paciente (atendimento "proprio") cujo cadastro foi vinculado: a identidade já foi provada
  -- pelo login, então cadastro e histórico valem sem perguntar a data de nascimento. Cadastro em revisão não serve de base.
  select p.id, p.validado, p.ultima_visita_em into v_pac
    from public.conversas c
    join public.contas_paciente cp on cp.id = c.conta_id
    join public.pacientes p on p.id = cp.paciente_id and not p.revisar
   where c.id = p_conversa and c.paciente_tipo = 'proprio';
  if found then
    return jsonb_build_object('situacao', 'completo', 'paciente_id', v_pac.id, 'batem', jsonb_build_array('conta'), 'diferem', '[]'::jsonb,
      'validado', v_pac.validado, 'dt_nasc_conferida', true, 'ultima_visita_em', v_pac.ultima_visita_em::date, 'conta', true);
  end if;

  -- convidado (sem login) nunca reaproveita cadastro nem histórico. Ausente ou diferente de 'sim' = fechado.
  if coalesce((select valor from public.config where chave = 'reaproveitar_cadastro_convidado'), 'nao') <> 'sim' then
    return jsonb_build_object('situacao', 'novo');
  end if;

  select coalesce(c.nome_informado, ct.nome) as nome, ct.telefone, nullif(btrim((case when c.nome_informado is not null then c.email_informado else ct.email end)), '') as email into v_ct
  from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
  if not found then return jsonb_build_object('situacao', 'novo'); end if;
  if (select c.paciente_tipo from public.conversas c where c.id = p_conversa) = 'filho' then
    v_ct.nome := (select coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), c.paciente_nome) from public.conversas c
                  left join public.pre_agendamentos pa on pa.conversa_id = c.id where c.id = p_conversa);
    if v_ct.nome is null then return jsonb_build_object('situacao', 'novo'); end if;
  end if;

  select q.* into b from (
    select p.id, p.email as p_email, p.validado, p.dt_nasc, p.ultima_visita_em, p.atualizado_em,
           public.nome_confere(v_ct.nome, p.nome) as n_ok,
           coalesce(public.fone_chave(v_ct.telefone) = any(p.telefones), false) as t_ok,
           (v_ct.email is not null and p.email is not null and lower(v_ct.email) = lower(p.email)) as e_ok,
           (v_ct.email is not null and p.email is not null) as e_cmp
    from public.pacientes p
    where p.origem_conversa is distinct from p_conversa
      and not p.revisar
      and (public.fone_chave(v_ct.telefone) = any(p.telefones) or public.nome_confere(v_ct.nome, p.nome)
           or (v_ct.email is not null and lower(v_ct.email) = lower(p.email)))) q
  order by (q.n_ok::int + q.t_ok::int + q.e_ok::int) desc, q.validado desc, q.atualizado_em desc limit 1;
  if not found then return jsonb_build_object('situacao', 'novo'); end if;

  v_t := 2 + b.e_cmp::int;
  v_m := b.n_ok::int + b.t_ok::int + b.e_ok::int;
  v_sit := case when b.n_ok and b.t_ok and (b.p_email is null or b.e_ok) then 'completo' else 'novo' end;
  if v_sit = 'novo' then return jsonb_build_object('situacao', 'novo'); end if;

  select paciente ->> 'dt_nasc' into v_dt from public.pre_agendamentos where conversa_id = p_conversa;
  v_conf := case when public.data_ou_nula(v_dt) is not null and b.dt_nasc is not null then public.data_ou_nula(v_dt) = b.dt_nasc else null end;
  return jsonb_build_object('situacao', v_sit, 'paciente_id', b.id,
    'batem', to_jsonb(array_remove(array[case when b.n_ok then 'nome' end, case when b.t_ok then 'telefone' end, case when b.e_ok then 'email' end], null)),
    'diferem', to_jsonb(array_remove(array[case when not b.n_ok then 'nome' end, case when not b.t_ok then 'telefone' end, case when b.e_cmp and not b.e_ok then 'email' end], null)),
    'validado', b.validado, 'dt_nasc_conferida', v_conf, 'ultima_visita_em', b.ultima_visita_em::date);
end $function$;

-- 5. Funções que a tela chama (só conta de paciente logada; equipe e anônimo recebem "sem conta").
create or replace function public.conta_paciente_resumo() returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce((select jsonb_build_object('conta', true, 'email', cp.email, 'nome', cp.nome, 'telefone', cp.telefone,
                                             'cadastro_salvo', cp.paciente_id is not null, 'aceitou_lgpd', cp.aceitou_lgpd_em is not null)
                     from public.contas_paciente cp where cp.id = (select auth.uid())), jsonb_build_object('conta', false))
$$;

create or replace function public.conta_paciente_perfil(p_nome text, p_telefone text, p_aceite boolean default false) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_nome text := btrim(coalesce(p_nome, '')); v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
begin
  if (select auth.uid()) is null or not exists (select 1 from public.contas_paciente where id = (select auth.uid())) then
    raise exception 'Entre na sua conta para salvar os dados.' using errcode = '42501';
  end if;
  if char_length(v_nome) not between 2 and 120 then raise exception 'Informe o seu nome.' using errcode = '22023'; end if;
  if char_length(v_tel) in (12, 13) and left(v_tel, 2) = '55' then v_tel := substr(v_tel, 3); end if;
  if char_length(v_tel) not in (10, 11) then raise exception 'Informe um telefone válido com DDD.' using errcode = '22023'; end if;
  update public.contas_paciente set nome = v_nome, telefone = v_tel,
         aceitou_lgpd_em = coalesce(aceitou_lgpd_em, case when coalesce(p_aceite, false) then now() end)
   where id = (select auth.uid());
  return public.conta_paciente_resumo();
end $$;
revoke all on function public.conta_paciente_resumo(), public.conta_paciente_perfil(text, text, boolean) from public, anon;
grant execute on function public.conta_paciente_resumo(), public.conta_paciente_perfil(text, text, boolean) to authenticated;

-- 6. Interruptor do login. A tela de login do chat só aparece quando esta função devolve true, e ela só devolve true se:
--    (a) config.login_paciente = 'sim' (você liga) E (b) config.cadastro_equipe_sem_convite = 'nao' (cadastro da equipe já só por convite).
--    Assim publicar o chat novo não abre o cadastro por acidente. Para ligar:   update public.config set valor = 'sim' where chave = 'login_paciente';
--    Para desligar na hora:                                                      update public.config set valor = 'nao' where chave = 'login_paciente';
insert into public.config (chave, valor) values ('login_paciente', 'nao') on conflict (chave) do nothing;
create or replace function public.login_paciente_ativo() returns boolean language sql stable security definer set search_path to '' as $$
  select coalesce((select valor from public.config where chave = 'login_paciente'), 'nao') = 'sim'
     and coalesce((select valor from public.config where chave = 'cadastro_equipe_sem_convite'), 'sim') = 'nao'
$$;
revoke all on function public.login_paciente_ativo() from public;
grant execute on function public.login_paciente_ativo() to anon, authenticated;
