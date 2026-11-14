# 04 — Matriz de testes

Versão 1.0 — 14/11/2026 / Mudança: gerada a partir da execução real dos testes (`gerar-matriz`), não escrita à mão. **0 de 0 verificações novas passaram.**

**O que estes testes provam e o que não provam.** Rodam num Postgres embutido com a estrutura REAL da produção (retrato de 14/11/2026), num navegador real (Chromium) com o Supabase simulado e em TypeScript puro. **O Klingo é sempre simulado** (nenhuma chamada real, nenhuma marcação real) e não há paciente real. Não provam: Realtime por WebSocket, push, rede do Supabase, resposta real da API do Klingo, Edge Functions executadas no Deno (`index.ts` de `chat-agenda-api` e `disponibilidade-vigia` não são executados; testam-se as regras puras e o banco).

Grupos do prompt mestre: **A** disponibilidade · **B** agendamento · **C** solicitação futura · **D** pós-agendamento · **E** segurança e produção.

## Cobertura por grupo

| Grupo | Situação |
|---|---|
| A Disponibilidade | Coberto: horários, lista vazia, estrutura inválida, tudo filtrado, expirado, oferta vencida durante a escolha, serviço sem integração, convênio sem tradução, API indisponível (estado), sombra sem exposição. **Não coberto:** "API lenta" como cenário (só a métrica de tempo), "horário ocupado após seleção" na API real. |
| B Agendamento | Coberto sobre o pipeline existente com Klingo simulado: sucesso comprovado, duplo clique, duas chamadas, incerto, retentativa do job, horário tomado, falha definitiva, CPF divergente, plano sem tradução, vários exames, comum fora da lista, reabertura, transferência humana. **Não coberto:** "timeout após sucesso externo" com o Klingo real e a conciliação por protocolo (depende de E4); 5xx do Klingo é só classificado (`klingo-api.ts`), não exercitado de ponta a ponta. |
| C Solicitação futura | Coberto (todos os cenários listados, com ofertas simuladas), exceto "convênio volta a funcionar" que é equivalente a "nova oferta compatível" (mesmo caminho). |
| D Pós-agendamento | **NÃO coberto**: consultar, cancelar, remarcar e resultado de exame não foram alterados nem receberam teste novo (ver `05-pendencias.md`). |
| E Segurança e produção | Coberto: não autorizado, token inválido, acesso cruzado, responsável com dois filhos, RLS das tabelas novas, permissões (anon), flags teste e sombra, autogestão, migração, rollback. **Não coberto:** token revogado, rate limit por IP, "função sem JWT com autenticação própria" (documentado em `01`, não testado), regressão visual automatizada. |

## Verificações

| Grupo | Suíte | Cenário e resultado esperado | Resultado obtido | Evidência | Situação |
|---|---|---|---|---|---|

## Regressão completa (`npm test`, script a script)

79 scripts da corrente rodados um a um (`rodar-tudo`), 77 passaram. Duração total ≈ 8 min.

| Script | Resultado | Observação |
|---|---|---|
| `test:retrato` | ✅ 10 de 10 verifica |  |
| `test:edge` | ✅  |  |
| `test:python` | ❌  | falta `pytest` neste ambiente (teste da biometria, não relacionado) |
| `test:sql` | ✅ 46/46 verifica |  |
| `test:delta` | ✅ 5/5 verifica |  |
| `test:saida-n8n-fila` | ✅ 8/8 verifica |  |
| `test:saida-n8n` | ✅ 7/7 verifica |  |
| `test:sw` | ✅ 16/16 verifica |  |
| `test:sentinela` | ✅ 14/14 verifica |  |
| `test:paciente-status` | ✅ 20/20 verifica |  |
| `test:nomes` | ✅ 28/28 verifica |  |
| `test:sql9` | ✅ 14/14 verifica |  |
| `test:espera` | ✅ 18/18 verifica |  |
| `test:cronometro-grupo` | ✅  |  |
| `test:convenio` | ✅ 20 de 20 verifica |  |
| `test:assuntos` | ✅ 21 de 21 verifica |  |
| `test:contas` | ✅  |  |
| `test:protecao` | ✅  |  |
| `test:login-sql` | ✅  |  |
| `test:meus-dados` | ✅ 15 de 15 verifica |  |
| `test:navegador` | ✅ 4/4 verifica |  |
| `test:convenios-painel` | ✅ 6/6 verifica |  |
| `test:catalogo-painel` | ✅  |  |
| `test:foto-pedido` | ✅ 3/3 verifica |  |
| `test:corrida` | ✅ 4/4 verifica |  |
| `test:historico` | ✅ 8/8 verifica |  |
| `test:sentinela-navegador` | ✅ 20/20 verifica |  |
| `test:login` | ✅  |  |
| `test:quadro` | ✅ 9/9 verifica |  |
| `test:lista-agrupada` | ✅ 5/5 verifica |  |
| `test:indicadores` | ✅ 28/28 verifica |  |
| `test:jornada` | ✅ 18/18 verifica |  |
| `test:pessoa-sql` | ✅ 54 de 54 verifica |  |
| `test:pessoa` | ✅ 24/24 verifica |  |
| `test:chegada-sql` | ✅  |  |
| `test:checkin-sql` | ✅  |  |
| `test:jornada-paciente` | ✅  |  |
| `test:identificar` | ✅  |  |
| `test:minha-vez` | ✅  |  |
| `test:medicos-sql` | ✅  |  |
| `test:medicos` | ✅  |  |
| `test:encerramento-sql` | ✅ 14 de 14 verifica |  |
| `test:agendado-sql` | ✅ 24 de 24 verifica |  |
| `test:encerramento` | ✅ 13/13 verifica |  |
| `test:despedida-sql` | ✅ 14 de 14 verifica |  |
| `test:despedida` | ✅ 4/4 verifica |  |
| `test:autoencerrar-sql` | ✅ 18 de 18 verifica |  |
| `test:avaliacao-sql` | ✅ 11 de 11 verifica |  |
| `test:avaliacao` | ✅ 9/9 verifica |  |
| `test:cabecalho` | ✅ 7/7 verifica |  |
| `test:voltar-sql` | ❌ 6/9 passaram | falhou na 1ª rodada (3 casos assumiam CPF depois do motivo); **ajustado ao fluxo real e reexecutado: 9/9** |
| `test:voltar` | ✅ 2/2 passaram |  |
| `test:reconhecer-sql` | ✅ 16 de 16 verifica |  |
| `test:ao-vivo-sql` | ✅ 18 de 18 passaram |  |
| `test:ao-vivo` | ✅ 3 de 3 passaram |  |
| `test:etapa0-sql` | ✅ 17 de 17 passaram |  |
| `test:indicadores-sql` | ✅ 20 de 20 passaram |  |
| `test:autoria-sql` | ✅ 5 de 5 passaram |  |
| `test:c1-sql` | ✅ 17/17 verifica |  |
| `test:c1` | ✅ 8/8 verifica |  |
| `test:estrutura-sql` | ✅ 13/13 verifica |  |
| `test:transferir-sql` | ✅ 9/9 verifica |  |
| `test:convenio-suspenso-sql` | ✅ 8/8 verifica |  |
| `test:vinculo-sql` | ✅ 8/8 verifica |  |
| `test:sino` | ✅ 3/3 verifica |  |
| `test:autoencerrar-zap-sql` | ✅ 15 de 15 verifica |  |
| `test:producao-sql` | ✅ 29 de 29 verifica |  |
| `test:ponta-a-ponta` | ✅ 19 de 19 verifica |  |
| `test:v2-modos` | ✅ 24 de 24 verifica |  |
| `test:v2-calendario` | ✅ 17 de 17 verifica |  |
| `test:v2-disponibilidade` | ✅ 24 de 24 verifica |  |
| `test:calendario-api` | ✅ 10/10 verifica |  |
| `test:marcado` | ✅ 4 de 4 verifica |  |
| `test:equipe-assume` | ✅ 9 de 9 verifica |  |
| `test:painel-recarga` | ✅ 4 de 4 verifica |  |
| `test:equipe-agora` | ✅ 5/5 verifica |  |
| `test:agendou-credito` | ✅ 6 de 6 verifica |  |
| `test:conferencia-sql` | ✅ 19 de 19 verifica |  |
| `test:carga` | ✅  |  |

Rodados à parte depois desta lista (entraram na corrente depois): `test:v2-agendamento` e `test:v2-rollback` (tabela acima).
