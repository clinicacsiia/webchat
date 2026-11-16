-- FLUXOGRAMA: entrada (a atendente, no painel, oferece horário ou a Disponibilidade futura e depois marca "aceitou", "recusou" ou "dispensar") -> validação (só admin e atendente; tipo e estado conhecidos;
--   quem já recusou ou foi dispensado NÃO recebe nova oferta do mesmo tipo) -> processamento (guarda cada passo em painel_oferta; o cadastro na Disponibilidade futura reaproveita disponibilidade_gravar,
--   a mesma regra do chat) -> saída (jsonb enxuto; nada de dado de paciente além do id da conversa)
-- Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (Etapa 2 do plano docs/plano-painel-agenda-2026-11-16.md: sugestões com ação na conversa; "recusou uma vez, não oferece mais").
-- Pré-requisitos: tabelas conversas e agentes; funções papel_atual, disponibilidade_gravar, disponibilidade_evento_gravar (todas já na produção).
-- ROLLBACK: drop function public.painel_disponibilidade_registrar(uuid, jsonb); drop function public.painel_ofertas(uuid[]); drop function public.painel_oferta_registrar(uuid, text, text); drop table public.painel_oferta;
--   (apagar só tira a memória de ofertas e recusas; nada do Klingo nem do chat depende dela.)
-- Aplicar em partes (a ferramenta de migração expira em 60 s): 1) tabela, 2) painel_oferta_registrar e painel_ofertas, 3) painel_disponibilidade_registrar.

-- ===== 1. Memória das ofertas =====
create table if not exists public.painel_oferta (
  id uuid default gen_random_uuid() not null,
  conversa_id uuid not null,
  tipo text not null,
  estado text not null,
  agente_id uuid default auth.uid(),
  criado_em timestamp with time zone default now() not null,
  constraint painel_oferta_pkey primary key (id),
  constraint painel_oferta_conversa_fk foreign key (conversa_id) references public.conversas (id) on delete cascade,
  constraint painel_oferta_tipo_ck check (tipo in ('horario', 'disponibilidade')),
  constraint painel_oferta_estado_ck check (estado in ('oferecido', 'aceito', 'recusado', 'dispensado'))
);
create index if not exists painel_oferta_conversa_idx on public.painel_oferta (conversa_id, tipo, criado_em desc);
comment on table public.painel_oferta is 'Passos de cada oferta feita pela equipe no painel (horário ou Disponibilidade futura): oferecido, aceito, recusado ou dispensado. Quem recusou ou foi dispensado não recebe nova oferta do mesmo tipo. Só as funções painel_oferta* leem e gravam.';
alter table public.painel_oferta enable row level security;
revoke all on table public.painel_oferta from anon, authenticated;

-- ===== 2. Registrar e ler =====
create or replace function public.painel_oferta_registrar(p_conversa uuid, p_tipo text, p_estado text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_ult text;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  if p_tipo not in ('horario', 'disponibilidade') or p_estado not in ('oferecido', 'aceito', 'recusado', 'dispensado') then raise exception 'Oferta inválida.' using errcode = '22023'; end if;
  if not exists (select 1 from public.conversas where id = p_conversa) then raise exception 'Conversa não encontrada.' using errcode = 'P0002'; end if;
  select estado into v_ult from public.painel_oferta where conversa_id = p_conversa and tipo = p_tipo order by criado_em desc, id desc limit 1;
  -- Regra do dono: recusou uma vez (ou foi dispensado), não oferece mais.
  if p_estado = 'oferecido' and v_ult in ('recusado', 'dispensado') then return jsonb_build_object('ok', false, 'bloqueado', true, 'motivo', 'ja_' || v_ult); end if;
  if v_ult is not distinct from p_estado then return jsonb_build_object('ok', true, 'estado', p_estado, 'repetido', true); end if;
  insert into public.painel_oferta (conversa_id, tipo, estado) values (p_conversa, p_tipo, p_estado);
  return jsonb_build_object('ok', true, 'estado', p_estado);
end $$;

-- Último estado de cada tipo entre as conversas unidas da mesma pessoa (p_conversas).
create or replace function public.painel_ofertas(p_conversas uuid[]) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare r jsonb := '{}'::jsonb; t text; e record;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  if p_conversas is null or cardinality(p_conversas) = 0 or cardinality(p_conversas) > 30 then return r; end if;
  foreach t in array array['horario', 'disponibilidade'] loop
    select o.estado, o.criado_em into e from public.painel_oferta o where o.conversa_id = any (p_conversas) and o.tipo = t order by o.criado_em desc, o.id desc limit 1;
    if e.estado is not null then r := r || jsonb_build_object(t, jsonb_build_object('estado', e.estado, 'em', e.criado_em)); end if;
  end loop;
  return r;
end $$;

revoke all on function public.painel_oferta_registrar(uuid, text, text) from public, anon;
revoke all on function public.painel_ofertas(uuid[]) from public, anon;
grant execute on function public.painel_oferta_registrar(uuid, text, text) to authenticated, service_role;
grant execute on function public.painel_ofertas(uuid[]) to authenticated, service_role;

-- ===== 3. Cadastro na Disponibilidade futura feito pela equipe =====
-- A atendente só usa depois de o paciente dizer que aceita ser avisado. Mesmas regras do chat (disponibilidade_gravar): um só exame ou consulta, CPF e nascimento informados.
create or replace function public.painel_disponibilidade_registrar(p_conversa uuid, p_dados jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_r jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  if not exists (select 1 from public.conversas where id = p_conversa) then raise exception 'Conversa não encontrada.' using errcode = 'P0002'; end if;
  v_r := public.disponibilidade_gravar(p_conversa, jsonb_build_object('aceita_notificacao', true, 'canais', jsonb_build_array('chat', 'equipe_contato')) || coalesce(p_dados, '{}'::jsonb));
  -- a origem do evento é cortada em 40 letras ('equipe:' + id do atendente tem 43): quem fez vai no detalhe
  perform public.disponibilidade_evento_gravar((v_r ->> 'id')::uuid, 'registrada_pela_equipe', 'equipe', jsonb_build_object('origem', 'painel', 'agente', auth.uid()));
  insert into public.painel_oferta (conversa_id, tipo, estado) values (p_conversa, 'disponibilidade', 'aceito');
  return jsonb_build_object('ok', true, 'id', v_r ->> 'id', 'data_ini', v_r ->> 'data_ini', 'data_fim', v_r ->> 'data_fim', 'procedimento', v_r ->> 'procedimento');
end $$;
revoke all on function public.painel_disponibilidade_registrar(uuid, jsonb) from public, anon;
grant execute on function public.painel_disponibilidade_registrar(uuid, jsonb) to authenticated, service_role;
