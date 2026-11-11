-- FLUXOGRAMA: entrada (o aviso de segurança do Supabase "função SECURITY DEFINER executável sem login") -> validação (só funções de GATILHO: o PostgREST não consegue chamá-las, então hoje são inofensivas) -> lógica (tira a permissão de execução de quem não precisa) -> saída (9 funções a menos na lista de avisos; nada muda para as telas)
-- Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial (auditoria de 11/11/2026)
--
-- Por que: higiene. Função de gatilho roda pelo gatilho, com a permissão do dono da tabela; ninguém precisa do EXECUTE nela.
-- Deixar a lista de avisos limpa faz um aviso novo (esse sim perigoso) aparecer na hora.
-- Não mexe em nenhuma função que as telas chamam (conferido por testes/retrato.test.mjs).
-- Idempotente. ROLLBACK: grant execute on function public.<nome>() to anon, authenticated;

revoke all on function public.catalogo_agenda_hash_trg() from public, anon, authenticated;
revoke all on function public.catalogo_preco_confianca_trg() from public, anon, authenticated;
revoke all on function public.conversa_fluxo_klingo_trg() from public, anon, authenticated;
revoke all on function public.conversa_limpa_aguarda_paciente_trg() from public, anon, authenticated;
revoke all on function public.conversas_conta_trg() from public, anon, authenticated;
revoke all on function public.ind_imutavel_trg() from public, anon, authenticated;
revoke all on function public.jornada_imutavel() from public, anon, authenticated;
revoke all on function public.org_log_imutavel_trg() from public, anon, authenticated;
revoke all on function public.pre_agendamento_vincula_conta_trg() from public, anon, authenticated;
