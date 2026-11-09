-- FLUXOGRAMA: entrada (o paciente, na conversa já encerrada, toca em Avaliar abaixo da despedida e envia duas notas de 0 a 10 e por onde nos conheceu) -> validação (token da própria conversa; conversa encerrada naquele fechamento; fechamento elegível: tem despedida e motivo diferente de Não respondido; chave config.avaliacao_ativa; notas inteiras de 0 a 10, onde 0 é nota válida; canal WhatsApp, Instagram ou Google) -> lógica (uma avaliação por fechamento; repetir devolve a mesma resposta; nada de nome, telefone ou texto livre) -> saída (ok para o chat; leitura agregada só para o administrador).
-- Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-09 e WC-10 da Atualização do WebChat). Decisão D4: toda despedida, exceto Não respondido. D5: sem nome nem telefone; texto de privacidade passa pelo jurídico.
-- Pré-requisitos: encerramento-motivo.sql (motivo e encerrada_em), despedida.sql (a despedida marca o fechamento em mensagens.opcoes), 00-base-snapshot.sql (chat_valida). Aditivo e idempotente. Nenhum comando destrutivo.
-- LIGAR: só depois de o jurídico revisar privacidade.html: Configurações > Encerramento e avaliação > "Convite para avaliar o atendimento" (config.avaliacao_ativa = 'sim'). Começa 'nao'.
-- ROLLBACK: update public.config set valor = 'nao' where chave = 'avaliacao_ativa';  (efeito imediato: o botão some e a gravação é recusada). A tabela pode ficar.

-- ===== PARTE 1: tabela e chave =====
create table if not exists public.avaliacao_atendimento (
  id bigint generated always as identity primary key,
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  encerrada_em timestamptz not null,
  nota_atendimento smallint not null check (nota_atendimento between 0 and 10),
  nota_site smallint not null check (nota_site between 0 and 10),
  canal text not null check (canal in ('WhatsApp', 'Instagram', 'Google')),
  criado_em timestamptz not null default now(),
  unique (conversa_id, encerrada_em)
);
comment on table public.avaliacao_atendimento is 'Uma avaliação voluntária por fechamento. Sem nome, telefone ou texto livre. A referência do fechamento é conversas.encerrada_em.';
alter table public.avaliacao_atendimento enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'avaliacao_atendimento' and policyname = 'avaliacao_atendimento_select') then
    create policy avaliacao_atendimento_select on public.avaliacao_atendimento for select using ((select public.papel_atual()) = 'admin');
  end if;
end $$;
grant select on public.avaliacao_atendimento to authenticated;
insert into public.config (chave, valor) values ('avaliacao_ativa', 'nao') on conflict (chave) do nothing;

-- ===== PARTE 2: o chat pergunta se deve mostrar o botão =====
-- p_encerrada_em é o instante do fechamento que a despedida carrega; só o fechamento ATUAL pode ser avaliado.
create or replace function public.chat_avaliacao_estado(p_conversa uuid, p_token text, p_encerrada_em text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare c record; v_ativa boolean; v_inst timestamptz;
begin
  perform public.chat_valida(p_conversa, p_token);
  v_ativa := coalesce((select valor from public.config where chave = 'avaliacao_ativa'), 'nao') = 'sim';
  begin v_inst := p_encerrada_em::timestamptz; exception when others then v_inst := null; end;
  select status, encerrada_em, motivo_encerramento into c from public.conversas where id = p_conversa;
  if not v_ativa or v_inst is null or c.status is distinct from 'encerrada' or c.encerrada_em is distinct from v_inst
     or c.motivo_encerramento = 'nao_respondido' then
    return jsonb_build_object('mostrar', false);
  end if;
  return jsonb_build_object('mostrar', not exists (select 1 from public.avaliacao_atendimento a where a.conversa_id = p_conversa and a.encerrada_em = c.encerrada_em),
                            'avaliou', exists (select 1 from public.avaliacao_atendimento a where a.conversa_id = p_conversa and a.encerrada_em = c.encerrada_em));
end $$;
revoke all on function public.chat_avaliacao_estado(uuid, text, text) from public;
grant execute on function public.chat_avaliacao_estado(uuid, text, text) to anon, authenticated;

-- ===== PARTE 3: gravar =====
create or replace function public.chat_avaliar(p_conversa uuid, p_token text, p_nota_atendimento numeric, p_nota_site numeric, p_canal text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare c record; n integer;
begin
  perform public.chat_valida(p_conversa, p_token);
  if coalesce((select valor from public.config where chave = 'avaliacao_ativa'), 'nao') <> 'sim' then raise exception 'A avaliação não está disponível no momento.' using errcode = '22023'; end if;
  if p_nota_atendimento is null or p_nota_site is null or p_nota_atendimento <> trunc(p_nota_atendimento) or p_nota_site <> trunc(p_nota_site)
     or p_nota_atendimento not between 0 and 10 or p_nota_site not between 0 and 10 then
    raise exception 'Escolha uma nota de 0 a 10 nas duas perguntas.' using errcode = '22023';
  end if;
  if p_canal is null or p_canal not in ('WhatsApp', 'Instagram', 'Google') then raise exception 'Escolha por onde você nos conheceu.' using errcode = '22023'; end if;
  select status, encerrada_em, motivo_encerramento into c from public.conversas where id = p_conversa;
  if c.status is distinct from 'encerrada' or c.encerrada_em is null then raise exception 'Só é possível avaliar depois do encerramento do atendimento.' using errcode = '22023'; end if;
  if c.motivo_encerramento = 'nao_respondido' or not exists (select 1 from public.mensagens m where m.conversa_id = p_conversa and (m.opcoes ->> 'tipo') = 'despedida' and (m.opcoes ->> 'encerrada_em')::timestamptz = c.encerrada_em) then
    raise exception 'Este atendimento não tem convite para avaliação.' using errcode = '22023';
  end if;
  insert into public.avaliacao_atendimento (conversa_id, encerrada_em, nota_atendimento, nota_site, canal)
  values (p_conversa, c.encerrada_em, p_nota_atendimento::smallint, p_nota_site::smallint, p_canal) on conflict (conversa_id, encerrada_em) do nothing;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'nova', n = 1);   -- repetir a mesma solicitação responde ok, sem gravar de novo
end $$;
revoke all on function public.chat_avaliar(uuid, text, numeric, numeric, text) from public;
grant execute on function public.chat_avaliar(uuid, text, numeric, numeric, text) to anon, authenticated;

-- ===== PARTE 4: leitura agregada (administrador) =====
create or replace function public.avaliacoes_resumo(p_dias integer default 30) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare d integer := greatest(1, least(coalesce(p_dias, 30), 365));
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Apenas administradores.' using errcode = '42501'; end if;
  return jsonb_build_object('dias', d,
    'total', (select count(*) from public.avaliacao_atendimento where criado_em >= now() - make_interval(days => d)),
    'media_atendimento', (select round(avg(nota_atendimento)::numeric, 1) from public.avaliacao_atendimento where criado_em >= now() - make_interval(days => d)),
    'media_site', (select round(avg(nota_site)::numeric, 1) from public.avaliacao_atendimento where criado_em >= now() - make_interval(days => d)),
    'por_canal', coalesce((select jsonb_object_agg(canal, n) from (select canal, count(*) n from public.avaliacao_atendimento where criado_em >= now() - make_interval(days => d) group by canal) x), '{}'::jsonb));
end $$;
revoke all on function public.avaliacoes_resumo(integer) from public, anon;
grant execute on function public.avaliacoes_resumo(integer) to authenticated;
