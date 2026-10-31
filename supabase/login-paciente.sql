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
