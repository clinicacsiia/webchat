# 06 — Plano de publicação (nada disso foi executado)

Versão 2.0 — 14/11/2026 / Mudança: reescrito depois das decisões do dono de 14/11/2026 (função `klingo-agendamento` mantida; agendamento automático para todos; pós-agendamento implementado; partes 4 e 5 e configuração pública novas). **Nenhum passo abaixo foi aplicado.** Todos dependem de autorização explícita. Não houve merge, deploy, mudança de configuração produtiva nem operação real no Klingo.

Projeto: `nrvuynjwcgwpjdptkiay` (https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay). Branch de trabalho: `ccr-462c5406-8n7vre`.

## 0. O que muda para o público no momento da publicação (leia antes de autorizar)

Hoje a produção está com o mestre `klingo_auto = sim` e as capacidades em `teste`/`sombra`. **No código antigo, `teste` e `sombra` valem como `sim` para todos** (foi o risco R2). Por isso hoje o público já marca sozinho. A nova lógica **não faz mais isso**: cada capacidade só vale pelo modo dela. Consequência prática:

* Se as migrações forem aplicadas **e a configuração pública não**, o público comum **deixa de marcar sozinho** (cai em "agendado pela nossa equipe", sem horário) até o passo 9.
* Por isso a publicação foi desenhada **numa janela única** (cerca de 1 hora, de preferência de madrugada ou domingo), com o passo 9 (configuração pública) logo depois das migrações. O tempo sem marcação automática é só o dos passos 2 a 8.
* O agendamento automático **existente** não é desligado nem trocado por `teste` em nenhum momento (decisão sua). A configuração produtiva **atual não foi alterada** por esta entrega.

## 1. Pré-requisitos

* Ler `01-diagnostico-e-inventario.md`, `03-matriz-de-configuracao.md` e `07-auditoria-klingo-agendamento.md`.
* Backup lógico das definições: o retrato em `supabase/producao/` **é** o estado "antes" (rollback = reaplicar as funções dali; commit `843b521` não existe mais com esse número depois da limpeza do histórico: usar a pasta `supabase/producao/funcoes/` da branch).
* Avisar a recepção de que haverá teste de marcação e de que o cancelamento de teste é feito por ela.
* Uma pessoa de teste autorizada (telefone na lista `klingo_api_telefones_teste`) e uma agenda que a equipe aceite cancelar.
* Quem ficará de olho nos números durante a hora seguinte (painel > Indicadores > Autoatendimento).

## 2. Ordem de publicação

Cada passo mede-se antes do seguinte. Os SQL são `create or replace`/tabelas novas, aplicados **em partes pequenas** (regra do `CLAUDE.md`: o Supabase expira em 60 s).

| # | O quê | Arquivo / como | Verificação | Reversão |
|---|---|---|---|---|
| 1 | **Segurança da `klingo-agendamento`** (independente de tudo; pode ir antes, em outro dia) | `supabase/klingo-agendamento-seguranca.sql` e depois a função v1.1 (`supabase/functions/klingo-agendamento/`) | chamada de teste: `acao: "versao"` responde; 61 chamadas em 1 minuto do mesmo IP → 429 | publicar a v2 anterior do Supabase; a tabela pode ficar |
| 2 | **Parte 1** (modos por capacidade, auditoria, autogestão, `klingo_consulta`, chave `klingo_api_consultar`) | `supabase/webchat-v2-parte1-modos.sql` | `select klingo_modo(<conversa>, 'klingo_api_marcar')`; `config_auditoria` existe | reaplicar `supabase/producao/funcoes/{klingo_ativo,klingo_liberado,klingo_decidir,klingo_autogestao,klingo_pode_marcar}.sql` |
| 3 | **Edge Functions** `chat-agenda-api` v2, `klingo-executar` v1.1 (+ cópias de `klingo-api.ts` em `klingo-identificar` e `klingo-sincronizar`) e `disponibilidade-vigia` (nova) | deploy das pastas; **`klingo-executar` v1.1 precisa estar no ar antes da parte 5** | uma conversa de teste gera linha em `klingo_consulta` | redeploy da versão anterior |
| 4 | **Parte 2** (calendário só com ofertas da API) | `supabase/webchat-v2-parte2-calendario-api.sql` | conversa de teste: calendário = ofertas | reaplicar `funcoes/{chat_horarios,chat_horario_escolher,previsao_buscar,pedido_horario_vigiar}.sql` |
| 5 | **Parte 4** (próximo horário do médico só da API; aceite de oferta antiga só pela API) | `supabase/webchat-v2-parte4-medicos-api.sql` | lista de médicos sem horário estimado | reaplicar `funcoes/{medicos_disponiveis_interno,fluxo_aplicar}.sql` |
| 6 | **Parte 3** (solicitação de disponibilidade futura) | `supabase/webchat-v2-parte3-disponibilidade-futura.sql` | `select count(*) from disponibilidade_pedido` = 0 | as tabelas podem ficar; reaplicar `funcoes/{previsao_ativa,previsao_vigiar}.sql` |
| 7 | **Parte 5** (pós-agendamento, 24 h, resultado, "não fica preso") | `supabase/webchat-v2-parte5-pos-agendamento.sql` (os encaixes em funções existentes **param sem mudar nada** se o trecho esperado não for achado exatamente uma vez) | assunto "Ver minhas marcações" aparece só com a chave ligada | reaplicar `funcoes/{fluxo_proximo,fluxo_perguntar,fluxo_aplicar,fluxo_avancar,fluxo_ler_texto,chat_voltar,klingo_operacao_concluir,klingo_operacao_criar,klingo_pode_marcar,klingo_evento_aplicar,painel_automacao_resumo}.sql` |
| 8 | **Tela do chat e painel** | merge em `main` (GitHub Pages): `VERSAO_APP 2026.11.14-2`, `sw cliente v40`, `sw painel v25` | abrir em celular e desktop | reverter o commit (volta em ~1 min). A tela nova chama funções das partes 3 e 5: **só depois do passo 7** |
| 9 | **Configuração pública** | `supabase/webchat-v2-config-publica.sql` (uma chave por linha; apague as que não quiser) | painel mostra tudo "Ligado para todos"; conversa de teste **fora** da lista marca | `update config set valor='teste' …` (bloco de reversão no próprio arquivo) ou `klingo_auto = nao` (desliga tudo na hora) |
| 10 | **Refazer o retrato** e rodar `npm run test:retrato` | `supabase/producao/LEIAME.md` | a lista "aguardam a migração" some | — |

Dependência real: 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. O passo 1 não depende de nada.

## 3. Validação logo depois (sem pacientes reais)

1. Paciente de teste (na lista ou, depois do passo 9, qualquer telefone): marcar um horário **real** da API, conferir no Klingo, **cancelar pelo chat** e conferir que sumiu do Klingo.
2. "Ver minhas marcações" com um paciente que tem marcação feita no balcão.
3. Remarcar uma marcação feita pelo chat; conferir no Klingo que **só uma** ficou ativa.
4. Registrar uma solicitação de disponibilidade e conferir que **não** aparece em `klingo_operacao`.
5. Painel: Indicadores mostra cancelamentos e remarcações; Disponibilidade futura mostra a solicitação.
6. **Não há como provar de antemão** o que o Klingo real devolve em cada caso (todos os testes automáticos usam Klingo simulado). Os 6 itens acima são o teste real; façam com paciente e agenda de teste.

## 4. Métricas e critérios de interrupção

| Sinal | Ação |
|---|---|
| Qualquer marcação duplicada, sem protocolo, ou duas ativas depois de remarcar sem aviso da equipe | `klingo_auto = nao` (desliga **tudo** na hora) e abrir incidente |
| Operação `incerta` ≥ 2 em 24 h | a autogestão **recua** a capacidade e avisa; conferir antes de religar |
| `consulta_erro_api`/`consulta_limite` > 5 % em 1 h | painel; a tela já diz "não foi possível consultar" (não confunde com falta de vaga) |
| Aviso de vaga a quem não autorizou | `notificacao_modo = nao` e `previsao_monitor_modo = nao` |
| Reclamação de dado exposto | `klingo_auto = nao` e incidente (LGPD) |
| 429 em excesso na `klingo-agendamento` | ajustar as chaves `agendamento_*` ou `agendamento_externo_modo = leitura` |

## 5. Rollback geral

Cada migração é `create or replace` ou tabela/coluna **nova** (nada é apagado). Reaplicar as funções de `supabase/producao/funcoes/` da branch (estado de antes) e as chaves em `03-matriz-de-configuracao.md`. As tabelas novas (`config_auditoria`, `klingo_consulta`, `klingo_marcacao`, `klingo_agendamento_evento`, `disponibilidade_*`) e a coluna `klingo_oferta.sombra` podem ficar.

## 6. O que continua pendente do lado do Klingo

Ver `05-pendencias.md` seção A. Em especial: **resultado de exame** (sem endpoint confirmado), **webhook** (URL e cadastro), **remarcação atômica** (a verificação do voucher antigo cobre o risco, mas a garantia do lado deles não foi confirmada) e **limite real de chamadas por minuto** (dimensiona o motor de vagas).
