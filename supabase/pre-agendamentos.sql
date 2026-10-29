-- Já aplicada no projeto webchat-atendimento (migração "pre_agendamentos").
-- Pré-agendamento montado pela IA; o atendente conclui a marcação no Klingo.

create table public.pre_agendamentos (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null unique references public.conversas(id) on delete cascade,
  tipo text check (tipo in ('consulta','exame')),
  especialidade text,
  procedimento text,
  plano text,
  unidade text,
  profissional text,
  preferencia_horario text,
  paciente jsonb not null default '{}'::jsonb,
  status text not null default 'rascunho' check (status in ('rascunho','pronto','agendado','cancelado')),
  klingo_paciente_id text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
comment on table public.pre_agendamentos is 'Pré-agendamento montado pela IA (dados pessoais: CPF, mãe, endereço). Só admin/atendente leem. A marcação real é feita pelo atendente no Klingo.';
alter table public.pre_agendamentos enable row level security;

create policy pre_agendamentos_select on public.pre_agendamentos for select
  using ((select public.papel_atual()) = any (array['admin','atendente']));
create policy pre_agendamentos_update on public.pre_agendamentos for update
  using ((select public.papel_atual()) = any (array['admin','atendente']))
  with check ((select public.papel_atual()) = any (array['admin','atendente']));
create policy pre_agendamentos_delete on public.pre_agendamentos for delete
  using ((select public.papel_atual()) = 'admin');

-- Funções:
--   ia_pre_agendar(p_segredo, p_conversa, p_dados jsonb, p_pronto boolean): a IA (n8n) grava/mescla os dados;
--     só aceita campos conhecidos, higieniza CPF/telefones/CEP/UF e nunca reabre um pré-agendamento agendado/cancelado.
--   ia_contexto(...): passou a devolver "pre_agendamento" (o que já foi coletado) para a IA não repetir perguntas.
-- O corpo completo das duas está no banco (pg_get_functiondef).
