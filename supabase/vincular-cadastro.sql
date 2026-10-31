-- FLUXOGRAMA: entrada (paciente cria a conta com nome completo, telefone, e-mail, data de nascimento e senha; confirma o e-mail; o chat chama conta_paciente_vincular com o JWT dele) -> validação (só conta de paciente logada; e-mail da conta CONFIRMADO; nome completo e data de nascimento obrigatórios; no máximo 5 tentativas por hora) -> lógica (acha UM cadastro livre e fora de revisão com nome e data de nascimento iguais; conta os acertos: nome + nascimento + telefone + e-mail; 4 acertos liga sozinho; 3 acertos liga sozinho e abre aviso "atualizar" para o atendente; só nome + nascimento NÃO liga e abre pedido "verificar" para o atendente decidir) -> saída (contas_paciente.paciente_id, vinculo_solicitacoes, resultado 'vinculado' / 'vinculado_conferir' / 'em_analise' / 'nao_encontrado' / 'bloqueado' / 'email_nao_confirmado' / 'nada_pendente' / 'ja_vinculado'; RPCs vinculo_listar e vinculo_decidir para a equipe)
-- Versão 1.2 — 31/10/2026 / Mudança: CPF como prova extra (liga a conta quando telefone e e-mail não batem) e pedido de mudança de e-mail ou telefone do cadastro, sempre com o atendente no final
-- (1.1: 3 acertos ligam sozinho com aviso ao atendente; menos de 3 vai para o atendente decidir)
--
-- DEPENDE de supabase/contas-paciente.sql, protecao-identidade.sql e login-paciente.sql (e de pacientes.sql: fone_chave, norm_nome, nome_confere, data_ou_nula).
--
-- REGRAS:
--   1. Nome completo (pelo menos duas palavras) e data de nascimento são OBRIGATÓRIOS e precisam bater com o MESMO cadastro. Sem isso nada é ligado nem enviado ao atendente.
--   2. O e-mail da conta precisa estar CONFIRMADO (auth.users.email_confirmed_at) para qualquer tentativa.
--   3. Acertos = nome + nascimento (obrigatórios) + telefone + e-mail do cadastro.
--        4 acertos  -> liga sozinho, sem aviso.
--        3 acertos  -> liga sozinho e abre um aviso "atualizar": o atendente confere e atualiza o telefone ou o e-mail do cadastro (ou desfaz o vínculo).
--        2 acertos  -> NÃO liga. Abre um pedido "verificar": o atendente decide vincular (com ou sem atualizar o cadastro) ou recusar.
--   4. Fica de fora (resultado "não encontrado", sem aviso): cadastro em revisão (revisar), cadastro já ligado a outra conta, nenhum cadastro com nome e nascimento iguais, ou mais de um.
--   5. CPF (conta_paciente_confirmar_cpf): quem ficou em "só nome + nascimento" pode informar o CPF. Se bater com o CPF do MESMO cadastro, vira o 3º acerto: a conta é ligada e o aviso "atualizar" abre para o atendente conferir telefone e e-mail.
--   6. Mudar e-mail ou telefone do cadastro (conta_paciente_pedir_alteracao): só conta já ligada, informando o CPF do cadastro. Nada muda sozinho: abre um pedido "alterar" e o atendente aplica ou recusa. O CPF nunca é guardado nem devolvido; só é comparado.
--   7. No máximo 5 tentativas por hora por conta (contam tentativa de vínculo, de CPF e de pedido de alteração); cada cadastro de conta faz uma tentativa (a data digitada é apagada depois).
-- A resposta ao paciente não revela dado do cadastro: só se ligou, se está em análise ou se não achou.
-- ATENÇÃO: com 3 acertos o e-mail pode ser o que NÃO bateu (nome + nascimento + telefone). O telefone e a data de nascimento são fáceis de saber para quem conhece o paciente;
--   por isso o aviso ao atendente existe e o vínculo pode ser desfeito. Para exigir sempre o e-mail igual, ver o comentário "VARIANTE MAIS ESTRITA" abaixo.
-- ROLLBACK: drop function public.conta_paciente_vincular(), public.vinculo_listar(), public.vinculo_decidir(bigint, text), public.conta_paciente_confirmar_cpf(text), public.conta_paciente_pedir_alteracao(text, text, text), public.conta_paciente_vinculo_estado(), public.cpf_digitos(text), public.cpf_valido(text); drop table public.vinculo_solicitacoes;
--   (as colunas novas em contas_paciente podem ficar; recriar a versão 1.0 pelo histórico do repositório). Nenhum comando destrutivo neste arquivo. Pode ser aplicado mais de uma vez.

alter table public.contas_paciente add column if not exists vinculo_tentativas int not null default 0;
alter table public.contas_paciente add column if not exists vinculo_ultima_em timestamptz;
alter table public.contas_paciente add column if not exists vinculado_em timestamptz;
alter table public.contas_paciente add column if not exists vinculo_metodo text;
comment on column public.contas_paciente.vinculo_metodo is 'Como a conta foi ligada ao cadastro: vazio = pela conversa logada ou pela equipe; ''3 acertos'' / ''4 acertos'' = conta_paciente_vincular; ''atendente'' = decidido pela equipe.';

-- Avisos para o atendente. Só as funções abaixo (equipe) e conta_paciente_vincular escrevem/leem.
create table if not exists public.vinculo_solicitacoes (
  id bigint generated always as identity primary key,
  conta_id uuid not null references auth.users(id) on delete cascade,
  paciente_id uuid not null references public.pacientes(id) on delete cascade,
  tipo text not null check (tipo in ('verificar', 'atualizar', 'alterar')),   -- verificar: NÃO ligada, o atendente decide; atualizar: ligada (3 acertos ou CPF), o atendente confere; alterar: pedido de mudança de e-mail/telefone com CPF conferido
  batem text[] not null default '{}',
  diferem text[] not null default '{}',
  conta_nome text,        -- o que a pessoa digitou ao criar a conta (para o atendente comparar e atualizar)
  conta_telefone text,
  novo_email text,         -- só no tipo 'alterar'
  novo_telefone text,
  status text not null default 'aberta' check (status in ('aberta', 'vinculada', 'recusada', 'conferida', 'atualizada', 'desfeita', 'aplicada')),
  criado_em timestamptz not null default now(),
  decidido_em timestamptz,
  decidido_por uuid references auth.users(id) on delete set null
);
comment on table public.vinculo_solicitacoes is 'Fila do atendente: contas ligadas com 3 acertos ou CPF (conferir/atualizar), contas com só nome e nascimento (decidir se vincula) e pedidos de mudança de e-mail/telefone com CPF conferido (alterar). Uma linha aberta por conta e tipo.';
create index if not exists vinculo_solicitacoes_abertas on public.vinculo_solicitacoes (criado_em) where status = 'aberta';
alter table public.vinculo_solicitacoes add column if not exists conta_nome text;
alter table public.vinculo_solicitacoes add column if not exists conta_telefone text;
alter table public.vinculo_solicitacoes add column if not exists novo_email text;
alter table public.vinculo_solicitacoes add column if not exists novo_telefone text;
-- v1.2 (bancos criados pela v1.1): uma linha ABERTA por conta e tipo (antes: uma por conta), tipo "alterar" e status "aplicada".
alter table public.vinculo_solicitacoes drop constraint if exists vinculo_solicitacoes_conta_id_key;
alter table public.vinculo_solicitacoes drop constraint if exists vinculo_solicitacoes_tipo_check;
alter table public.vinculo_solicitacoes add constraint vinculo_solicitacoes_tipo_check check (tipo in ('verificar', 'atualizar', 'alterar'));
alter table public.vinculo_solicitacoes drop constraint if exists vinculo_solicitacoes_status_check;
alter table public.vinculo_solicitacoes add constraint vinculo_solicitacoes_status_check check (status in ('aberta', 'vinculada', 'recusada', 'conferida', 'atualizada', 'desfeita', 'aplicada'));
create unique index if not exists vinculo_solicitacoes_uma_aberta on public.vinculo_solicitacoes (conta_id, tipo) where status = 'aberta';
create index if not exists vinculo_solicitacoes_conta on public.vinculo_solicitacoes (conta_id);
alter table public.vinculo_solicitacoes enable row level security;
revoke all on table public.vinculo_solicitacoes from anon, authenticated;

create or replace function public.conta_paciente_vincular() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_cp record; v_u record; v_meta jsonb; v_dt date; v_nome text; v_tel text; v_res text;
  v_n int; v_pid uuid; v_t boolean; v_e boolean; v_batem text[]; v_diferem text[];
begin
  select * into v_cp from public.contas_paciente where id = v_uid for update;
  if v_uid is null or not found then raise exception 'Entre na sua conta para ligar o cadastro.' using errcode = '42501'; end if;
  if v_cp.paciente_id is not null then return jsonb_build_object('resultado', 'ja_vinculado'); end if;

  select u.email, u.email_confirmed_at, coalesce(u.raw_user_meta_data, '{}'::jsonb) as meta into v_u from auth.users u where u.id = v_uid;
  v_meta := v_u.meta;
  if nullif(btrim(coalesce(v_meta ->> 'dt_nasc', '')), '') is null then return jsonb_build_object('resultado', 'nada_pendente'); end if;
  -- sem e-mail confirmado nada é conferido nem apagado: a tentativa vale quando a pessoa confirmar
  if v_u.email_confirmed_at is null then return jsonb_build_object('resultado', 'email_nao_confirmado'); end if;

  -- limite: 5 tentativas por hora
  if v_cp.vinculo_ultima_em is null or v_cp.vinculo_ultima_em < now() - interval '1 hour' then v_cp.vinculo_tentativas := 0; end if;
  if v_cp.vinculo_tentativas >= 5 then
    update auth.users set raw_user_meta_data = raw_user_meta_data - 'dt_nasc' where id = v_uid;
    return jsonb_build_object('resultado', 'bloqueado');
  end if;
  update public.contas_paciente set vinculo_tentativas = v_cp.vinculo_tentativas + 1, vinculo_ultima_em = now() where id = v_uid;

  v_dt := public.data_ou_nula(v_meta ->> 'dt_nasc');
  v_nome := coalesce(nullif(btrim(v_meta ->> 'nome'), ''), v_cp.nome);
  v_tel := coalesce(nullif(btrim(v_meta ->> 'telefone'), ''), v_cp.telefone);
  v_res := 'nao_encontrado';

  -- nome completo (2+ palavras) e data de nascimento são obrigatórios
  if v_dt is not null and coalesce(cardinality(string_to_array(public.norm_nome(v_nome), ' ')), 0) >= 2 then
    select count(*), (array_agg(q.id))[1], (array_agg(q.t_ok))[1], (array_agg(q.e_ok))[1] into v_n, v_pid, v_t, v_e
      from (select p.id,
                   coalesce(public.fone_chave(v_tel) = any(p.telefones), false) as t_ok,
                   (p.email is not null and lower(btrim(p.email)) = lower(btrim(coalesce(v_u.email, '')))) as e_ok
              from public.pacientes p
             where not p.revisar and p.dt_nasc = v_dt and public.nome_confere(v_nome, p.nome)
               and not exists (select 1 from public.contas_paciente o where o.paciente_id = p.id and o.id <> v_uid)) q;

    if v_n = 1 then
      v_batem := array['nome', 'nascimento'] || case when v_t then array['telefone'] else '{}'::text[] end || case when v_e then array['email'] else '{}'::text[] end;
      v_diferem := case when v_t then '{}'::text[] else array['telefone'] end || case when v_e then '{}'::text[] else array['email'] end;
      if v_t or v_e then
        update public.contas_paciente set paciente_id = v_pid, vinculado_em = now(), vinculo_tentativas = 0,
               vinculo_metodo = case when v_t and v_e then '4 acertos' else '3 acertos' end where id = v_uid;
        v_res := case when v_t and v_e then 'vinculado' else 'vinculado_conferir' end;
        if v_res = 'vinculado_conferir' then
          insert into public.vinculo_solicitacoes (conta_id, paciente_id, tipo, batem, diferem, conta_nome, conta_telefone) values (v_uid, v_pid, 'atualizar', v_batem, v_diferem, v_nome, v_tel)
          on conflict (conta_id, tipo) where status = 'aberta' do update set paciente_id = excluded.paciente_id, batem = excluded.batem, diferem = excluded.diferem, conta_nome = excluded.conta_nome, conta_telefone = excluded.conta_telefone, criado_em = now();
        end if;
      else
        insert into public.vinculo_solicitacoes (conta_id, paciente_id, tipo, batem, diferem, conta_nome, conta_telefone) values (v_uid, v_pid, 'verificar', v_batem, v_diferem, v_nome, v_tel)
        on conflict (conta_id, tipo) where status = 'aberta' do update set paciente_id = excluded.paciente_id, batem = excluded.batem, diferem = excluded.diferem, conta_nome = excluded.conta_nome, conta_telefone = excluded.conta_telefone, criado_em = now();
        v_res := 'em_analise';
      end if;
    end if;
  end if;

  -- a data de nascimento digitada não fica guardada no login
  update auth.users set raw_user_meta_data = raw_user_meta_data - 'dt_nasc' where id = v_uid;
  return jsonb_build_object('resultado', v_res);
end $$;
revoke all on function public.conta_paciente_vincular() from public, anon;
grant execute on function public.conta_paciente_vincular() to authenticated;

-- VARIANTE MAIS ESTRITA (não aplicada): para só ligar sozinho quando o E-MAIL confirmado bate, troque "if v_t or v_e then" por "if v_e then";
-- quem bater só telefone passa a cair em "verificar" e o atendente decide.

-- CPF: só os 11 dígitos, e conferência dos dígitos verificadores (nunca guardado nem devolvido por estas funções).
create or replace function public.cpf_digitos(t text) returns text language sql immutable set search_path to '' as $$
  select nullif(regexp_replace(coalesce(t, ''), '\D', '', 'g'), '')
$$;
create or replace function public.cpf_valido(t text) returns boolean language plpgsql immutable set search_path to '' as $$
declare d text := public.cpf_digitos(t); soma int := 0; r int; i int;
begin
  if d is null or length(d) <> 11 or d ~ '^(\d)\1{10}$' then return false; end if;
  for i in 1..9 loop soma := soma + substr(d, i, 1)::int * (11 - i); end loop;
  r := (soma * 10) % 11; if r = 10 then r := 0; end if;
  if r <> substr(d, 10, 1)::int then return false; end if;
  soma := 0;
  for i in 1..10 loop soma := soma + substr(d, i, 1)::int * (12 - i); end loop;
  r := (soma * 10) % 11; if r = 10 then r := 0; end if;
  return r = substr(d, 11, 1)::int;
end $$;

-- O que a tela precisa saber para oferecer "confirmar com CPF" e "mudar e-mail ou telefone".
create or replace function public.conta_paciente_vinculo_estado() returns jsonb
language sql stable security definer set search_path to '' as $$
  select coalesce((select jsonb_build_object(
      'ligada', cp.paciente_id is not null,
      'verificar_aberto', exists (select 1 from public.vinculo_solicitacoes s where s.conta_id = cp.id and s.tipo = 'verificar' and s.status = 'aberta'),
      'alteracao_aberta', exists (select 1 from public.vinculo_solicitacoes s where s.conta_id = cp.id and s.tipo = 'alterar' and s.status = 'aberta'))
    from public.contas_paciente cp where cp.id = (select auth.uid())), jsonb_build_object('ligada', false, 'verificar_aberto', false, 'alteracao_aberta', false))
$$;

-- Conta que ficou em "só nome + nascimento" confirma com o CPF do cadastro: liga e abre o aviso "atualizar" para o atendente.
create or replace function public.conta_paciente_confirmar_cpf(p_cpf text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := (select auth.uid()); v_cp record; s record; p record;
begin
  select * into v_cp from public.contas_paciente where id = v_uid for update;
  if v_uid is null or not found then raise exception 'Entre na sua conta para confirmar com o CPF.' using errcode = '42501'; end if;
  if not public.cpf_valido(p_cpf) then raise exception 'Os números do CPF não conferem. Confira, por favor.' using errcode = '22023'; end if;
  if v_cp.paciente_id is not null then return jsonb_build_object('resultado', 'ja_vinculado'); end if;
  select * into s from public.vinculo_solicitacoes where conta_id = v_uid and tipo = 'verificar' and status = 'aberta' for update;
  if not found then return jsonb_build_object('resultado', 'sem_pedido'); end if;

  if v_cp.vinculo_ultima_em is null or v_cp.vinculo_ultima_em < now() - interval '1 hour' then v_cp.vinculo_tentativas := 0; end if;
  if v_cp.vinculo_tentativas >= 5 then return jsonb_build_object('resultado', 'bloqueado'); end if;
  update public.contas_paciente set vinculo_tentativas = v_cp.vinculo_tentativas + 1, vinculo_ultima_em = now() where id = v_uid;

  select * into p from public.pacientes where id = s.paciente_id and not revisar;
  if not found or exists (select 1 from public.contas_paciente o where o.paciente_id = p.id and o.id <> v_uid) then return jsonb_build_object('resultado', 'sem_pedido'); end if;
  if public.cpf_digitos(p.cpf) is null then return jsonb_build_object('resultado', 'cadastro_sem_cpf'); end if;
  if public.cpf_digitos(p.cpf) <> public.cpf_digitos(p_cpf) then return jsonb_build_object('resultado', 'cpf_nao_confere'); end if;

  update public.contas_paciente set paciente_id = p.id, vinculado_em = now(), vinculo_tentativas = 0, vinculo_metodo = 'cpf' where id = v_uid;
  update public.vinculo_solicitacoes set tipo = 'atualizar', batem = array_append(batem, 'cpf'), criado_em = now() where id = s.id;
  return jsonb_build_object('resultado', 'vinculado_conferir');
end $$;

-- Conta já ligada pede para mudar o e-mail e/ou o telefone do CADASTRO. Exige o CPF do cadastro; nada muda sozinho (o atendente aplica).
create or replace function public.conta_paciente_pedir_alteracao(p_cpf text, p_email text default null, p_telefone text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_uid uuid := (select auth.uid()); v_cp record; p record; v_email text := lower(btrim(coalesce(p_email, '')));
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); v_dif text[] := '{}';
begin
  select * into v_cp from public.contas_paciente where id = v_uid for update;
  if v_uid is null or not found then raise exception 'Entre na sua conta para pedir a mudança.' using errcode = '42501'; end if;
  if v_email = '' then v_email := null; end if;
  if v_tel = '' then v_tel := null; end if;
  if v_email is null and v_tel is null then raise exception 'Informe o e-mail ou o telefone novo.' using errcode = '22023'; end if;
  if v_email is not null and (v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 200) then raise exception 'Informe um e-mail válido.' using errcode = '22023'; end if;
  if v_tel is not null then
    if char_length(v_tel) in (12, 13) and left(v_tel, 2) = '55' then v_tel := substr(v_tel, 3); end if;
    if char_length(v_tel) not in (10, 11) then raise exception 'Informe um telefone válido com DDD.' using errcode = '22023'; end if;
  end if;
  if not public.cpf_valido(p_cpf) then raise exception 'Os números do CPF não conferem. Confira, por favor.' using errcode = '22023'; end if;
  if v_cp.paciente_id is null then return jsonb_build_object('resultado', 'sem_cadastro'); end if;

  if v_cp.vinculo_ultima_em is null or v_cp.vinculo_ultima_em < now() - interval '1 hour' then v_cp.vinculo_tentativas := 0; end if;
  if v_cp.vinculo_tentativas >= 5 then return jsonb_build_object('resultado', 'bloqueado'); end if;
  update public.contas_paciente set vinculo_tentativas = v_cp.vinculo_tentativas + 1, vinculo_ultima_em = now() where id = v_uid;

  select * into p from public.pacientes where id = v_cp.paciente_id;
  if not found then return jsonb_build_object('resultado', 'sem_cadastro'); end if;
  if public.cpf_digitos(p.cpf) is null then return jsonb_build_object('resultado', 'cadastro_sem_cpf'); end if;
  if public.cpf_digitos(p.cpf) <> public.cpf_digitos(p_cpf) then return jsonb_build_object('resultado', 'cpf_nao_confere'); end if;

  if v_email is not null and lower(btrim(coalesce(p.email, ''))) <> v_email then v_dif := array_append(v_dif, 'email'); else v_email := null; end if;
  if v_tel is not null and not (public.fone_chave(v_tel) = any(p.telefones)) then v_dif := array_append(v_dif, 'telefone'); else v_tel := null; end if;
  if cardinality(v_dif) = 0 then return jsonb_build_object('resultado', 'sem_mudanca'); end if;

  insert into public.vinculo_solicitacoes (conta_id, paciente_id, tipo, batem, diferem, conta_nome, conta_telefone, novo_email, novo_telefone)
  values (v_uid, p.id, 'alterar', array['cpf'], v_dif, v_cp.nome, v_cp.telefone, v_email, v_tel)
  on conflict (conta_id, tipo) where status = 'aberta' do update set paciente_id = excluded.paciente_id, diferem = excluded.diferem,
         novo_email = excluded.novo_email, novo_telefone = excluded.novo_telefone, criado_em = now();
  return jsonb_build_object('resultado', 'pedido_enviado');
end $$;
revoke all on function public.conta_paciente_confirmar_cpf(text), public.conta_paciente_pedir_alteracao(text, text, text), public.conta_paciente_vinculo_estado() from public, anon;
grant execute on function public.conta_paciente_confirmar_cpf(text), public.conta_paciente_pedir_alteracao(text, text, text), public.conta_paciente_vinculo_estado() to authenticated;
revoke all on function public.cpf_digitos(text), public.cpf_valido(text) from public, anon;
grant execute on function public.cpf_digitos(text), public.cpf_valido(text) to authenticated;

-- Fila do atendente (admin e atendente ativos).
create or replace function public.vinculo_listar() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê os vínculos.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'tipo', s.tipo, 'criado_em', s.criado_em, 'batem', s.batem, 'diferem', s.diferem,
      'conta', jsonb_build_object('email', cp.email, 'nome', coalesce(s.conta_nome, cp.nome), 'telefone', coalesce(s.conta_telefone, cp.telefone)),
      'novo', jsonb_build_object('email', s.novo_email, 'telefone', s.novo_telefone),
      'cadastro', jsonb_build_object('nome', p.nome, 'email', p.email, 'telefones', p.telefones, 'dt_nasc', p.dt_nasc, 'ultima_visita_em', p.ultima_visita_em))
      order by s.criado_em)
    from public.vinculo_solicitacoes s
    join public.contas_paciente cp on cp.id = s.conta_id
    join public.pacientes p on p.id = s.paciente_id
    where s.status = 'aberta'), '[]'::jsonb);
end $$;

-- Decisão do atendente. Ações por tipo:
--   verificar: vincular | vincular_atualizar | recusar        atualizar: conferido | atualizar | desfazer        alterar: aplicar | recusar
create or replace function public.vinculo_decidir(p_id bigint, p_acao text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record; cp record; v_novo text;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe decide vínculos.' using errcode = '42501'; end if;
  select * into s from public.vinculo_solicitacoes where id = p_id and status = 'aberta' for update;
  if not found then raise exception 'Este pedido já foi resolvido ou não existe.' using errcode = '22023'; end if;
  select * into cp from public.contas_paciente where id = s.conta_id for update;

  if p_acao not in ('vincular', 'vincular_atualizar', 'recusar', 'conferido', 'atualizar', 'desfazer', 'aplicar') then raise exception 'Ação desconhecida.' using errcode = '22023'; end if;
  if not ((s.tipo = 'verificar' and p_acao in ('vincular', 'vincular_atualizar', 'recusar'))
       or (s.tipo = 'atualizar' and p_acao in ('conferido', 'atualizar', 'desfazer'))
       or (s.tipo = 'alterar' and p_acao in ('aplicar', 'recusar'))) then
    raise exception 'Ação inválida para este tipo de pedido.' using errcode = '22023';
  end if;

  if p_acao in ('vincular', 'vincular_atualizar') then
    if exists (select 1 from public.contas_paciente o where o.paciente_id = s.paciente_id and o.id <> s.conta_id) then
      raise exception 'Este cadastro já está ligado a outra conta.' using errcode = '22023';
    end if;
    update public.contas_paciente set paciente_id = s.paciente_id, vinculado_em = now(), vinculo_metodo = 'atendente' where id = s.conta_id;
    v_novo := 'vinculada';
  elsif p_acao = 'recusar' then v_novo := 'recusada';
  elsif p_acao = 'conferido' then v_novo := 'conferida';
  elsif p_acao = 'atualizar' then v_novo := 'atualizada';
  elsif p_acao = 'aplicar' then v_novo := 'aplicada';
  else   -- desfazer
    update public.contas_paciente set paciente_id = null, vinculado_em = null, vinculo_metodo = null where id = s.conta_id and paciente_id = s.paciente_id;
    v_novo := 'desfeita';
  end if;

  if p_acao in ('vincular_atualizar', 'atualizar') then
    update public.pacientes p set
      email = case when 'email' = any(s.diferem) and nullif(btrim(coalesce(cp.email, '')), '') is not null then lower(btrim(cp.email)) else p.email end,
      telefones = case when 'telefone' = any(s.diferem) and public.fone_chave(coalesce(s.conta_telefone, cp.telefone)) is not null and not (public.fone_chave(coalesce(s.conta_telefone, cp.telefone)) = any(p.telefones))
                       then p.telefones || public.fone_chave(coalesce(s.conta_telefone, cp.telefone)) else p.telefones end,
      atualizado_em = now()
    where p.id = s.paciente_id;
  elsif p_acao = 'aplicar' then   -- o que o paciente pediu (com CPF conferido): e-mail novo troca; telefone novo entra junto com o antigo
    update public.pacientes p set
      email = coalesce(s.novo_email, p.email),
      telefones = case when s.novo_telefone is not null and public.fone_chave(s.novo_telefone) is not null and not (public.fone_chave(s.novo_telefone) = any(p.telefones))
                       then p.telefones || public.fone_chave(s.novo_telefone) else p.telefones end,
      atualizado_em = now()
    where p.id = s.paciente_id;
  end if;

  update public.vinculo_solicitacoes set status = v_novo, decidido_em = now(), decidido_por = (select auth.uid()) where id = s.id;
  return jsonb_build_object('ok', true, 'status', v_novo);
end $$;
revoke all on function public.vinculo_listar(), public.vinculo_decidir(bigint, text) from public, anon;
grant execute on function public.vinculo_listar(), public.vinculo_decidir(bigint, text) to authenticated;
