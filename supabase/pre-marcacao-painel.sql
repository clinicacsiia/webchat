-- FLUXOGRAMA: página de teste (/painel/testedowebchat/) -> pre_marcacao_registrar (anônimo, só grava/atualiza o próprio protocolo)
--             -> tabela public.pre_marcacao -> aba "Pré-marcação" do painel (equipe lê; pre_marcacao_atender muda a fila).
-- Versão 1.0 — 25/11/2026 / Mudança: implementação inicial. Pode ser aplicado de novo sem efeito.
--
-- O que guarda: o que a pessoa escolheu e informou no teste (nome, telefone, e-mail, consulta, pagamento, convênio, plano, médico, horário
-- desejado, período, dias, pendências, ciência). NÃO guarda a foto da carteirinha (só se foi enviada) nem texto de conversa.
-- Quem escreve: só a função pre_marcacao_registrar (SECURITY DEFINER). A tabela não aceita escrita direta de ninguém.
-- Quem lê: equipe (admin e atendente). A coluna chave_cliente (segredo que o aparelho usa para atualizar o próprio protocolo) nunca é lida pela equipe.
--
-- PARA VOLTAR ATRÁS (rollback):
--   drop function if exists public.pre_marcacao_atender(uuid, text, text);
--   drop function if exists public.pre_marcacao_registrar(jsonb);
--   drop table if exists public.pre_marcacao;

-- ===== PARTE 1: tabela, segurança e índices =====
create table if not exists public.pre_marcacao (
  id uuid primary key default gen_random_uuid(),
  protocolo text not null,
  chave_cliente text not null,
  origem text not null default 'teste',
  tipo text not null,                         -- pre_marcacao | contato_whatsapp | marcacao
  situacao text not null default '',          -- o que o paciente vê: aguardando_equipe, aviso_equipe, marcado, cancelado...
  fila text not null default 'novo',          -- trabalho da equipe: novo | em_contato | resolvido | descartado
  tipo_ident text not null default '',        -- proprio | filho
  nome_paciente text not null default '',
  responsavel text not null default '',
  telefone text not null default '',
  email text not null default '',
  consulta text not null default '',
  pagamento text not null default '',
  convenio text not null default '',
  plano text not null default '',
  medico text not null default '',
  horario_data date,
  horario_hora text not null default '',
  horario_local text not null default '',
  periodo text not null default '',
  dias text[] not null default '{}',
  pendencias text[] not null default '{}',
  motivo text not null default '',
  carteirinha boolean not null default false,
  ciente_em timestamptz,
  vence_em timestamptz,
  obs text not null default '',
  atendido_por uuid references auth.users(id) on delete set null,
  atendido_em timestamptz,
  dados jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint pre_marcacao_tipo_ck check (tipo in ('pre_marcacao', 'contato_whatsapp', 'marcacao')),
  constraint pre_marcacao_fila_ck check (fila in ('novo', 'em_contato', 'resolvido', 'descartado')),
  constraint pre_marcacao_obs_ck check (length(obs) <= 2000)
);
create unique index if not exists pre_marcacao_protocolo_uq on public.pre_marcacao (protocolo);
create index if not exists pre_marcacao_fila_criado_ix on public.pre_marcacao (fila, criado_em desc);

alter table public.pre_marcacao enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pre_marcacao' and policyname = 'pre_marcacao_select') then
    create policy pre_marcacao_select on public.pre_marcacao for select
      using ((select public.papel_atual()) in ('admin', 'atendente'));
  end if;
end $$;
revoke all on public.pre_marcacao from anon, authenticated;
grant select (id, protocolo, origem, tipo, situacao, fila, tipo_ident, nome_paciente, responsavel, telefone, email, consulta, pagamento, convenio, plano,
  medico, horario_data, horario_hora, horario_local, periodo, dias, pendencias, motivo, carteirinha, ciente_em, vence_em, obs, atendido_por, atendido_em,
  dados, criado_em, atualizado_em) on public.pre_marcacao to authenticated;

-- ===== PARTE 2: recebimento vindo da página de teste =====
-- Anônimo pode chamar. Só cria o protocolo ou atualiza um protocolo que já tem a mesma chave_cliente. Não devolve dado nenhum (só o protocolo).
create or replace function public.pre_marcacao_registrar(p jsonb)
 returns text
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_proto text; v_chave text; v_tipo text; d jsonb; pac jsonb; slot jsonb; pref jsonb; v_ident text;
  v_nome text; v_resp text; v_data date; v_dias text[]; v_pend text[]; v_ciente timestamptz; v_venc timestamptz;
begin
  if p is null or jsonb_typeof(p) <> 'object' or length(p::text) > 200000 then raise exception 'dados_invalidos' using errcode = '22023'; end if;
  v_proto := upper(left(btrim(coalesce(p->>'protocolo', '')), 40));
  v_chave := left(btrim(coalesce(p->>'chave', '')), 80);
  v_tipo := coalesce(p->>'tipo', '');
  if v_proto !~ '^[A-Z0-9-]{6,40}$' or length(v_chave) < 16 or v_tipo not in ('pre_marcacao', 'contato_whatsapp', 'marcacao') then
    raise exception 'dados_invalidos' using errcode = '22023';
  end if;
  -- freio: no máximo 300 registros novos por hora (a página de teste não precisa de mais que isso)
  if not exists (select 1 from public.pre_marcacao where protocolo = v_proto)
     and (select count(*) from public.pre_marcacao where criado_em > now() - interval '1 hour') >= 300 then
    raise exception 'limite' using errcode = '54000';
  end if;

  d := coalesce(p->'dados', '{}'::jsonb);
  if jsonb_typeof(d) <> 'object' then d := '{}'::jsonb; end if;
  d := d - 'fotoCart' - 'estado';                       -- foto e estado interno da tela ficam de fora
  pac := case when jsonb_typeof(d->'paciente') = 'object' then d->'paciente' else '{}'::jsonb end;
  slot := case when jsonb_typeof(d->'slot') = 'object' then d->'slot' else null end;
  pref := case when jsonb_typeof(d->'preferencia') = 'object' then d->'preferencia' else '{}'::jsonb end;

  v_ident := case when pac->>'tipo' = 'filho' then 'filho' else 'proprio' end;
  v_nome := left(btrim(coalesce(nullif(pac->>'nomeCrianca', ''), pac->>'nome', '')), 120);
  v_resp := case when v_ident = 'filho' then left(btrim(coalesce(pac->>'nome', '')), 120) else '' end;
  v_data := case when slot->>'data' ~ '^\d{4}-\d{2}-\d{2}$' then (slot->>'data')::date else null end;
  v_dias := case when jsonb_typeof(pref->'dias') = 'array'
    then coalesce((select array_agg(left(x, 20)) from jsonb_array_elements_text(pref->'dias') x), '{}') else '{}' end;
  v_pend := case when jsonb_typeof(d->'pendencias') = 'array'
    then coalesce((select array_agg(left(x, 120)) from jsonb_array_elements_text(d->'pendencias') x), '{}') else '{}' end;
  v_ciente := case when pref->'ciencia'->>'em' ~ '^\d{4}-\d{2}-\d{2}T' then (pref->'ciencia'->>'em')::timestamptz else null end;
  v_venc := case when p->>'venceEm' ~ '^\d{4}-\d{2}-\d{2}T' then (p->>'venceEm')::timestamptz else null end;

  insert into public.pre_marcacao as t (protocolo, chave_cliente, tipo, situacao, tipo_ident, nome_paciente, responsavel, telefone, email, consulta, pagamento,
      convenio, plano, medico, horario_data, horario_hora, horario_local, periodo, dias, pendencias, motivo, carteirinha, ciente_em, vence_em, dados)
  values (v_proto, v_chave, v_tipo, left(coalesce(p->>'status', ''), 40), v_ident, v_nome, v_resp,
      left(btrim(coalesce(pac->>'telefone', '')), 30), left(btrim(coalesce(pac->>'email', '')), 200), left(btrim(coalesce(d->>'procNome', '')), 120),
      left(btrim(coalesce(d->>'pagto', '')), 40), left(btrim(coalesce(d->>'convenio', '')), 120), left(btrim(coalesce(d->>'plano', '')), 160),
      left(btrim(coalesce(slot->>'profissional', '')), 120), v_data, left(coalesce(slot->>'hora', ''), 10),
      left(btrim(concat_ws(' · ', nullif(slot->>'local', ''), nullif(slot->>'unidade', ''))), 160),
      left(coalesce(pref->>'periodo', ''), 20), v_dias, v_pend, left(btrim(coalesce(p->>'motivo', '')), 300),
      coalesce((d->>'carteirinha')::boolean, false), v_ciente, v_venc, d)
  on conflict (protocolo) do update set
      tipo = excluded.tipo, situacao = excluded.situacao, tipo_ident = excluded.tipo_ident, nome_paciente = excluded.nome_paciente,
      responsavel = excluded.responsavel, telefone = excluded.telefone, email = excluded.email, consulta = excluded.consulta,
      pagamento = excluded.pagamento, convenio = excluded.convenio, plano = excluded.plano,
      medico = case when excluded.medico <> '' then excluded.medico else t.medico end,
      horario_data = excluded.horario_data, horario_hora = excluded.horario_hora, horario_local = excluded.horario_local,
      periodo = excluded.periodo, dias = excluded.dias, pendencias = excluded.pendencias, motivo = excluded.motivo,
      carteirinha = excluded.carteirinha, ciente_em = coalesce(excluded.ciente_em, t.ciente_em), vence_em = excluded.vence_em,
      dados = excluded.dados, atualizado_em = now()
    where t.chave_cliente = excluded.chave_cliente;   -- outro aparelho não mexe no protocolo alheio
  return v_proto;
end $function$;

revoke all on function public.pre_marcacao_registrar(jsonb) from public;
grant execute on function public.pre_marcacao_registrar(jsonb) to anon, authenticated, service_role;

-- ===== PARTE 3: a equipe marca o andamento =====
create or replace function public.pre_marcacao_atender(p_id uuid, p_fila text, p_obs text default null)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
begin
  if coalesce((select public.papel_atual()) in ('admin', 'atendente'), false) is false then
    raise exception 'Sem permissão para as pré-marcações.' using errcode = '42501';
  end if;
  if p_fila not in ('novo', 'em_contato', 'resolvido', 'descartado') then raise exception 'fila_invalida' using errcode = '22023'; end if;
  update public.pre_marcacao
     set fila = p_fila, obs = coalesce(left(p_obs, 2000), obs),
         atendido_por = case when p_fila = 'novo' then null else (select auth.uid()) end,
         atendido_em = case when p_fila = 'novo' then null else now() end,
         atualizado_em = now()
   where id = p_id;
end $function$;

revoke all on function public.pre_marcacao_atender(uuid, text, text) from public, anon;
grant execute on function public.pre_marcacao_atender(uuid, text, text) to authenticated, service_role;
