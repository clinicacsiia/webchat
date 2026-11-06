-- Correção do erro 42501 ao dispensar o alerta da conferência da agenda no painel.
-- O painel fazia `update conversas set alerta_agenda = null`, mas o papel authenticated só pode
-- alterar status, agente_id e nao_lidas_agente (de propósito). Em vez de abrir a coluna, uma função
-- limpa só o alerta, e só para admin/atendente (mesma regra das políticas de conversas).
-- ROLLBACK: drop function public.painel_alerta_agenda_limpar(uuid);

create or replace function public.painel_alerta_agenda_limpar(p_conversa uuid) returns void
language plpgsql security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Não autorizado.' using errcode = '28000';
  end if;
  update public.conversas set alerta_agenda = null where id = p_conversa and alerta_agenda is not null;
end $$;

revoke all on function public.painel_alerta_agenda_limpar(uuid) from public, anon;
grant execute on function public.painel_alerta_agenda_limpar(uuid) to authenticated;
