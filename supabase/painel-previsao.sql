-- FLUXOGRAMA: entrada (a equipe abre "Lista de previsão" no painel) -> validação (só admin e atendente; papel_atual) -> lógica (lê pedido_previsao das conversas ainda abertas, com o pedido em "pronto"; ordena: vaga encontrada primeiro, depois quem pode ser chamado mais rápido, depois o mais antigo) -> saída (jsonb com a lista; nenhuma escrita)
-- Versão 1.0 — 13/11/2026 / Mudança: Implementação inicial (tela da lista de previsão, pedido do dono em 13/11/2026). Pré-requisito: pedido-previsao.sql.
-- ROLLBACK: drop function public.painel_previsao_lista();
create or replace function public.painel_previsao_lista() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente a equipe.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'conversa_id', p.conversa_id, 'paciente', coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), nullif(btrim(c.paciente_nome), ''), nullif(btrim(c.nome_informado), ''), ct.nome),
        'pedido', pa.procedimento, 'tipo', pa.tipo, 'plano', pa.plano, 'turno', p.turno, 'de', p.de, 'ate', p.ate, 'antecedencia', p.antecedencia,
        'status', p.status, 'vaga', p.vaga, 'vaga_em', p.vaga_em, 'criada_em', p.criada_em, 'conversa_status', c.status)
      order by (p.status = 'vaga_encontrada') desc,
               case p.antecedencia when 'imediato' then 0 when '1_dia' then 1 when '1_semana' then 2 else 3 end,
               p.criada_em)
      from public.pedido_previsao p
      join public.conversas c on c.id = p.conversa_id
      join public.contatos ct on ct.id = c.contato_id
      join public.pre_agendamentos pa on pa.conversa_id = p.conversa_id
     where p.status in ('aguardando', 'vaga_encontrada') and pa.status = 'pronto' and c.status in ('aguardando', 'em_atendimento')), '[]'::jsonb);
end $$;
revoke all on function public.painel_previsao_lista() from public, anon;
grant execute on function public.painel_previsao_lista() to authenticated, service_role;
