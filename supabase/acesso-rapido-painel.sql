-- FLUXOGRAMA: entrada (o painel da equipe abre "Pendências" e chama painel_app_pendencias_resumo e painel_app_contas_antigas; as listas e os botões de ação usam painel_app_solicitacoes, painel_app_solicitacao_status, painel_app_revisoes e painel_app_revisao_resolver, que já existem) -> validação (só admin e atendente; qualquer outro papel recebe erro 42501; o público não executa) -> lógica (conta o que está esperando a equipe: solicitações de marcação, cadastros em dúvida, contas antigas que ainda não criaram o PIN, cadastros sem CPF) -> saída (JSON enxuto; CPF só mascarado)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (botão "Pendências" no painel; contadores e lista das contas antigas sem PIN)
--
-- POR QUE: as solicitações do acesso rápido e as dúvidas de cadastro só podiam ser vistas por SQL. Agora o painel tem um botão com contador e,
-- dentro, as listas com botões (confirmar, concluir, cancelar, marcar como conferido). Esta migração só acrescenta duas funções de leitura.
--
-- ROLLBACK (não mexe em nada existente):
--   drop function if exists public.painel_app_contas_antigas(), public.painel_app_pendencias_resumo();
-- Pode ser aplicado mais de uma vez.

-- Quantos itens esperam a equipe. As contagens seguem as MESMAS regras das listas (painel_app_solicitacoes / painel_app_revisoes).
create or replace function public.painel_app_pendencias_resumo() returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê as pendências.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'solicitacoes', (select count(distinct m.grupo) from public.app_marcacao m where m.status = 'solicitada'),
    'revisoes', (select count(*) from public.app_paciente a
                  where a.revisar_motivo is not null
                     or (a.paciente_sugerido_id is null and a.revisao_resolvida_em is null and exists (select 1 from public.pacientes p where p.telefones && array[a.telefone, '55' || a.telefone]))),
    'contas_antigas', (select count(*) from public.contas_paciente c where not exists (select 1 from public.app_paciente a where a.conta_antiga_id = c.id)),
    'sem_cpf', (select count(*) from public.app_paciente a where a.cpf is null),
    'acesso_rapido', (select count(*) from public.app_paciente));
end $$;

-- Contas de e-mail e senha que ainda não criaram o PIN (a equipe pode chamar essas pessoas no WhatsApp).
create or replace function public.painel_app_contas_antigas() returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê as contas antigas.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'celular', c.telefone, 'email', c.email, 'criado_em', c.criado_em,
      'ultimo_acesso_em', c.ultimo_acesso_em, 'filhos_no_historico', (select count(*) from public.app_conta_antiga_historico_filhos(c.id))) order by c.criado_em)
    from public.contas_paciente c where not exists (select 1 from public.app_paciente a where a.conta_antiga_id = c.id)), '[]'::jsonb);
end $$;

revoke all on function public.painel_app_pendencias_resumo(), public.painel_app_contas_antigas() from public, anon, authenticated;
grant execute on function public.painel_app_pendencias_resumo(), public.painel_app_contas_antigas() to authenticated;
