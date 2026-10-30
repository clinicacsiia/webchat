# Passagem de bastão — Fase 5

Estado em 2026-10-30. Fases 0 a 4 entregues e ativas (Fases 3 e 4 aplicadas direto no Supabase, na Edge Function e no n8n; código nesta branch).

## Onde está cada peça
- **Repo** `clinicacsiia/webchat`: `index.html` (chat do paciente), `painel/index.html` (painel do atendente), `supabase/*.sql` (estado final das funções), `supabase/functions/sync-catalogo-klingo/` (`index.ts` + `conferencia.ts` + `conferencia.test.ts`), `docs/`.
- **Supabase** projeto `webchat-atendimento` (`nrvuynjwcgwpjdptkiay`). Crons (UTC): `sync-catalogo-klingo` 0 6; `catalogo-precos-convenio` 10 6; `catalogo-precos-particular` 25 6; `agenda-ocupacao` a cada 10 min das 8h às 1h; **`agenda-conferir` a cada 15 s** (só dispara se houver pré-agendamento esperando); **`agenda-revisar` a cada 10 min** (inclui os já confirmados, para ver cancelamento/remarcação).
- **Edge Function** `sync-catalogo-klingo` v9. Header `x-sync-key` = `config.ia_segredo`; modos `{}` (catálogo), `{"inspecionar":id}`, `{"precos":"convenio"|"particular"}`, `{"agenda":"ocupacao"}`, `{"agenda":"conferir"}` (+ `"lento":true`).
- **n8n** workflow `wAbzjPqZNCztKriZ` "Triagem IA - Atendimento", versão ativa `7bcf2009-34ff-4085-a17f-a931ff68188f` (prompt com "paciente que volta" e `reaproveitar`).
- **Klingo**: relatórios via `https://api-externa.klingo.app/api/info/relatorio?id=…`, header `X-APP-TOKEN` (secret `KLINGO_APP_TOKEN`, só na Edge Function). #13981 procedimentos, #13984 agenda, #12301 planos, #13983 preços convênio, #13825 marcações (Particular), #7 agendas marcadas, #47 bloqueado. Colunas do #7: Unidade, Marcacao, Data_Atendimento, Medico, Paciente, Operadora, Prontuario, Telefone, Procedimento, Previsto, Obs, Status (A Confirmar/Confirmado/Sem Resposta: não mostra cancelados), Data_Agendamento, Usuario, Origem, Quantidade.

## O que a Fase 3 faz (`supabase/fase3-conferencia-automatica.sql`)
- A Edge Function lê o #7 só dos dias com pré-agendamento esperando e compara **na memória** (últimos 8 dígitos do telefone e nome, mesmo critério de `nome_confere`) com o paciente da conversa. Só o veredito por horário (ok/outro/livre) vai ao banco (`agenda_conferencia_aplicar`). Nome, telefone e prontuário do Klingo não são gravados nem logados.
- Tudo bateu → `status = agendado` sozinho, `conferencia_status = confirmado` (+ `conferencia_via`), e uma mensagem de confirmação ao paciente no chat (exames, dia/hora/unidade, preparo do cadastro), uma vez só (`confirmacao_enviada_em`).
- Alertas ao atendente (`conferencia_status` e `conversas.alerta_agenda`, aparecem na lista e no painel): `horario_tomado`, `divergente` (mesmo paciente com o exame em outro horário, ou outro exame no horário), `nao_encontrado` (horário passou +1 h sem marcação), `sumiu` (confirmado que deixou de aparecer em 2 revisões seguidas), `remarcado`.
- Ordem de chegada também é conferida (qualquer hora do dia, mesma sala/unidade/exame/paciente), mas nunca vira "horário tomado".

## O que a Fase 4 faz (`supabase/fase4-paciente-que-volta.sql`)
- `paciente_historico`: uma linha por marcação concluída (gatilho em `pre_agendamentos.status`), cancelada fica marcada, nada é apagado.
- `ia_contexto` devolve `historico_paciente`; os **detalhes só saem com a data de nascimento conferida** (`liberado`). Antes disso a IA só sabe que existe histórico e deve pedir a data de nascimento já na primeira resposta.
- `ia_pre_agendar` aceita `reaproveitar = ultimo | pendente` (copia exames, inclusive o lado, para a conversa nova; `pendente` também copia plano e unidade). Só com data de nascimento conferida e só se a conversa ainda não tem exames.
- Painel: "Histórico do paciente" no cartão do pré-agendamento.

## Regras que não podem ser quebradas
- Dados de paciente do Klingo só passam pela memória da Edge Function para identificar a conversa; **nunca** são gravados, devolvidos ou logados. `agenda_ocupacao` guarda só início, médico, unidade, procedimento, quantidade.
- Preço sempre é **previsão**; atendente humano confirma preço e data. A mensagem de confirmação ao paciente não traz preço.
- Detalhes do histórico só depois da data de nascimento conferida (ao testar `liberado`, usar `coalesce(..., false)`: um NULL já virou "verdadeiro" uma vez).
- Lado D/E: frente L→D, costas L→E; bilateral com lado único é recusado.
- Horários: reserva provisória + advisory lock por dia; folga 15/60 min entre exames; antecedência 120 min.
- Dicas Supabase MCP: `execute_sql` e `apply_migration` pedem confirmação humana se o texto tiver `delete from`/`drop`; testar em `DO $$ … raise exception … $$`; patch de função via `pg_get_functiondef` + `replace`.
- Dados de teste: telefones `7190000xxxx`; os testes desta fase rodaram em transação revertida.

## Pendências
1. **Confirmação humana pendente**: remover as funções provisórias `agenda_conferir_pre_agendamentos()` e `agenda_conferencia_iniciar(boolean)` (sem uso; o `drop` aguarda confirmação, está comentado no fim de `fase3-conferencia-automatica.sql`).
2. Primeira marcação real: acompanhar `cron.job_run_details` e a resposta da Edge Function, e conferir se telefone/nome do Klingo reconhecem o paciente (se o relatório trouxer o telefone em outro formato, ajustar `fonesDaLinha`).
3. Negócio: tempos por modalidade e folgas (15/60 min, 90 min, 48 h, 20 min) são estimativas; preços Particular com confiança média/baixa; e-mail ao suporte do Klingo (rascunho no Gmail; a pergunta 12, webhook de marcação, dispensaria a consulta a cada 15 s).
4. Advisor Supabase: funções `security definer` chamáveis por `anon` são intencionais (token da conversa ou `ia_segredo`); "leaked password protection" no Auth é opcional.

## Fase 5 — aprendizado (próxima)
Usar as correções do atendente (preço/data/exame ajustados; divergências e `conferencia_status` diferente de confirmado; `Previsto` do #7 x preço previsto) para melhorar catálogo e prompt; relatório de erros da IA. Antes: teste curto e2e no chat, `get_advisors`.
