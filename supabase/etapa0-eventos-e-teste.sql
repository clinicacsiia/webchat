-- FLUXOGRAMA: entrada (qualquer mudança numa conversa: criada, assumida, transferida, encerrada, reaberta; mensagem de pessoa da equipe; marcação da TI) -> validação (gatilhos que NUNCA atrapalham o atendimento: erro dentro deles é engolido; a marca de teste não muda por pedido direto à API, só pelas funções oficiais) -> lógica (linha do tempo única da conversa; "primeiro atendimento humano" = a pessoa assumiu ou respondeu; conversa é TESTE se uma conta de teste (TI) assumiu, respondeu ou encerrou, ou se veio de um contato de teste) -> saída (conversa_evento, conversas.primeiro_humano_em, conversas.teste e funções para a TI marcar ou desmarcar)
-- Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial da Etapa 0 (decisões Q-01, Q-09 e "conversas do Alisson são teste" do dono de 10/11/2026).
-- Pré-requisitos: tabelas conversas, contatos, mensagens, config e agentes. Aditivo e idempotente: colunas e tabela novas, 3 gatilhos novos, funções novas; nenhuma coluna ou regra existente muda.
-- Chaves em config (listas de id de agente separados por vírgula): teste_agentes (contas cujas conversas são teste: hoje só o Alisson) e teste_marcadores (quem pode marcar/desmarcar teste: a TI; até existirem os papéis de TI e gerência).
-- O passado NÃO é marcado por este arquivo: a regra aplicada ao passado é teste_regra_passado(), que primeiro só LISTA (p_aplicar = false) para o dono conferir.
-- DESLIGAR a marcação automática: update public.config set valor = '' where chave in ('teste_agentes');   (os gatilhos continuam, sem marcar nada)
-- ROLLBACK: drop trigger conversas_zz_teste on public.conversas; drop trigger conversas_zz_evento on public.conversas; drop trigger mensagens_zz_teste on public.mensagens;
--           drop function public.conversas_teste_trg(), public.conversas_evento_trg(), public.mensagens_teste_trg(), public.conversa_marcar_teste_interno(uuid, text), public.conversa_marcar_teste(uuid, boolean, text),
--           public.contato_marcar_teste(uuid, boolean, text, boolean), public.teste_regra_passado(boolean), public.teste_regra_passado_interno(boolean), public.teste_ids(text);
--           (as colunas e a tabela conversa_evento podem ficar; não atrapalham)

insert into public.config (chave, valor) values ('teste_agentes', ''), ('teste_marcadores', '') on conflict (chave) do nothing;

alter table public.conversas add column if not exists teste boolean not null default false;
alter table public.conversas add column if not exists teste_motivo text;
alter table public.conversas add column if not exists teste_manual boolean not null default false;
alter table public.conversas add column if not exists primeiro_humano_em timestamptz;
comment on column public.conversas.teste is 'Conversa de teste (TI/treinamento): fica no histórico, mas sai dos indicadores. Só gatilhos e funções oficiais mudam.';
comment on column public.conversas.teste_manual is 'A TI desmarcou o teste de propósito: as regras automáticas não marcam de novo.';
comment on column public.conversas.primeiro_humano_em is 'Quando uma pessoa da equipe assumiu ou respondeu pela primeira vez. Nulo = nenhuma pessoa atendeu (ainda).';
alter table public.contatos add column if not exists teste boolean not null default false;
alter table public.contatos add column if not exists teste_motivo text;
comment on column public.contatos.teste is 'Contato de teste da TI: as conversas iniciadas por ele já nascem como teste.';

-- Linha do tempo única da conversa. Só gatilhos e funções do banco escrevem; a equipe lê. Sem texto de mensagem nem dado pessoal.
-- Tipos: criada, assumida, devolvida, transferida, primeiro_humano, encerrada, autoencerrada, reaberta, teste_marcado, teste_desmarcado.
create table if not exists public.conversa_evento (
  id bigint generated always as identity primary key,
  conversa_id uuid not null references public.conversas(id) on delete cascade,
  tipo text not null,
  em timestamptz not null default now(),
  de_agente uuid, para_agente uuid, por uuid,
  motivo text, detalhe jsonb
);
create index if not exists conversa_evento_conversa on public.conversa_evento (conversa_id, em);
create index if not exists conversa_evento_tipo_em on public.conversa_evento (tipo, em);
alter table public.conversa_evento enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversa_evento' and policyname = 'conversa_evento_select') then
    create policy conversa_evento_select on public.conversa_evento for select to authenticated
      using ((select public.papel_atual()) = any (array['admin', 'atendente']));
  end if;
end $$;
revoke insert, update, delete on public.conversa_evento from anon, authenticated;
revoke all on public.conversa_evento from anon;

create or replace function public.teste_ids(p_chave text) returns uuid[]
language sql stable security definer set search_path to '' as $$
  select coalesce(array_agg(btrim(x)::uuid), '{}'::uuid[])
    from public.config c, unnest(string_to_array(c.valor, ',')) x
   where c.chave = p_chave and btrim(x) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
revoke all on function public.teste_ids(text) from public, anon, authenticated;

-- 1) Marca de teste e primeiro atendimento humano (ANTES de gravar; roda por último entre os gatilhos "antes").
create or replace function public.conversas_teste_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v_ids uuid[]; v_oficial boolean := coalesce(current_setting('app.teste_via_funcao', true), '') = '1';
begin
  if tg_op = 'UPDATE' and not v_oficial then
    -- ninguém muda a marca de teste nem o "primeiro atendimento" por pedido direto à API
    new.teste := old.teste; new.teste_motivo := old.teste_motivo; new.teste_manual := old.teste_manual; new.primeiro_humano_em := old.primeiro_humano_em;
  end if;
  begin
    if tg_op = 'INSERT' and not new.teste and exists (select 1 from public.contatos ct where ct.id = new.contato_id and ct.teste) then
      new.teste := true; new.teste_motivo := 'contato de teste';
    end if;
    if not new.teste and not new.teste_manual then
      v_ids := public.teste_ids('teste_agentes');
      if cardinality(v_ids) > 0 and ((new.agente_id is not null and new.agente_id = any (v_ids)) or (new.encerrada_por is not null and new.encerrada_por = any (v_ids))) then
        new.teste := true; new.teste_motivo := coalesce(new.teste_motivo, 'atendida por conta de teste');
      end if;
    end if;
    if new.primeiro_humano_em is null and new.agente_id is not null and new.status = 'em_atendimento' then
      new.primeiro_humano_em := now();
    end if;
  exception when others then null;
  end;
  return new;
end $$;
revoke all on function public.conversas_teste_trg() from public, anon, authenticated;
drop trigger if exists conversas_zz_teste on public.conversas;
create trigger conversas_zz_teste before insert or update on public.conversas for each row execute function public.conversas_teste_trg();

-- 2) Linha do tempo (DEPOIS de gravar).
create or replace function public.conversas_evento_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  begin
    if tg_op = 'INSERT' then
      insert into public.conversa_evento (conversa_id, tipo, em, detalhe) values (new.id, 'criada', coalesce(new.criado_em, now()), jsonb_build_object('unidade', new.unidade_inicial));
    else
      if new.agente_id is distinct from old.agente_id then
        insert into public.conversa_evento (conversa_id, tipo, de_agente, para_agente, por)
        values (new.id, case when old.agente_id is null then 'assumida' when new.agente_id is null then 'devolvida' else 'transferida' end, old.agente_id, new.agente_id, (select auth.uid()));
      end if;
      if new.status is distinct from old.status then
        if new.status = 'encerrada' then
          insert into public.conversa_evento (conversa_id, tipo, motivo, por, detalhe)
          values (new.id, case when new.encerramento_origem = 'inatividade' then 'autoencerrada' else 'encerrada' end, new.motivo_encerramento, new.encerrada_por, jsonb_build_object('origem', new.encerramento_origem));
        elsif old.status = 'encerrada' then
          insert into public.conversa_evento (conversa_id, tipo, por) values (new.id, 'reaberta', (select auth.uid()));
        end if;
      end if;
      if old.primeiro_humano_em is null and new.primeiro_humano_em is not null then
        insert into public.conversa_evento (conversa_id, tipo, em) values (new.id, 'primeiro_humano', new.primeiro_humano_em);
      end if;
    end if;
  exception when others then null;
  end;
  return null;
end $$;
revoke all on function public.conversas_evento_trg() from public, anon, authenticated;
drop trigger if exists conversas_zz_evento on public.conversas;
create trigger conversas_zz_evento after insert or update on public.conversas for each row execute function public.conversas_evento_trg();

-- 3) Resposta de pessoa de uma conta de teste marca a conversa (mesmo que ela não seja a dona).
create or replace function public.conversa_marcar_teste_interno(p_conversa uuid, p_motivo text) returns void
language plpgsql security definer set search_path to '' as $$
declare v_n integer;
begin
  perform set_config('app.teste_via_funcao', '1', true);
  update public.conversas set teste = true, teste_motivo = coalesce(teste_motivo, p_motivo) where id = p_conversa and not teste and not teste_manual;
  get diagnostics v_n = row_count;
  perform set_config('app.teste_via_funcao', '', true);
  if v_n > 0 then insert into public.conversa_evento (conversa_id, tipo, motivo) values (p_conversa, 'teste_marcado', p_motivo); end if;
end $$;
revoke all on function public.conversa_marcar_teste_interno(uuid, text) from public, anon, authenticated;

create or replace function public.mensagens_teste_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.autor = 'agente' and new.agente_id is not null then
    begin
      if new.agente_id = any (public.teste_ids('teste_agentes')) then
        perform public.conversa_marcar_teste_interno(new.conversa_id, 'respondida por conta de teste');
      end if;
    exception when others then null;
    end;
  end if;
  return null;
end $$;
revoke all on function public.mensagens_teste_trg() from public, anon, authenticated;
drop trigger if exists mensagens_zz_teste on public.mensagens;
create trigger mensagens_zz_teste after insert on public.mensagens for each row execute function public.mensagens_teste_trg();

-- 4) Marcação pela TI (hoje: quem está em config.teste_marcadores).
create or replace function public.conversa_marcar_teste(p_conversa uuid, p_teste boolean, p_motivo text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_n integer;
begin
  if not coalesce((select auth.uid()) = any (public.teste_ids('teste_marcadores')), false) then
    raise exception 'Somente a TI marca ou desmarca conversa de teste.' using errcode = '42501';
  end if;
  perform set_config('app.teste_via_funcao', '1', true);
  update public.conversas set teste = coalesce(p_teste, false), teste_manual = not coalesce(p_teste, false),
         teste_motivo = case when coalesce(p_teste, false) then coalesce(nullif(btrim(p_motivo), ''), 'marcada pela TI') end
   where id = p_conversa;
  get diagnostics v_n = row_count;
  perform set_config('app.teste_via_funcao', '', true);
  if v_n = 0 then raise exception 'Conversa não encontrada.' using errcode = '22023'; end if;
  insert into public.conversa_evento (conversa_id, tipo, por, motivo) values (p_conversa, case when coalesce(p_teste, false) then 'teste_marcado' else 'teste_desmarcado' end, (select auth.uid()), nullif(btrim(p_motivo), ''));
  return jsonb_build_object('ok', true, 'teste', coalesce(p_teste, false));
end $$;
revoke all on function public.conversa_marcar_teste(uuid, boolean, text) from public, anon;
grant execute on function public.conversa_marcar_teste(uuid, boolean, text) to authenticated;

create or replace function public.contato_marcar_teste(p_contato uuid, p_teste boolean, p_motivo text default null, p_conversas boolean default false) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_n integer; r record; v_c integer := 0;
begin
  if not coalesce((select auth.uid()) = any (public.teste_ids('teste_marcadores')), false) then
    raise exception 'Somente a TI marca ou desmarca contato de teste.' using errcode = '42501';
  end if;
  update public.contatos set teste = coalesce(p_teste, false), teste_motivo = case when coalesce(p_teste, false) then coalesce(nullif(btrim(p_motivo), ''), 'teste da TI') end where id = p_contato;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'Contato não encontrado.' using errcode = '22023'; end if;
  if p_conversas and coalesce(p_teste, false) then
    for r in select id from public.conversas where contato_id = p_contato and not teste and not teste_manual loop
      perform public.conversa_marcar_teste_interno(r.id, 'contato de teste'); v_c := v_c + 1;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'teste', coalesce(p_teste, false), 'conversas_marcadas', v_c);
end $$;
revoke all on function public.contato_marcar_teste(uuid, boolean, text, boolean) from public, anon;
grant execute on function public.contato_marcar_teste(uuid, boolean, text, boolean) to authenticated;

-- 5) A regra de teste aplicada ao PASSADO. Por padrão só LISTA (p_aplicar = false). A versão pública exige a TI; a interna é para manutenção (service_role).
--    Pega: conversa assumida/encerrada/respondida por conta de teste, e conversa de contato de teste.
create or replace function public.teste_regra_passado_interno(p_aplicar boolean default false) returns table (conversa_id uuid, motivo text, criada_em timestamptz, status text, aplicada boolean)
language plpgsql security definer set search_path to '' as $$
#variable_conflict use_column
declare v_ids uuid[] := public.teste_ids('teste_agentes'); r record;
begin
  for r in
    select c.id as cid, c.criado_em as cri, c.status as sit,
           case when c.teste_manual then null
                when c.agente_id = any (v_ids) then 'dona atual é conta de teste'
                when c.encerrada_por = any (v_ids) then 'encerrada por conta de teste'
                when exists (select 1 from public.conversa_encerramento ce where ce.conversa_id = c.id and ce.por = any (v_ids)) then 'já foi encerrada por conta de teste'
                when exists (select 1 from public.mensagens m where m.conversa_id = c.id and m.autor = 'agente' and m.agente_id = any (v_ids)) then 'respondida por conta de teste'
                when exists (select 1 from public.contatos ct where ct.id = c.contato_id and ct.teste) then 'contato de teste' end as mot
      from public.conversas c where not c.teste
     order by c.criado_em
  loop
    if r.mot is null then continue; end if;
    if p_aplicar then perform public.conversa_marcar_teste_interno(r.cid, r.mot); end if;
    conversa_id := r.cid; motivo := r.mot; criada_em := r.cri; status := r.sit; aplicada := coalesce(p_aplicar, false);
    return next;
  end loop;
end $$;
revoke all on function public.teste_regra_passado_interno(boolean) from public, anon, authenticated;
grant execute on function public.teste_regra_passado_interno(boolean) to service_role;

create or replace function public.teste_regra_passado(p_aplicar boolean default false) returns table (conversa_id uuid, motivo text, criada_em timestamptz, status text, aplicada boolean)
language plpgsql security definer set search_path to '' as $$
begin
  if not coalesce((select auth.uid()) = any (public.teste_ids('teste_marcadores')), false) then
    raise exception 'Somente a TI aplica a regra de teste ao passado.' using errcode = '42501';
  end if;
  return query select * from public.teste_regra_passado_interno(p_aplicar);
end $$;
revoke all on function public.teste_regra_passado(boolean) from public, anon;
grant execute on function public.teste_regra_passado(boolean) to authenticated;

-- 6) Reconstrução do passado (só dados derivados; não marca teste).
insert into public.conversa_evento (conversa_id, tipo, em, detalhe)
select c.id, 'criada', c.criado_em, jsonb_build_object('reconstruido', true, 'unidade', c.unidade_inicial)
  from public.conversas c
 where not exists (select 1 from public.conversa_evento e where e.conversa_id = c.id and e.tipo = 'criada');

insert into public.conversa_evento (conversa_id, tipo, em, motivo, por, detalhe)
select ce.conversa_id, case when ce.origem = 'inatividade' then 'autoencerrada' else 'encerrada' end, ce.encerrada_em, ce.motivo, ce.por, jsonb_build_object('reconstruido', true, 'origem', ce.origem)
  from public.conversa_encerramento ce
 where not exists (select 1 from public.conversa_evento e where e.conversa_id = ce.conversa_id and e.tipo in ('encerrada', 'autoencerrada') and e.em = ce.encerrada_em);

-- primeiro atendimento humano do passado = a primeira entre "entrou na conversa" (assumiu) e a primeira resposta de pessoa
do $$ begin
  perform set_config('app.teste_via_funcao', '1', true);
  update public.conversas c set primeiro_humano_em = h.p
    from (select c2.id, least(
            (select min(m.criado_em) from public.mensagens m where m.conversa_id = c2.id and m.autor = 'agente' and m.agente_id is not null),
            (select min(m.criado_em) from public.mensagens m where m.conversa_id = c2.id and m.autor = 'sistema' and m.texto like '% entrou na conversa.')) as p
            from public.conversas c2 where c2.primeiro_humano_em is null) h
   where c.id = h.id and h.p is not null and c.primeiro_humano_em is null;
  perform set_config('app.teste_via_funcao', '', true);
end $$;
