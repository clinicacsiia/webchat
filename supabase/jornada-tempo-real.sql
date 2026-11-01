-- FLUXOGRAMA: entrada (o Klingo, a leitura de 1 minuto ou a equipe muda o status de um exame ou a etapa de uma visita) -> validação (só dispara se o status/etapa mudou de verdade, não a cada leitura) -> lógica (um aviso sem nenhum dado pessoal: "mudou") -> saída (broadcast "jornada_mudou" no canal fila-chegada; cada portal aberto pergunta de novo a própria jornada, sem esperar os 15 s)
-- Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
-- Pré-requisitos: tabelas jornada_card e jornada_exame, supabase/fila-chegada.sql (canal fila-chegada). Aditivo e idempotente. Nenhum dado pessoal sai no aviso.
--
-- ROLLBACK: drop trigger jornada_exame_tr_ins on public.jornada_exame; drop trigger jornada_exame_tr_upd on public.jornada_exame; drop trigger jornada_card_tr_upd on public.jornada_card;
--   drop function public.jornada_avisar_exame_ins(), public.jornada_avisar_exame_upd(), public.jornada_avisar_card_upd();

create or replace function public.jornada_avisar_exame_ins() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  begin perform realtime.send(jsonb_build_object('evento', 'jornada_mudou'), 'jornada_mudou', 'fila-chegada', false); exception when others then null; end;
  return null;
end $$;
create or replace function public.jornada_avisar_exame_upd() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if exists (select 1 from n join o on o.id = n.id where n.status is distinct from o.status or n.confirm_status is distinct from o.confirm_status) then
    begin perform realtime.send(jsonb_build_object('evento', 'jornada_mudou'), 'jornada_mudou', 'fila-chegada', false); exception when others then null; end;
  end if;
  return null;
end $$;
create or replace function public.jornada_avisar_card_upd() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if exists (select 1 from n join o on o.id = n.id where n.coluna is distinct from o.coluna or n.arquivado_em is distinct from o.arquivado_em) then
    begin perform realtime.send(jsonb_build_object('evento', 'jornada_mudou'), 'jornada_mudou', 'fila-chegada', false); exception when others then null; end;
  end if;
  return null;
end $$;
revoke all on function public.jornada_avisar_exame_ins(), public.jornada_avisar_exame_upd(), public.jornada_avisar_card_upd() from public, anon, authenticated;

create or replace trigger jornada_exame_tr_ins after insert on public.jornada_exame referencing new table as n for each statement execute function public.jornada_avisar_exame_ins();
create or replace trigger jornada_exame_tr_upd after update on public.jornada_exame referencing old table as o new table as n for each statement execute function public.jornada_avisar_exame_upd();
create or replace trigger jornada_card_tr_upd after update on public.jornada_card referencing old table as o new table as n for each statement execute function public.jornada_avisar_card_upd();
