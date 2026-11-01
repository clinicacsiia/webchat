-- FLUXOGRAMA: entrada (conversas do chat: nome, telefone, e-mail, data de nascimento e conta de login de cada uma; pré-agendamentos "agendado") -> validação (o nome TEM de bater e mais duas informações iguais, nenhuma contradizendo; menos que isso vira sugestão que a equipe confirma) -> lógica (junta as conversas da mesma pessoa em um grupo, SEM apagar nem mover mensagem; exame marcado fica "em aberto" até alguém fechar; falta pode virar remarcação pelo chat) -> saída (conversa_grupo, agendamento_fechamento, views v_agendamento_aberto e v_remarcacao_pendente, RPCs da equipe e passos novos do motor)
-- Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
--
-- NÃO FOI APLICADO NO SUPABASE. Aplicar só depois de ler o docs/pessoa-unica.md (seção "Como ligar").
-- Ordem: depois de pacientes.sql, fase7-motor.sql, correcao-convenio-quem-volta.sql, assuntos-resolvidos.sql e login-paciente.sql.
-- Nenhum comando destrutivo. Pode ser aplicado mais de uma vez. Cada trecho trocado nas funções do motor tem de aparecer UMA vez; senão o arquivo para sem alterar nada.
--
-- REGRAS
--  1. Agrupar: duas conversas são da mesma pessoa quando o NOME confere (nome_confere) e pelo menos DUAS destas informações também batem:
--     telefone, e-mail, data de nascimento, conta de login. Ou seja, 3 informações no total, contando o nome.
--     Contradição (nascimentos diferentes, contas de login diferentes, "para mim" contra "para meu filho") impede o grupo, mesmo com 3 batendo.
--     Com só 2 (nome + telefone, por exemplo) o painel mostra a sugestão "Parece a mesma pessoa" e um atendente confirma. A confirmação fica registrada.
--     Filho e responsável nunca se juntam: o nome comparado é o do PACIENTE (paciente_nome, se for atendimento para o filho).
--  2. Nada é apagado nem movido. O grupo é só uma ligação (conversa_grupo). "Separar" desfaz e impede que o robô junte de novo.
--  3. A resposta da equipe vai para a conversa onde o paciente escreveu por último (é a que o aparelho dele está lendo).
--  4. Exame marcado (pré-agendamento "agendado") fica EM ABERTO até a equipe ou o paciente (pelo chat) registrar o desfecho:
--     compareceu, faltou, cancelou ou remarcou. Encerrar a conversa com exame em aberto é recusado para quem usa o painel.
--  5. Falta: a equipe pode remarcar por fora, ou pedir ao paciente que remarque pelo chat. O paciente toca "Sim, remarcar agora" e segue sozinho
--     (convênio > calendário > dados > confirmação). O pedido é copiado quando dá; senão ele escolhe o exame de novo.
--
-- ROLLBACK: drop trigger pessoa_agrupar_conversa on public.conversas; drop trigger pessoa_agrupar_pre on public.pre_agendamentos;
--   drop trigger conversa_exame_aberto on public.conversas; select cron.unschedule('pessoa-agrupar');
--   (tabelas, views e funções novas podem ficar; os passos novos do motor só rodam quando uma pessoa da equipe usa "Perguntar ao paciente".)

create or replace function pg_temp.remendar(p_funcao regprocedure, p_marca text, p_de text[], p_para text[]) returns text
language plpgsql as $$
declare d text; d2 text; i int; n int;
begin
  d := pg_get_functiondef(p_funcao);
  if position(p_marca in d) > 0 then return 'já aplicado: ' || p_funcao::text; end if;
  d2 := d;
  for i in 1 .. array_length(p_de, 1) loop
    n := (length(d2) - length(replace(d2, p_de[i], ''))) / length(p_de[i]);
    if n <> 1 then
      raise exception '% : o trecho % aparece % vez(es); nada foi alterado.', p_funcao::text, i, n;
    end if;
    d2 := replace(d2, p_de[i], p_para[i]);
  end loop;
  execute d2;
  return 'aplicado: ' || p_funcao::text;
end $$;

-- ======================================================================
-- 1. Tabelas
-- ======================================================================
create table if not exists public.conversa_grupo (
  conversa_id uuid primary key references public.conversas(id) on delete cascade,
  grupo_id uuid not null,
  sinais text[] not null default '{}',
  origem text not null default 'auto' check (origem in ('auto', 'equipe')),
  confirmado_por uuid references public.agentes(id) on delete set null,
  criado_em timestamptz not null default now()
);
comment on table public.conversa_grupo is 'Conversas da mesma pessoa. Só uma ligação: nenhuma mensagem é movida ou apagada. origem = auto (3 informações batem) ou equipe (um atendente confirmou).';
create index if not exists conversa_grupo_grupo on public.conversa_grupo (grupo_id);

create table if not exists public.conversa_grupo_recusa (
  a uuid not null references public.conversas(id) on delete cascade,
  b uuid not null references public.conversas(id) on delete cascade,
  por uuid references public.agentes(id) on delete set null,
  em timestamptz not null default now(),
  primary key (a, b),
  check (a < b)
);
comment on table public.conversa_grupo_recusa is 'Pares que a equipe disse que NÃO são a mesma pessoa. O agrupamento automático nunca junta esses pares.';

create table if not exists public.agendamento_fechamento (
  id bigint generated always as identity primary key,
  pre_id uuid references public.pre_agendamentos(id) on delete set null,
  conversa_id uuid not null references public.conversas(id) on delete cascade,
  chave text not null unique,                 -- pre_id|data-hora: identifica ESTA marcação (a mesma conversa pode ter outra depois)
  exames text, quando timestamp,
  desfecho text not null check (desfecho in ('compareceu', 'faltou', 'cancelou', 'remarcou')),
  origem text not null check (origem in ('equipe', 'paciente', 'klingo')),
  por uuid references public.agentes(id) on delete set null,
  nota text,
  remarcacao text check (remarcacao in ('pendente', 'pedida', 'aceita', 'recusada', 'feita')),
  remarcacao_conversa uuid references public.conversas(id) on delete set null,
  fechado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
comment on table public.agendamento_fechamento is 'Desfecho de cada exame marcado pelo chat. Sem linha aqui, a marcação está EM ABERTO. remarcacao acompanha a falta: pendente > pedida (pergunta enviada) > aceita (paciente está remarcando) > feita, ou recusada.';
create index if not exists agendamento_fechamento_conversa on public.agendamento_fechamento (conversa_id);

alter table public.conversa_grupo enable row level security;
alter table public.conversa_grupo_recusa enable row level security;
alter table public.agendamento_fechamento enable row level security;
revoke all on table public.conversa_grupo, public.conversa_grupo_recusa, public.agendamento_fechamento from anon, authenticated;
grant select on table public.conversa_grupo, public.agendamento_fechamento to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversa_grupo' and policyname = 'conversa_grupo_select') then
    create policy conversa_grupo_select on public.conversa_grupo for select using ((select public.papel_atual()) = any (array['admin','atendente']));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'agendamento_fechamento' and policyname = 'agendamento_fechamento_select') then
    create policy agendamento_fechamento_select on public.agendamento_fechamento for select using ((select public.papel_atual()) = any (array['admin','atendente']));
  end if;
end $$;

-- ======================================================================
-- 2. As informações de cada conversa e a comparação entre duas
-- ======================================================================
create or replace function public.pessoa_ficha(p_conversa uuid) returns jsonb
language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'nome', case when c.paciente_tipo = 'filho' then coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), nullif(btrim(c.paciente_nome), ''))
                 else coalesce(nullif(btrim(c.nome_informado), ''), nullif(btrim(ct.nome), '')) end,
    'tipo', coalesce(c.paciente_tipo, 'proprio'),
    'fone', public.fone_chave(ct.telefone),
    'email', lower(nullif(btrim(coalesce(nullif(btrim(c.email_informado), ''), ct.email)), '')),
    'nasc', public.data_ou_nula(pa.paciente ->> 'dt_nasc'),
    'conta', c.conta_id)
  from public.conversas c join public.contatos ct on ct.id = c.contato_id
  left join public.pre_agendamentos pa on pa.conversa_id = c.id
  where c.id = p_conversa
$$;
revoke all on function public.pessoa_ficha(uuid) from public, anon, authenticated;

create or replace function public.pessoa_sinais(p_a uuid, p_b uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare a jsonb := public.pessoa_ficha(p_a); b jsonb := public.pessoa_ficha(p_b); s text[] := '{}'; k text[] := '{}';
begin
  if a is null or b is null or not public.nome_confere(a ->> 'nome', b ->> 'nome') then
    return jsonb_build_object('nome', false, 'sinais', '[]'::jsonb, 'conflitos', '[]'::jsonb, 'total', 0);
  end if;
  s := array['nome'];
  if a ->> 'fone' is not null and a ->> 'fone' = b ->> 'fone' then s := array_append(s, 'telefone'::text); end if;
  if a ->> 'email' is not null and a ->> 'email' = b ->> 'email' then s := array_append(s, 'email'::text); end if;
  if a ->> 'nasc' is not null and a ->> 'nasc' = b ->> 'nasc' then s := array_append(s, 'nascimento'::text); end if;
  if a ->> 'conta' is not null and a ->> 'conta' = b ->> 'conta' then s := array_append(s, 'conta'::text); end if;
  if a ->> 'nasc' is not null and b ->> 'nasc' is not null and a ->> 'nasc' <> b ->> 'nasc' then k := array_append(k, 'nascimento'::text); end if;
  if a ->> 'conta' is not null and b ->> 'conta' is not null and a ->> 'conta' <> b ->> 'conta' then k := array_append(k, 'conta'::text); end if;
  if a ->> 'tipo' <> b ->> 'tipo' then k := array_append(k, 'tipo'::text); end if;
  return jsonb_build_object('nome', true, 'sinais', to_jsonb(s), 'conflitos', to_jsonb(k), 'total', cardinality(s));
end $$;
revoke all on function public.pessoa_sinais(uuid, uuid) from public, anon, authenticated;

-- ======================================================================
-- 3. Agrupar sozinho (3 informações) — chamado quando a conversa nasce ou muda, e por uma rotina que confere o que ficou de fora
-- ======================================================================
create or replace function public.pessoa_agrupar(p_conversa uuid) returns integer
language plpgsql security definer set search_path to '' as $$
declare
  f jsonb := public.pessoa_ficha(p_conversa); r record; v_grupo uuid; v_n integer := 0; v_choca boolean; v_choques uuid[]; v_resto integer;
begin
  if f is null or f ->> 'nome' is null then return 0; end if;
  select grupo_id into v_grupo from public.conversa_grupo where conversa_id = p_conversa;
  -- Uma informação que chega DEPOIS (a data de nascimento, por exemplo) pode contradizer o grupo: se isso acontecer, a conversa sai e o par fica recusado.
  if v_grupo is not null and (select origem from public.conversa_grupo where conversa_id = p_conversa) = 'auto' then
    v_choques := array(select g.conversa_id from public.conversa_grupo g where g.grupo_id = v_grupo and g.conversa_id <> p_conversa
                        and jsonb_array_length(public.pessoa_sinais(p_conversa, g.conversa_id) -> 'conflitos') > 0);
    if cardinality(v_choques) > 0 then
      insert into public.conversa_grupo_recusa (a, b) select least(p_conversa, x), greatest(p_conversa, x) from unnest(v_choques) x on conflict do nothing;
      delete from public.conversa_grupo where conversa_id = p_conversa;
      select count(*) into v_resto from public.conversa_grupo where grupo_id = v_grupo;
      if v_resto < 2 then delete from public.conversa_grupo where grupo_id = v_grupo; end if;
      v_grupo := null;
    end if;
  end if;
  -- Candidatas: dividem telefone, e-mail, conta ou nascimento. O nome sozinho nunca basta.
  for r in
    select c2.id, g.grupo_id as grupo, public.pessoa_sinais(p_conversa, c2.id) as s
    from public.conversas c2
    join public.contatos ct2 on ct2.id = c2.contato_id
    left join public.pre_agendamentos pa2 on pa2.conversa_id = c2.id
    left join public.conversa_grupo g on g.conversa_id = c2.id
    where c2.id <> p_conversa
      and (v_grupo is null or g.grupo_id is distinct from v_grupo)
      and (public.fone_chave(ct2.telefone) = f ->> 'fone'
           or lower(nullif(btrim(coalesce(nullif(btrim(c2.email_informado), ''), ct2.email)), '')) = f ->> 'email'
           or (f ->> 'conta' is not null and c2.conta_id::text = f ->> 'conta')
           or (f ->> 'nasc' is not null and public.data_ou_nula(pa2.paciente ->> 'dt_nasc')::text = f ->> 'nasc'))
      and not exists (select 1 from public.conversa_grupo_recusa x where x.a = least(p_conversa, c2.id) and x.b = greatest(p_conversa, c2.id))
    order by c2.atualizado_em desc
  loop
    if (r.s ->> 'total')::int < 3 or jsonb_array_length(r.s -> 'conflitos') > 0 then continue; end if;
    if r.grupo is not null and v_grupo is not null then continue; end if;   -- dois grupos que já existem: só a equipe junta
    -- A candidata (ou o grupo dela) não pode contradizer esta conversa em nenhum membro.
    select exists (select 1 from public.conversa_grupo m
                    where m.grupo_id = coalesce(r.grupo, v_grupo) and m.conversa_id <> p_conversa
                      and jsonb_array_length(public.pessoa_sinais(p_conversa, m.conversa_id) -> 'conflitos') > 0)
      into v_choca;
    if v_choca then continue; end if;
    if v_grupo is null then
      v_grupo := coalesce(r.grupo, gen_random_uuid());
      insert into public.conversa_grupo (conversa_id, grupo_id, sinais, origem) values (p_conversa, v_grupo, array(select jsonb_array_elements_text(r.s -> 'sinais')), 'auto')
        on conflict (conversa_id) do nothing;
      v_n := v_n + 1;
    end if;
    if r.grupo is null then
      insert into public.conversa_grupo (conversa_id, grupo_id, sinais, origem) values (r.id, v_grupo, array(select jsonb_array_elements_text(r.s -> 'sinais')), 'auto')
        on conflict (conversa_id) do nothing;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;
revoke all on function public.pessoa_agrupar(uuid) from public, anon, authenticated;
grant execute on function public.pessoa_agrupar(uuid) to service_role;

-- Rotina de conferência: conversas que ainda não entraram em nenhum grupo (o e-mail ou a data de nascimento pode ter chegado depois).
create or replace function public.pessoa_agrupar_pendentes() returns integer
language plpgsql security definer set search_path to '' as $$
declare r record; v_n integer := 0;
begin
  for r in select c.id from public.conversas c
            where not exists (select 1 from public.conversa_grupo g where g.conversa_id = c.id) and c.criado_em > now() - interval '120 days'
            order by c.criado_em limit 500 loop
    begin v_n := v_n + public.pessoa_agrupar(r.id); exception when others then null; end;
  end loop;
  return v_n;
end $$;
revoke all on function public.pessoa_agrupar_pendentes() from public, anon, authenticated;
grant execute on function public.pessoa_agrupar_pendentes() to service_role;

-- Gatilhos: NUNCA podem atrapalhar o chat do paciente; qualquer erro é engolido.
create or replace function public.pessoa_agrupar_conversa_trg() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  begin perform public.pessoa_agrupar(new.id); exception when others then null; end;
  return null;
end $$;
create or replace function public.pessoa_agrupar_pre_trg() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if tg_op = 'INSERT' or (new.paciente ->> 'dt_nasc') is distinct from (old.paciente ->> 'dt_nasc') or (new.paciente ->> 'nome') is distinct from (old.paciente ->> 'nome') then
    begin perform public.pessoa_agrupar(new.conversa_id); exception when others then null; end;
  end if;
  return null;
end $$;
revoke all on function public.pessoa_agrupar_conversa_trg(), public.pessoa_agrupar_pre_trg() from public, anon, authenticated;
create or replace trigger pessoa_agrupar_conversa after insert or update of nome_informado, email_informado, paciente_nome, conta_id on public.conversas
  for each row execute function public.pessoa_agrupar_conversa_trg();
create or replace trigger pessoa_agrupar_pre after insert or update of paciente on public.pre_agendamentos
  for each row execute function public.pessoa_agrupar_pre_trg();

-- ======================================================================
-- 4. O que a equipe faz: sugestões, confirmar, recusar, separar
-- ======================================================================
create or replace function public.pessoa_equipe() returns void language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só administrador e atendente.' using errcode = '42501'; end if;
end $$;
revoke all on function public.pessoa_equipe() from public, anon;
grant execute on function public.pessoa_equipe() to authenticated;

-- Pares com nome + UMA outra informação (2 de 3): a equipe confirma ou recusa.
create or replace function public.pessoa_sugestoes() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_out jsonb;
begin
  perform public.pessoa_equipe();
  with f as materialized (
    select c.id, public.pessoa_ficha(c.id) as j, c.atualizado_em from public.conversas c where c.criado_em > now() - interval '120 days'
  ), par as (
    select a.id as a, b.id as b from f a join f b on a.id < b.id and a.j ->> 'fone' = b.j ->> 'fone' and a.j ->> 'fone' is not null
    union select a.id, b.id from f a join f b on a.id < b.id and a.j ->> 'email' = b.j ->> 'email' and a.j ->> 'email' is not null
    union select a.id, b.id from f a join f b on a.id < b.id and a.j ->> 'conta' = b.j ->> 'conta' and a.j ->> 'conta' is not null
    union select a.id, b.id from f a join f b on a.id < b.id and a.j ->> 'nasc' = b.j ->> 'nasc' and a.j ->> 'nasc' is not null
  ), cand as (
    select p.a, p.b, public.pessoa_sinais(p.a, p.b) as s from par p
    where not exists (select 1 from public.conversa_grupo ga join public.conversa_grupo gb on gb.grupo_id = ga.grupo_id where ga.conversa_id = p.a and gb.conversa_id = p.b)
      and not exists (select 1 from public.conversa_grupo_recusa x where x.a = p.a and x.b = p.b)
  )
  select coalesce(jsonb_agg(jsonb_build_object('a', c.a, 'b', c.b, 'nome_a', fa.j ->> 'nome', 'nome_b', fb.j ->> 'nome', 'sinais', c.s -> 'sinais', 'total', c.s -> 'total') order by greatest(fa.atualizado_em, fb.atualizado_em) desc), '[]'::jsonb)
    into v_out
  from cand c join f fa on fa.id = c.a join f fb on fb.id = c.b
  where (c.s ->> 'total')::int = 2 and jsonb_array_length(c.s -> 'conflitos') = 0;
  return v_out;
end $$;
revoke all on function public.pessoa_sugestoes() from public, anon;
grant execute on function public.pessoa_sugestoes() to authenticated;

-- Um atendente confirma que são a mesma pessoa: é a terceira informação. Se houver contradição, recusa.
create or replace function public.pessoa_confirmar(p_a uuid, p_b uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s jsonb; ga uuid; gb uuid; v_grupo uuid; m1 record; m2 record; v_eu uuid := (select auth.uid());
begin
  perform public.pessoa_equipe();
  if p_a is null or p_b is null or p_a = p_b then raise exception 'Escolha duas conversas diferentes.' using errcode = '22023'; end if;
  s := public.pessoa_sinais(p_a, p_b);
  if not (s ->> 'nome')::boolean then raise exception 'Os nomes não conferem.' using errcode = '22023'; end if;
  if jsonb_array_length(s -> 'conflitos') > 0 then raise exception 'Estas conversas se contradizem (%).', (s -> 'conflitos') #>> '{}' using errcode = '22023'; end if;
  select grupo_id into ga from public.conversa_grupo where conversa_id = p_a;
  select grupo_id into gb from public.conversa_grupo where conversa_id = p_b;
  -- Ao juntar dois grupos, nenhum membro de um pode contradizer um membro do outro.
  for m1 in select conversa_id from public.conversa_grupo where ga is not null and grupo_id = ga loop
    for m2 in select conversa_id from public.conversa_grupo where gb is not null and grupo_id = gb loop
      if jsonb_array_length(public.pessoa_sinais(m1.conversa_id, m2.conversa_id) -> 'conflitos') > 0 then
        raise exception 'Os grupos se contradizem; separe antes de juntar.' using errcode = '22023';
      end if;
    end loop;
  end loop;
  v_grupo := coalesce(ga, gb, gen_random_uuid());
  if gb is not null and ga is not null then update public.conversa_grupo set grupo_id = v_grupo where grupo_id = gb; end if;
  insert into public.conversa_grupo (conversa_id, grupo_id, sinais, origem, confirmado_por)
  values (p_a, v_grupo, array(select jsonb_array_elements_text(s -> 'sinais')), 'equipe', v_eu),
         (p_b, v_grupo, array(select jsonb_array_elements_text(s -> 'sinais')), 'equipe', v_eu)
  on conflict (conversa_id) do update set grupo_id = excluded.grupo_id, origem = 'equipe', confirmado_por = excluded.confirmado_por
    where public.conversa_grupo.grupo_id is distinct from excluded.grupo_id;
  delete from public.conversa_grupo_recusa where a = least(p_a, p_b) and b = greatest(p_a, p_b);
  return jsonb_build_object('ok', true, 'grupo_id', v_grupo);
end $$;
revoke all on function public.pessoa_confirmar(uuid, uuid) from public, anon;
grant execute on function public.pessoa_confirmar(uuid, uuid) to authenticated;

create or replace function public.pessoa_recusar(p_a uuid, p_b uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  perform public.pessoa_equipe();
  if p_a is null or p_b is null or p_a = p_b then raise exception 'Escolha duas conversas diferentes.' using errcode = '22023'; end if;
  insert into public.conversa_grupo_recusa (a, b, por) values (least(p_a, p_b), greatest(p_a, p_b), (select auth.uid())) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.pessoa_recusar(uuid, uuid) from public, anon;
grant execute on function public.pessoa_recusar(uuid, uuid) to authenticated;

-- Tira UMA conversa do grupo e impede o robô de juntar de novo com as outras. Se sobrar só uma, o grupo acaba.
create or replace function public.pessoa_separar(p_conversa uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare g uuid; r record; v_resto integer;
begin
  perform public.pessoa_equipe();
  select grupo_id into g from public.conversa_grupo where conversa_id = p_conversa;
  if g is null then return jsonb_build_object('ok', true, 'separada', false); end if;
  for r in select conversa_id from public.conversa_grupo where grupo_id = g and conversa_id <> p_conversa loop
    insert into public.conversa_grupo_recusa (a, b, por) values (least(p_conversa, r.conversa_id), greatest(p_conversa, r.conversa_id), (select auth.uid())) on conflict do nothing;
  end loop;
  delete from public.conversa_grupo where conversa_id = p_conversa;
  select count(*) into v_resto from public.conversa_grupo where grupo_id = g;
  if v_resto < 2 then delete from public.conversa_grupo where grupo_id = g; end if;
  return jsonb_build_object('ok', true, 'separada', true);
end $$;
revoke all on function public.pessoa_separar(uuid) from public, anon;
grant execute on function public.pessoa_separar(uuid) to authenticated;

-- Todas as conversas do grupo de uma conversa (ela mesma, se estiver sozinha), da mais recente para a mais antiga.
create or replace function public.pessoa_membros(p_conversa uuid) returns uuid[]
language sql stable security definer set search_path to '' as $$
  select coalesce((select array_agg(c.id order by c.atualizado_em desc) from public.conversa_grupo g join public.conversas c on c.id = g.conversa_id
                    where g.grupo_id = (select grupo_id from public.conversa_grupo where conversa_id = p_conversa)), array[p_conversa])
$$;
revoke all on function public.pessoa_membros(uuid) from public, anon, authenticated;

-- ======================================================================
-- 5. Exame marcado fica em aberto até alguém fechar
-- ======================================================================
create or replace view public.v_agendamento_aberto with (security_invoker = on) as
with b as (
  select pa.id as pre_id, pa.conversa_id, pa.plano, pa.unidade,
         (select min((e ->> 'data')::date + (e ->> 'hora')::time) from jsonb_array_elements(case when jsonb_typeof(pa.escolha_horario) = 'array' then pa.escolha_horario else '[]'::jsonb end) e) as quando,
         (select string_agg(coalesce(nullif(i.procedimento, ''), i.modalidade), ' + ' order by i.id) from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo) as exames
    from public.pre_agendamentos pa where pa.status = 'agendado'
), k as (
  select b.*, b.pre_id::text || '|' || coalesce(to_char(b.quando, 'YYYY-MM-DD"T"HH24:MI'), '') as chave from b
)
select k.pre_id, k.conversa_id, k.chave, k.quando, k.exames, k.plano, k.unidade,
       coalesce(k.quando < (now() at time zone 'America/Bahia'), false) as passou
  from k where not exists (select 1 from public.agendamento_fechamento f where f.chave = k.chave);
comment on view public.v_agendamento_aberto is 'Exames marcados pelo chat que ninguém fechou ainda (compareceu, faltou, cancelou, remarcou). passou = o horário já ficou para trás.';

create or replace view public.v_remarcacao_pendente with (security_invoker = on) as
select f.id as fechamento_id, f.conversa_id, f.exames, f.quando, f.desfecho, f.remarcacao, f.remarcacao_conversa, f.origem, f.fechado_em
  from public.agendamento_fechamento f
 where f.desfecho in ('faltou', 'remarcou') and f.remarcacao in ('pendente', 'pedida', 'aceita');
comment on view public.v_remarcacao_pendente is 'Faltas (ou remarcações pedidas) em que ainda falta marcar o novo horário.';
grant select on public.v_agendamento_aberto, public.v_remarcacao_pendente to authenticated;

-- Registra o desfecho (uso interno: equipe, motor do chat e rotinas).
create or replace function public.agendamento_fechar_interno(p_conversa uuid, p_desfecho text, p_origem text, p_por uuid, p_nota text default null) returns bigint
language plpgsql security definer set search_path to '' as $$
declare a record; v_id bigint;
begin
  if p_desfecho not in ('compareceu', 'faltou', 'cancelou', 'remarcou') then raise exception 'Desfecho inválido.' using errcode = '22023'; end if;
  select * into a from public.v_agendamento_aberto where conversa_id = p_conversa order by quando nulls last limit 1;
  if not found then return null; end if;
  insert into public.agendamento_fechamento (pre_id, conversa_id, chave, exames, quando, desfecho, origem, por, nota, remarcacao)
  values (a.pre_id, p_conversa, a.chave, a.exames, a.quando, p_desfecho, p_origem, p_por, left(p_nota, 500), case when p_desfecho = 'faltou' then 'pendente' end)
  on conflict (chave) do nothing returning id into v_id;
  return v_id;
end $$;
revoke all on function public.agendamento_fechar_interno(uuid, text, text, uuid, text) from public, anon, authenticated;

create or replace function public.agendamento_fechar(p_conversa uuid, p_desfecho text, p_nota text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_id bigint;
begin
  perform public.pessoa_equipe();
  v_id := public.agendamento_fechar_interno(p_conversa, p_desfecho, 'equipe', (select auth.uid()), p_nota);
  if v_id is null then raise exception 'Não há exame em aberto nesta conversa.' using errcode = '22023'; end if;
  return jsonb_build_object('ok', true, 'fechamento_id', v_id);
end $$;
revoke all on function public.agendamento_fechar(uuid, text, text) from public, anon;
grant execute on function public.agendamento_fechar(uuid, text, text) to authenticated;

-- A equipe diz como terminou a remarcação: feita (o novo horário já foi marcado) ou recusada (o paciente desistiu).
create or replace function public.agendamento_remarcacao_resolver(p_fechamento bigint, p_resultado text, p_nota text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  perform public.pessoa_equipe();
  if p_resultado not in ('feita', 'recusada') then raise exception 'Resultado inválido.' using errcode = '22023'; end if;
  update public.agendamento_fechamento set remarcacao = p_resultado, atualizado_em = now(), nota = coalesce(nullif(left(p_nota, 500), ''), nota)
   where id = p_fechamento and remarcacao in ('pendente', 'pedida', 'aceita');
  if not found then raise exception 'Esta remarcação já foi resolvida.' using errcode = '22023'; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.agendamento_remarcacao_resolver(bigint, text, text) from public, anon;
grant execute on function public.agendamento_remarcacao_resolver(bigint, text, text) to authenticated;

-- Quando o novo pré-agendamento do paciente vira "agendado", a remarcação aceita no chat está feita.
create or replace function public.agendamento_remarcacao_feita_trg() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.status = 'agendado' and old.status is distinct from 'agendado' then
    update public.agendamento_fechamento set remarcacao = 'feita', atualizado_em = now()
     where remarcacao = 'aceita' and remarcacao_conversa = new.conversa_id;
  end if;
  return new;
end $$;
revoke all on function public.agendamento_remarcacao_feita_trg() from public, anon, authenticated;
create or replace trigger agendamento_remarcacao_feita after update of status on public.pre_agendamentos
  for each row execute function public.agendamento_remarcacao_feita_trg();

-- Encerrar a conversa com exame em aberto: recusado para quem usa o painel (o sistema e o motor não são barrados).
create or replace function public.conversa_exame_aberto_trg() returns trigger language plpgsql security definer set search_path to '' as $$
declare v_n integer;
begin
  if new.status = 'encerrada' and old.status is distinct from 'encerrada' and coalesce((select public.papel_atual()), '') <> '' then
    select count(*) into v_n from public.v_agendamento_aberto v where v.conversa_id = any (public.pessoa_membros(new.id));
    if v_n > 0 then
      raise exception 'EXAME_EM_ABERTO: há % exame(s) marcado(s) sem desfecho. Registre se o paciente compareceu, faltou, cancelou ou remarcou antes de encerrar.', v_n using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.conversa_exame_aberto_trg() from public, anon, authenticated;
create or replace trigger conversa_exame_aberto before update of status on public.conversas
  for each row execute function public.conversa_exame_aberto_trg();

-- ======================================================================
-- 6. Perguntar ao paciente pelo chat (fechar o exame / remarcar a falta)
-- ======================================================================
insert into public.fluxo_texto (chave, texto, descricao) values
 ('exame_aberto', 'Olá, {nome}! Aqui é da clínica. O seu exame {item} ainda está em aberto no nosso sistema. Como foi?', 'Exame em aberto: a equipe pergunta ao paciente como terminou'),
 ('exame_aberto_obrigado', 'Obrigado por avisar!', 'Exame em aberto: depois de "Fui e fiz o exame"'),
 ('exame_aberto_faltei', 'Tudo bem, acontece.', 'Exame em aberto: depois de "Não consegui ir"'),
 ('exame_aberto_cancelar', 'Certo. Um atendente cancela o horário no sistema e confirma com você.', 'Exame em aberto: depois de "Quero cancelar"'),
 ('remarcar_falta', '{item}: quer remarcar agora por aqui? Eu mostro os horários livres e você escolhe.', 'Falta: oferece a remarcação pelo chat'),
 ('remarcar_falta_ok', 'Vamos lá! Vou usar o mesmo pedido, só preciso que você escolha o novo horário.', 'Falta: o pedido foi copiado'),
 ('remarcar_falta_do_zero', 'Vamos lá! Primeiro me diga de novo qual é o exame. Depois escolhemos o novo horário.', 'Falta: o pedido não pôde ser copiado'),
 ('remarcar_falta_atendente', 'Combinado. Um atendente vai falar com você para remarcar.', 'Falta: o paciente prefere o atendente'),
 ('remarcar_falta_nao', 'Tudo bem. Se mudar de ideia, é só chamar por aqui.', 'Falta: o paciente não quer remarcar')
on conflict (chave) do nothing;

-- Copia o pedido da marcação que falhou para a conversa que o paciente está usando. Devolve true se o pedido foi copiado.
create or replace function public.agendamento_preparar_remarcacao(p_destino uuid, p_origem uuid) returns boolean
language plpgsql security definer set search_path to '' as $$
declare po public.pre_agendamentos; pd public.pre_agendamentos; v_n int;
begin
  select * into po from public.pre_agendamentos where conversa_id = p_origem;
  if not found or not exists (select 1 from public.pre_agendamento_itens where conversa_id = p_origem and ativo) then return false; end if;
  if p_destino = p_origem then
    -- Mesma conversa: a marcação que falhou volta a rascunho (o desfecho dela já ficou guardado em agendamento_fechamento).
    update public.pre_agendamentos set status = 'rascunho', etapa = 'plano', escolha_horario = null, data_desejada = null, hora_desejada = null, atualizado_em = now()
     where conversa_id = p_origem;
    return true;
  end if;
  if exists (select 1 from public.pre_agendamento_itens where conversa_id = p_destino and ativo) then return false; end if;   -- já está montando outro pedido: não sobrescreve
  select * into pd from public.pre_agendamentos where conversa_id = p_destino;
  if found and pd.status in ('agendado', 'cancelado') then return false; end if;
  insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
  select p_destino, i.modalidade, i.regiao, i.regiao_nome, i.lado, i.procedimento_id, i.procedimento, i.quantidade
    from public.pre_agendamento_itens i where i.conversa_id = p_origem and i.ativo;
  get diagnostics v_n = row_count;
  if v_n = 0 then return false; end if;
  insert into public.pre_agendamentos (conversa_id, tipo, procedimento, plano, unidade, profissional, paciente, paciente_id, identidade, etapa, status)
  values (p_destino, po.tipo, po.procedimento, po.plano, po.unidade, po.profissional, po.paciente, po.paciente_id, po.identidade, 'plano', 'rascunho')
  on conflict (conversa_id) do update set tipo = excluded.tipo, procedimento = excluded.procedimento, plano = excluded.plano, unidade = excluded.unidade,
    profissional = excluded.profissional, paciente = excluded.paciente, paciente_id = excluded.paciente_id, identidade = excluded.identidade,
    etapa = 'plano', status = 'rascunho', escolha_horario = null, data_desejada = null, hora_desejada = null, atualizado_em = now();
  return true;
end $$;
revoke all on function public.agendamento_preparar_remarcacao(uuid, uuid) from public, anon, authenticated;

-- A equipe pergunta ao paciente. p_modo: 'fechar' (exame em aberto) ou 'remarcar' (falta com remarcação pendente).
-- A pergunta vai para a conversa onde o paciente escreveu por último. Devolve o canal usado:
--   'botoes'   = conversa do motor automático: o paciente toca nas opções e segue sozinho
--   'mensagem' = conversa sem motor: só uma mensagem de texto; o atendente continua à mão
create or replace function public.agendamento_perguntar(p_conversa uuid, p_modo text, p_item text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare a record; f record; v_dest uuid; v_item text; v_motor text; v_passo text; v_nome text;
begin
  perform public.pessoa_equipe();
  if p_modo = 'fechar' then
    select * into a from public.v_agendamento_aberto where conversa_id = p_conversa order by quando nulls last limit 1;
    if not found then raise exception 'Não há exame em aberto nesta conversa.' using errcode = '22023'; end if;
    v_item := coalesce(nullif(btrim(a.exames), ''), 'marcado') || coalesce(' (' || to_char(a.quando, 'DD/MM "às" HH24:MI') || ')', '');
    v_passo := 'exame_aberto';
  elsif p_modo = 'remarcar' then
    select * into f from public.v_remarcacao_pendente where conversa_id = p_conversa order by fechado_em desc limit 1;
    if not found then raise exception 'Não há remarcação pendente nesta conversa.' using errcode = '22023'; end if;
    v_item := coalesce(nullif(btrim(f.exames), ''), 'o seu exame') || coalesce(' (' || to_char(f.quando, 'DD/MM') || ')', '');
    v_passo := 'remarcar_falta';
  else
    raise exception 'Modo inválido.' using errcode = '22023';
  end if;
  v_item := coalesce(nullif(btrim(p_item), ''), v_item);
  -- Onde o paciente está lendo agora: a conversa do grupo com a mensagem mais recente.
  select c.id, c.motor into v_dest, v_motor from public.conversas c where c.id = any (public.pessoa_membros(p_conversa)) order by c.atualizado_em desc limit 1;
  if v_motor = 'fluxo' then
    update public.conversas set ia_ativa = true, status = 'aguardando', agente_id = null where id = v_dest;
    insert into public.conversa_fluxo (conversa_id) values (v_dest) on conflict (conversa_id) do nothing;
    perform public.fluxo_set(v_dest, jsonb_build_object('pos_passo', v_passo, 'pos_origem', p_conversa, 'pos_item', left(v_item, 200),
      'identidade_feita', true, 'atalho_feito', true, 'confirmado', false));
    if p_modo = 'remarcar' then
      update public.agendamento_fechamento set remarcacao = 'pedida', atualizado_em = now() where id = f.fechamento_id and remarcacao = 'pendente';
    end if;
    perform public.fluxo_perguntar(v_dest, v_passo, null);
    return jsonb_build_object('ok', true, 'canal', 'botoes', 'conversa_id', v_dest);
  end if;
  select initcap(lower(split_part(btrim(coalesce(nullif(btrim(cv.nome_informado), ''), ct.nome)), ' ', 1))) into v_nome
    from public.conversas cv join public.contatos ct on ct.id = cv.contato_id where cv.id = v_dest;
  perform public.fluxo_dizer(v_dest, case p_modo
    when 'fechar' then 'Olá, ' || coalesce(v_nome, '') || '! O seu exame ' || v_item || ' ainda está em aberto no nosso sistema. Você compareceu, quer cancelar ou remarcar? Responda por aqui.'
    else 'Olá, ' || coalesce(v_nome, '') || '! Quer remarcar ' || v_item || '? Responda por aqui que um atendente te ajuda.' end);
  if p_modo = 'remarcar' then
    update public.agendamento_fechamento set remarcacao = 'pedida', atualizado_em = now() where id = f.fechamento_id and remarcacao = 'pendente';
  end if;
  return jsonb_build_object('ok', true, 'canal', 'mensagem', 'conversa_id', v_dest);
end $$;
revoke all on function public.agendamento_perguntar(uuid, text, text) from public, anon;
grant execute on function public.agendamento_perguntar(uuid, text, text) to authenticated;

-- O que o motor pergunta e entende nos dois passos novos.
create or replace function public.fluxo_pos_pergunta(p_conversa uuid, p_passo text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare d jsonb; ctx jsonb := public.fluxo_ctx(p_conversa);
begin
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  ctx := ctx || jsonb_build_object('item', coalesce(d ->> 'pos_item', 'o seu exame'));
  if p_passo = 'exame_aberto' then
    return jsonb_build_object('texto', public.fluxo_t('exame_aberto', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'compareceu', 'rotulo', 'Fui e fiz o exame'),
      jsonb_build_object('valor', 'faltei', 'rotulo', 'Não consegui ir'),
      jsonb_build_object('valor', 'cancelar', 'rotulo', 'Quero cancelar'),
      jsonb_build_object('valor', 'remarcar', 'rotulo', 'Quero remarcar para outro dia'))));
  end if;
  return jsonb_build_object('texto', public.fluxo_t('remarcar_falta', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
    jsonb_build_object('valor', 'sim', 'rotulo', 'Sim, remarcar agora'),
    jsonb_build_object('valor', 'atendente', 'rotulo', 'Prefiro falar com um atendente'),
    jsonb_build_object('valor', 'nao', 'rotulo', 'Não quero remarcar'))));
end $$;
revoke all on function public.fluxo_pos_pergunta(uuid, text) from public, anon, authenticated;

create or replace function public.fluxo_pos_aplicar(p_conversa uuid, p_passo text, v text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare d jsonb; ctx jsonb := public.fluxo_ctx(p_conversa); v_orig uuid; v_item text; v_ok boolean; v_f bigint;
begin
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  v_orig := coalesce(nullif(d ->> 'pos_origem', '')::uuid, p_conversa);
  v_item := coalesce(d ->> 'pos_item', 'o exame');
  ctx := ctx || jsonb_build_object('item', v_item);
  if p_passo = 'exame_aberto' then
    case v
    when 'compareceu' then
      perform public.agendamento_fechar_interno(v_orig, 'compareceu', 'paciente', null, 'Informado pelo paciente no chat.');
      perform public.fluxo_set(p_conversa, jsonb_build_object('pos_passo', null, 'assunto', 'Exame em aberto', 'assunto_texto', left('O paciente diz que COMPARECEU: ' || v_item || '. Conferir no sistema.', 500)));
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('exame_aberto_obrigado', ctx));
      return '{"ok": true, "transferir": true}';
    when 'cancelar' then
      perform public.agendamento_fechar_interno(v_orig, 'cancelou', 'paciente', null, 'Pedido de cancelamento feito pelo paciente no chat.');
      perform public.fluxo_set(p_conversa, jsonb_build_object('pos_passo', null, 'assunto', 'Exame em aberto', 'assunto_texto', left('O paciente quer CANCELAR: ' || v_item || '. Cancelar no sistema e confirmar com ele.', 500)));
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('exame_aberto_cancelar', ctx));
      return '{"ok": true, "transferir": true}';
    when 'faltei' then
      perform public.agendamento_fechar_interno(v_orig, 'faltou', 'paciente', null, 'Informado pelo paciente no chat.');
      perform public.fluxo_set(p_conversa, '{"pos_passo": "remarcar_falta"}');
      return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('exame_aberto_faltei', ctx));
    when 'remarcar' then
      perform public.agendamento_fechar_interno(v_orig, 'remarcou', 'paciente', null, 'O paciente pediu para remarcar pelo chat.');
      update public.agendamento_fechamento set remarcacao = 'pendente' where conversa_id = v_orig and desfecho = 'remarcou' and remarcacao is null;
      return public.fluxo_pos_aplicar(p_conversa, 'remarcar_falta', 'sim');   -- ele já disse que quer remarcar: não pergunta de novo
    else
      return '{"ok": false}';
    end case;
  end if;
  -- remarcar_falta
  select id into v_f from public.agendamento_fechamento where conversa_id = v_orig and desfecho in ('faltou', 'remarcou') and remarcacao in ('pendente', 'pedida')
   order by fechado_em desc limit 1;
  case v
  when 'sim' then
    v_ok := coalesce((d ->> 'pos_copiar')::boolean, true) and public.agendamento_preparar_remarcacao(p_conversa, v_orig);   -- pos_copiar = false: falta vinda do Klingo, o pedido é refeito
    if v_f is not null then
      update public.agendamento_fechamento set remarcacao = 'aceita', remarcacao_conversa = p_conversa, atualizado_em = now() where id = v_f;
    end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('pos_passo', null, 'motivo', 'exame', 'confirmado', false, 'sem_horario', false, 'refazer', case when v_ok then null else 'pedido' end,
      'medico_feito', true, 'mudou', null));
    return jsonb_build_object('ok', true, 'aviso', public.fluxo_t(case when v_ok then 'remarcar_falta_ok' else 'remarcar_falta_do_zero' end, ctx));
  when 'atendente' then
    if v_f is not null then update public.agendamento_fechamento set remarcacao = 'pedida', atualizado_em = now() where id = v_f; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('pos_passo', null, 'assunto', 'Remarcar falta', 'assunto_texto', left('O paciente quer remarcar ' || v_item || ' com um atendente.', 500)));
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('remarcar_falta_atendente', ctx));
    return '{"ok": true, "transferir": true}';
  when 'nao' then
    if v_f is not null then update public.agendamento_fechamento set remarcacao = 'recusada', atualizado_em = now() where id = v_f; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('pos_passo', null, 'assunto', 'Remarcar falta', 'assunto_texto', left('O paciente NÃO quer remarcar ' || v_item || '.', 500)));
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('remarcar_falta_nao', ctx));
    return '{"ok": true, "transferir": true}';
  else
    return '{"ok": false}';
  end case;
end $$;
revoke all on function public.fluxo_pos_aplicar(uuid, text, text) from public, anon, authenticated;

-- Liga os passos novos ao motor.
select pg_temp.remendar('public.fluxo_proximo(uuid)'::regprocedure, 'pos_passo',
  array[E'  d := coalesce(d, ''{}''::jsonb);\n  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;'],
  array[E'  d := coalesce(d, ''{}''::jsonb);\n  if d ->> ''pos_passo'' in (''exame_aberto'', ''remarcar_falta'') then return d ->> ''pos_passo''; end if;\n  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;']);

select pg_temp.remendar('public.fluxo_perguntar(uuid,text,text)'::regprocedure, 'fluxo_pos_pergunta',
  array[E'  when ''assunto_qual'', ''assunto_confirma'', ''assunto_resultado'', ''assunto_fim'' then'],
  array[E'  when ''exame_aberto'', ''remarcar_falta'' then\n    v_op := public.fluxo_pos_pergunta(p_conversa, p_passo);\n    v_txt := v_op ->> ''texto'';\n    v_op := v_op -> ''op'';\n  when ''assunto_qual'', ''assunto_confirma'', ''assunto_resultado'', ''assunto_fim'' then']);

select pg_temp.remendar('public.fluxo_aplicar(uuid,text,jsonb)'::regprocedure, 'fluxo_pos_aplicar',
  array[E'  when ''assunto_qual'', ''assunto_confirma'', ''assunto_resultado'' then'],
  array[E'  when ''exame_aberto'', ''remarcar_falta'' then\n    return public.fluxo_pos_aplicar(p_conversa, p_passo, v);\n  when ''assunto_qual'', ''assunto_confirma'', ''assunto_resultado'' then']);

-- Quem digita em vez de tocar.
select pg_temp.remendar('public.fluxo_ler_texto(uuid,text,text)'::regprocedure, 'exame_aberto',
  array[E'  when ''assunto_confirma'' then\n    if sim then return ''"sim"''; end if;'],
  array[E'  when ''exame_aberto'' then\n    if t ~ ''(cancel|desmarc)'' then return ''"cancelar"''; end if;\n    if t ~ ''(remarc|outro dia|outra data)'' then return ''"remarcar"''; end if;\n    if t ~ ''(nao (fui|consegui|pude|compareci|fiz)|faltei|perdi)'' then return ''"faltei"''; end if;\n    if t ~ ''(^|\\m)(fui|fiz|compareci|realizei|feito)'' then return ''"compareceu"''; end if;\n  when ''remarcar_falta'' then\n    if t ~ ''(atendente|pessoa|humano|ligar)'' then return ''"atendente"''; end if;\n    if nao or t ~ ''(nao quero|desisti|deixa)'' then return ''"nao"''; end if;\n    if sim or t ~ ''(remarc|quero)'' then return ''"sim"''; end if;\n  when ''assunto_confirma'' then\n    if sim then return ''"sim"''; end if;']);

-- ======================================================================
-- 7. Rotina de conferência (a cada 5 minutos) — só se o pg_cron existir
-- ======================================================================
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cron' and p.proname = 'schedule') then
    perform cron.schedule('pessoa-agrupar', '*/5 * * * *', 'select public.pessoa_agrupar_pendentes()');
  end if;
end $$;
