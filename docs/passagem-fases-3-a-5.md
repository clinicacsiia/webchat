# Passagem de bastão — Fases 3 a 5

Estado em 2026-10-30. Fases 0, 1 e 2 entregues, mergeadas na `main` (PRs #8 e #9) e ativas.

## Onde está cada peça
- **Repo** `clinicacsiia/webchat`: `index.html` (chat do paciente), `painel/index.html` (painel do atendente), `supabase/*.sql` (estado final das funções), `supabase/functions/sync-catalogo-klingo/index.ts` (Edge Function v7), `docs/`.
- **Supabase** projeto `webchat-atendimento` (`nrvuynjwcgwpjdptkiay`). Crons (UTC): `sync-catalogo-klingo` 0 6; `catalogo-precos-convenio` 10 6; `catalogo-precos-particular` 25 6; `agenda-ocupacao` a cada 10 min das 8h às 1h.
- **n8n** workflow `wAbzjPqZNCztKriZ` "Triagem IA - Atendimento", versão ativa `83ae7956-e2b7-4c27-b595-4f5b4599b2cf` (prompt por etapas + `ia_responder_v2`). Para republicar: `publish_workflow` sem versionId publica o rascunho atual.
- **Klingo**: relatórios via `https://api-externa.klingo.app/api/info/relatorio?id=…`, header `X-APP-TOKEN` (secret `KLINGO_APP_TOKEN`, só na Edge Function). Relatórios: #13981 procedimentos, #13984 agenda, #12301 planos, #13983 preços convênio, #13825 marcações (Particular), #7 agendas marcadas (ocupação), #47 bloqueado por conter paciente.
- Edge Function: header `x-sync-key` = `config.ia_segredo`; modos `{}` (catálogo), `{"inspecionar":id}`, `{"precos":"convenio"|"particular"}`, `{"agenda":"ocupacao"}`.

## Regras que não podem ser quebradas
- Nenhum dado de paciente do Klingo é gravado (colunas Paciente/Telefone/Prontuário/Obs bloqueadas). `agenda_ocupacao` só guarda início, médico, unidade, procedimento, quantidade.
- Preço sempre é **previsão**; atendente humano confirma preço e data. Toda marcação passa por conferência humana final.
- Lado D/E: frente L→D, costas L→E; bilateral com lado único é recusado.
- Horários: reserva provisória + advisory lock por dia; folga 15/60 min entre exames; antecedência 120 min.
- Dicas Supabase MCP: `execute_sql` trava pedindo confirmação se o texto tiver `delete`/`drop`; testar em `DO $$ … raise exception … $$`; patch de função via `pg_get_functiondef` + `replace`.
- Dados de teste: telefones `7190000xxxx`; apagar após testar. Hoje: 7 conversas reais, 0 pacientes.

## Pendências de negócio (precisam da clínica)
1. Confirmar tempos por modalidade e folgas (15/60 min, 90 min, 48 h, 20 min) — hoje são estimativas.
2. Confiança dos preços Particular é média/baixa; validar com a recepção.
3. Atendente deve marcar "Agendado" no painel (libera/consolida a reserva).
4. E-mail ao suporte do Klingo está só como **rascunho no Gmail** (não enviado): pedir endpoint oficial de agenda sem dados de paciente e confirmação do #7 (pode incluir cancelados; só esconde horário, sem risco).
5. Avisos do advisor Supabase: funções `security definer` chamáveis por `anon` são intencionais (protegidas por token da conversa ou `ia_segredo`); ativar "leaked password protection" no Auth é opcional.

## Próximas fases
- **Fase 3 — conferência automática**: ler #7 para ver se a marcação feita pelo atendente apareceu na agenda e atualizar status da conversa/pré-agendamento (Agendado/não encontrado) sem expor paciente; alertar divergência.
- **Fase 4 — paciente que volta**: histórico de agendamentos anteriores (já existe `pacientes` + `paciente_conferir`); sugerir mesmo exame/unidade/profissional, e retomar conversa.
- **Fase 5 — aprendizado**: usar correções do atendente (preço/data/exame ajustados) para melhorar catálogo e prompt; relatório de erros da IA.
- Antes de cada fase: rodar teste curto e2e no chat, conferir `get_advisors`, publicar n8n só após merge.
