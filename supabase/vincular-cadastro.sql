-- FLUXOGRAMA: entrada (paciente cria a conta com nome completo, telefone, e-mail, data de nascimento e senha; confirma o e-mail; o chat chama conta_paciente_vincular com o JWT dele) -> validação (só conta de paciente logada; e-mail da conta CONFIRMADO; nome completo e data de nascimento obrigatórios; no máximo 5 tentativas por hora) -> lógica (acha UM cadastro livre e fora de revisão com nome e data de nascimento iguais; conta os acertos: nome + nascimento + telefone + e-mail; 4 acertos liga sozinho; 3 acertos liga sozinho e abre aviso "atualizar" para o atendente; só nome + nascimento NÃO liga e abre pedido "verificar" para o atendente decidir) -> saída (contas_paciente.paciente_id, vinculo_solicitacoes, resultado 'vinculado' / 'vinculado_conferir' / 'em_analise' / 'nao_encontrado' / 'bloqueado' / 'email_nao_confirmado' / 'nada_pendente' / 'ja_vinculado'; RPCs vinculo_listar e vinculo_decidir para a equipe)
-- Versão 1.1 — 31/10/2026 / Mudança: 3 acertos ligam sozinho com aviso ao atendente; menos de 3 vai para o atendente decidir (antes exigia os quatro)
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
--   5. No máximo 5 tentativas por hora por conta; cada cadastro de conta faz uma tentativa (a data digitada é apagada depois).
-- A resposta ao paciente não revela dado do cadastro: só se ligou, se está em análise ou se não achou.
-- ATENÇÃO: com 3 acertos o e-mail pode ser o que NÃO bateu (nome + nascimento + telefone). O telefone e a data de nascimento são fáceis de saber para quem conhece o paciente;
--   por isso o aviso ao atendente existe e o vínculo pode ser desfeito. Para exigir sempre o e-mail igual, ver o comentário "VARIANTE MAIS ESTRITA" abaixo.
-- ROLLBACK: drop function public.conta_paciente_vincular(), public.vinculo_listar(), public.vinculo_decidir(bigint, text); drop table public.vinculo_solicitacoes;
--   (as colunas novas em contas_paciente podem ficar; recriar a versão 1.0 pelo histórico do repositório). Nenhum comando destrutivo neste arquivo. Pode ser aplicado mais de uma vez.

alter table public.contas_paciente add column if not exists vinculo_tentativas int not null default 0;
alter table public.contas_paciente add column if not exists vinculo_ultima_em timestamptz;
alter table public.contas_paciente add column if not exists vinculado_em timestamptz;
alter table public.contas_paciente add column if not exists vinculo_metodo text;
comment on column public.contas_paciente.vinculo_metodo is 'Como a conta foi ligada ao cadastro: vazio = pela conversa logada ou pela equipe; ''3 acertos'' / ''4 acertos'' = conta_paciente_vincular; ''atendente'' = decidido pela equipe.';

-- Avisos para o atendente. Só as funções abaixo (equipe) e conta_paciente_vincular escrevem/leem.
create table if not exists public.vinculo_solicitacoes (
  id bigint generated always as identity primary key,
  conta_id uuid not null unique references auth.users(id) on delete cascade,
  paciente_id uuid not null references public.pacientes(id) on delete cascade,
  tipo text not null check (tipo in ('verificar', 'atualizar')),   -- verificar: NÃO ligada, o atendente decide; atualizar: ligada sozinha (3 acertos), o atendente confere
  batem text[] not null default '{}',
  diferem text[] not null default '{}',
  conta_nome text,        -- o que a pessoa digitou ao criar a conta (para o atendente comparar e atualizar)
  conta_telefone text,
  status text not null default 'aberta' check (status in ('aberta', 'vinculada', 'recusada', 'conferida', 'atualizada', 'desfeita')),
  criado_em timestamptz not null default now(),
  decidido_em timestamptz,
  decidido_por uuid references auth.users(id) on delete set null
);
comment on table public.vinculo_solicitacoes is 'Fila do atendente: contas de paciente ligadas com 3 acertos (conferir/atualizar) ou com só nome e nascimento (decidir se vincula). Uma linha por conta.';
create index if not exists vinculo_solicitacoes_abertas on public.vinculo_solicitacoes (criado_em) where status = 'aberta';
alter table public.vinculo_solicitacoes add column if not exists conta_nome text;
alter table public.vinculo_solicitacoes add column if not exists conta_telefone text;
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
          on conflict (conta_id) do update set paciente_id = excluded.paciente_id, tipo = 'atualizar', batem = excluded.batem, diferem = excluded.diferem, conta_nome = excluded.conta_nome, conta_telefone = excluded.conta_telefone,
                 status = 'aberta', criado_em = now(), decidido_em = null, decidido_por = null;
        end if;
      else
        insert into public.vinculo_solicitacoes (conta_id, paciente_id, tipo, batem, diferem, conta_nome, conta_telefone) values (v_uid, v_pid, 'verificar', v_batem, v_diferem, v_nome, v_tel)
        on conflict (conta_id) do update set paciente_id = excluded.paciente_id, tipo = 'verificar', batem = excluded.batem, diferem = excluded.diferem, conta_nome = excluded.conta_nome, conta_telefone = excluded.conta_telefone,
               status = 'aberta', criado_em = now(), decidido_em = null, decidido_por = null;
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

-- Fila do atendente (admin e atendente ativos).
create or replace function public.vinculo_listar() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê os vínculos.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'tipo', s.tipo, 'criado_em', s.criado_em, 'batem', s.batem, 'diferem', s.diferem,
      'conta', jsonb_build_object('email', cp.email, 'nome', coalesce(s.conta_nome, cp.nome), 'telefone', coalesce(s.conta_telefone, cp.telefone)),
      'cadastro', jsonb_build_object('nome', p.nome, 'email', p.email, 'telefones', p.telefones, 'dt_nasc', p.dt_nasc, 'ultima_visita_em', p.ultima_visita_em))
      order by s.criado_em)
    from public.vinculo_solicitacoes s
    join public.contas_paciente cp on cp.id = s.conta_id
    join auth.users u on u.id = s.conta_id
    join public.pacientes p on p.id = s.paciente_id
    where s.status = 'aberta'), '[]'::jsonb);
end $$;

-- Decisão do atendente. Ações:  vincular | vincular_atualizar | recusar   (pedido "verificar")
--                               conferido | atualizar | desfazer          (aviso "atualizar", conta já ligada)
create or replace function public.vinculo_decidir(p_id bigint, p_acao text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record; cp record; v_novo text;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe decide vínculos.' using errcode = '42501'; end if;
  select * into s from public.vinculo_solicitacoes where id = p_id and status = 'aberta' for update;
  if not found then raise exception 'Este pedido já foi resolvido ou não existe.' using errcode = '22023'; end if;
  select * into cp from public.contas_paciente where id = s.conta_id for update;

  if p_acao in ('vincular', 'vincular_atualizar', 'recusar') and s.tipo <> 'verificar' then raise exception 'Ação inválida para este aviso.' using errcode = '22023'; end if;
  if p_acao in ('conferido', 'atualizar', 'desfazer') and s.tipo <> 'atualizar' then raise exception 'Ação inválida para este pedido.' using errcode = '22023'; end if;

  if p_acao in ('vincular', 'vincular_atualizar') then
    if exists (select 1 from public.contas_paciente o where o.paciente_id = s.paciente_id and o.id <> s.conta_id) then
      raise exception 'Este cadastro já está ligado a outra conta.' using errcode = '22023';
    end if;
    update public.contas_paciente set paciente_id = s.paciente_id, vinculado_em = now(), vinculo_metodo = 'atendente' where id = s.conta_id;
    v_novo := 'vinculada';
  elsif p_acao = 'recusar' then v_novo := 'recusada';
  elsif p_acao = 'conferido' then v_novo := 'conferida';
  elsif p_acao = 'atualizar' then v_novo := 'atualizada';
  elsif p_acao = 'desfazer' then
    update public.contas_paciente set paciente_id = null, vinculado_em = null, vinculo_metodo = null where id = s.conta_id and paciente_id = s.paciente_id;
    v_novo := 'desfeita';
  else raise exception 'Ação desconhecida.' using errcode = '22023';
  end if;

  if p_acao in ('vincular_atualizar', 'atualizar') then
    update public.pacientes p set
      email = case when 'email' = any(s.diferem) and nullif(btrim(coalesce(cp.email, '')), '') is not null then lower(btrim(cp.email)) else p.email end,
      telefones = case when 'telefone' = any(s.diferem) and public.fone_chave(coalesce(s.conta_telefone, cp.telefone)) is not null and not (public.fone_chave(coalesce(s.conta_telefone, cp.telefone)) = any(p.telefones))
                       then p.telefones || public.fone_chave(coalesce(s.conta_telefone, cp.telefone)) else p.telefones end,
      atualizado_em = now()
    where p.id = s.paciente_id;
  end if;

  update public.vinculo_solicitacoes set status = v_novo, decidido_em = now(), decidido_por = (select auth.uid()) where id = s.id;
  return jsonb_build_object('ok', true, 'status', v_novo);
end $$;
revoke all on function public.vinculo_listar(), public.vinculo_decidir(bigint, text) from public, anon;
grant execute on function public.vinculo_listar(), public.vinculo_decidir(bigint, text) to authenticated;
