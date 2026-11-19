# Testes

Versão 1.2 — 14/11/2026 / Mudança: testes do pós-agendamento, do próximo horário do médico, da configuração pública, da segurança da `klingo-agendamento`, do painel; ambiente com `pytest`.
Versão 1.1 — 11/11/2026 / Mudança: testes contra o clone da produção, sincronismo telas x banco e cadeia `npm test` completa (69 suítes)
Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial

Esta pasta **não vai para o GitHub Pages** (o site publica a raiz, mas nenhuma página aponta para cá) e não é lida pelo painel. Serve para repetir, em qualquer máquina, a bateria que sustenta a auditoria de `docs/auditoria-2026-10-30.md`.

## Novidade de 11/11/2026: testes contra o banco real

Até 11/11/2026 os testes de banco usavam os arquivos `supabase/*.sql`, que **não batiam com a produção** (31 funções diferentes, 52 só no banco). Agora existe o retrato da produção em `supabase/producao/` e estes testes rodam em cima dele:

| Comando | O que prova | Resultado em 11/11/2026 |
|---|---|---|
| `npm run test:retrato` | Sincronismo: cada função que as 3 telas chamam existe no banco com os mesmos parâmetros e permissões; rotinas e gatilhos apontam para funções que existem; nenhuma função chama outra que não existe; toda tabela com RLS. Sem banco, 1 segundo | 10 de 10 |
| `npm run test:producao-sql` | Monta o clone da produção e, para cada defeito da auditoria, primeiro **reproduz** com a função antiga (`antes-da-auditoria-1111/`) e depois confere a correção: avalanche de avisos, "Agendado" rápido com resposta idêntica, mapa do corpo guardado, limpeza, segurança | 29 de 29 |
| `npm run test:ponta-a-ponta` | Com o **código real do banco**: paciente do "Começar" ao pedido enviado (exame e consulta), horário reservado, limites, token errado, paciente logado sem acesso, equipe assumindo, respondendo e encerrando, reabertura em 2 dias, rotinas do sistema | 19 de 19 |
| `npm run test:equipe-assume` | Chat no navegador: a equipe assume e as perguntas do assistente se desligam; corrida; uma resposta por vez; falha de rede isolada não vira alarme | 9 de 9 |
| `npm run test:painel-recarga` | Painel no navegador com o tempo real do Supabase simulado: consultas pesadas não se repetem a cada mensagem; nunca duas releituras ao mesmo tempo | 4 de 4 |
| `npm run test:equipe-agora` | Painel > botão "Equipe agora" da chefia: contagem por atendente (atendendo, paciente esperando, esperando o paciente, zap, marcou hoje), só para TI/gerência/supervisão | 5 de 5 |
| `npm run test:indicadores-erros-reais` | Clone da produção, dados inventados: reproduz os 3 erros reais dos indicadores com as funções de antes (`antes-erros-reais/`) e confere a correção: pessoa sem unidade conta num balde "sem" e as unidades somam o total; encerrada como "Agendado" sem pedido agendado não entra nas etapas do meio do funil; crédito do atendente só para quem marcou ou escreveu, sem contar cancelado (remarcado conta) | 11 de 11 |
| `npm run test:indicadores-cinco` | Clone da produção, dados inventados: os 5 números do topo da aba Indicadores (procuraram, atendidos, agendaram confirmado no Klingo, robô sozinho, faltaram ou cancelaram), todos em pessoas pelo dia em que abriram o chat; remarcada não conta como perda, conversa de teste fica fora, filtro só exames, período e permissão | 8 de 8 |
| `npm run test:agendou-credito` | Clone da produção: agendamento confirmado sozinho com o Klingo é creditado ao dono da conversa (ou a quem mais escreveu); marcado à mão fica com quem marcou | 6 de 6 |
| `npm run retrato:montar` | Só monta o clone e diz se algum comando do retrato não entrou | 425 funções, 101 tabelas |

`banco-producao.mjs` é a peça que monta o clone (Postgres embutido + Supabase simulado + as chaves de `config` como estão na produção). Qualquer teste novo de banco deve partir dele: `const { db } = await criarBancoProducao()`.

Depois de mudar o banco, refaça o retrato (`supabase/producao/LEIAME.md`), senão estes testes conferem o banco de ontem.

Para simular outra hora do dia (um teste já falhou só das 21h às 00h20): `RELOGIO_UTC=01:10 node --import ./relogio-falso.mjs sql-pessoa.test.mjs`.

## Como rodar

Requisitos: Node 22 ou mais novo, Python 3.10 ou mais novo com `pytest`, e um Chromium.

```bash
cd testes
npm install
export CHROMIUM_PATH=/caminho/do/chromium   # ou: npx playwright install chromium
npm test
```

`npm test` roda as suítes na ordem abaixo e para na primeira que falhar. Cada uma também roda sozinha.

| Comando | O que prova | Resultado em 30/10/2026 |
|---|---|---|
| `npm run test:edge` | Conferência da marcação no Klingo e leitura de preços (`supabase/functions/sync-catalogo-klingo/`) | 27 de 27 |
| `npm run test:sql` | `supabase/fila-biometria.sql` num Postgres embutido (PGlite): RLS, JWT, máquina de estados, 3 tentativas, imutabilidade, broadcast | 46 de 46 |
| `npm run test:delta` | `supabase/fila-biometria-v2-delta.sql` aplicado sobre o estado v1 dá o mesmo banco da instalação nova (corpo, *definer* e privilégio de execução das 23 funções) | 5 de 5 |
| `npm run test:sw` | O `sw.js` não serve `/fila/` (nem `/painel/`) pelo cache do chat; a URL da fila leva o token e a chave única `./` serviria o chat no lugar da fila | 10 de 10 |
| `npm run test:navegador` | Chat, painel (deslogado e admin) e fila abrem e montam a tela sem exceção de JavaScript | 6 de 6 |
| `npm run test:sentinela` | Funções puras da Sentinela (`sentinela.js`): código de rastreio, limiares aprendidos, ordem, classificação de erro, privacidade | 14 de 14 |
| `npm run test:nomes` | `nomes-exame.js` com nomes reais do catálogo de produção: prefixo, `(UNILATERAL)`, parênteses, nome cortado, ordem e repetidos | 28 de 28 |
| `npm run test:sql9` | `supabase/fase9-sentinela.sql` num Postgres embutido: incidentes, token, limite, painel, textos só trocados se forem os originais | 14 de 14 |
| `npm run test:convenio` | `supabase/correcao-convenio-quem-volta.sql` sobre as funções reais do motor: o convênio da vez anterior vira pergunta (sim/não, por botão e por texto), a correção do plano tira a carteirinha só se o convênio mudou, trocar a consulta refaz o horário, aplicar duas vezes e recusar função diferente do esperado | 20 de 20 |
| `npm run test:meus-dados` | `supabase/meus-dados.sql` num Postgres embutido: anônimo e equipe recusados, a cópia traz só os dados da própria conta e nada interno, a exclusão apaga só o login e solta o vínculo (cadastro, pedidos, conversas e histórico ficam), registro sem dado pessoal, só o administrador lê o registro | 15 de 15 |
| `npm run test:corrida` | Chat no navegador com o Supabase simulado e atrasos controlados: resposta que chega antes da mensagem do paciente, cursor de consulta, cópia de outra versão | 4 de 4 |
| `npm run test:historico` | Conversas anteriores no chat: guarda as últimas 5 por aparelho, reabre uma antiga com as mensagens do servidor, atalho no formulário, "Sair" apaga a lista, token inválido sai da lista | 7 de 7 |
| `npm run test:sentinela-navegador` | Cada regra da Sentinela no navegador, aviso de IA, mensagem de previsão, letra maior, lista do corpo alinhada nomes de exame legíveis e lado visível e confirmado | 19 de 19 |

## Teste de carga (100 pacientes)

`testes/carga.mjs` simula 100 pacientes ao mesmo tempo chamando as mesmas funções RPC do `index.html` (`chat_config`, `chat_iniciar`, `chat_listar` a cada 4 s, `chat_responder`, `chat_enviar`). Mede tempo (p50/p95/p99) e erros por chamada e, **junto com a carga**, prova as travas de proteção: token errado (28000), 20 mensagens por minuto (54000), 5 conversas por hora por telefone (54000) e dados inválidos (22023 e não 5xx). Sai com código 1 se o p95 passar de 1,5 s, houver mais de 1% de erro inesperado ou uma trava falhar.

| Comando | O que faz |
|---|---|
| `npm run test:carga` | Roda contra um servidor de mentira (`carga-simulado.mjs`). Seguro; só prova que o próprio teste mede e reprova direito. Os tempos não dizem nada sobre o Supabase. |
| `CARGA_CONFIRMO=SIM npm run carga` | Roda contra o Supabase **real**. Cria 100 conversas "TESTE DE CARGA nnn" (e-mail `@example.invalid`) que a equipe vê no painel. Sem `CARGA_CONFIRMO=SIM` o script se recusa. |

Depois de rodar na produção, execute `testes/carga-limpeza.sql` no SQL Editor (primeiro o `select` de conferência, depois o `delete`). Prefira horário sem atendimento e avise a equipe.

Ajustes por variável: `CARGA_USUARIOS` (100, máx. 300), `CARGA_RAMPA_S` (10), `CARGA_DURACAO_S` (60), `CARGA_P95_MAX_MS` (1500), `CARGA_ERROS_MAX_PCT` (1), `CARGA_JSON` (grava o resultado num arquivo), `CARGA_URL` e `CARGA_KEY` (outro projeto, por exemplo um de homologação, o que é o mais indicado).

Não mede: Realtime por WebSocket, n8n, Klingo, o painel da equipe nem o navegador do paciente. Com Realtime funcionando a carga real é menor que a medida aqui (a consulta cai de 4 s para 20 s).

## O que estes testes NÃO provam

Leia isto antes de tratar "tudo verde" como "pronto para produção".

- **Não falam com o Supabase, o n8n nem o Klingo reais.** O banco é o PGlite (Postgres 16) com *stubs* de `auth`, `vault`, `net`, `realtime` e do HMAC. O teste de navegador usa um Supabase simulado. O comportamento do Realtime por WebSocket, o CORS do webhook do n8n e a entrega de e-mail ficam sem prova.
- **O teste de navegador é de fumaça**: prova que o JavaScript carrega e a tela monta. Não prova que os dados certos aparecem.
- **O estado do banco real** foi conferido por outro caminho (impressão digital das 21 funções do módulo contra a v1 do repositório, feita pelo MCP do Supabase durante a auditoria). Não há script para isso aqui porque depende de acesso ao projeto.
- O limiar 0,30 foi testado como regra (aprova com score ≥ 0,30, reprova abaixo). **Não** foi calibrado com assinaturas reais.

## Arquivos

| Arquivo | Papel |
|---|---|
| `stubs-supabase.mjs` | Monta o banco de teste: papéis, `auth`, `vault`, `net`, `realtime`, HMAC-SHA256 sobre `sha256`. Extrai do SQL real as funções auxiliares pelo nome, para o teste exercitar o código de produção e não uma cópia. |
| `sql-fila.test.mjs` | As 46 verificações do módulo Fila. |
| `sql-delta.test.mjs` | As 5 verificações do delta v1 → v2. |
| `sw.test.mjs` | Roda o `fetch` do `sw.js` num contexto isolado e confere o que entra ou não no cache. |
| `navegador.smoke.mjs` | Servidor local + Playwright + Supabase simulado. `CHROMIUM_PATH` aponta para um Chromium já instalado. |

Os testes das Edge Functions ficam em `supabase/functions/sync-catalogo-klingo/*.test.ts`, junto do código que testam.

## WebChat v2 (14/11/2026)

| Arquivo | O que prova |
|---|---|
| `sql-webchat-v2-sempre-ligado.test.mjs` | Desde 14/11/2026 o autoatendimento do Klingo é SEMPRE LIGADO (`supabase/webchat-v2-sempre-ligado.sql`): chaves de modo, mestre e lista de teste não decidem mais nada; laudo (`klingo_api_resultado`) segue a configuração; autogestão removida; proteção da página pública e auditoria de config continuam. (Substitui o antigo `sql-webchat-v2-modos.test.mjs`, apagado.) |
| `sql-webchat-v2-calendario.test.mjs` | O calendário só mostra ofertas da API; sem oferta não vira vaga da grade; escolha só de oferta válida. |
| `sql-webchat-v2-disponibilidade.test.mjs` | Solicitação de disponibilidade futura: criar, editar, cancelar, expirar, vaga compatível/incompatível, aviso sem duplicar, sem autorização, filhos diferentes, acesso cruzado, motor em sombra. |
| `sql-webchat-v2-agendamento.test.mjs` | Pipeline de marcação **existente** (`klingo_operacao`): duplo clique, duas chamadas, incerto, retentativa, horário tomado, divergência, vários exames. Klingo **simulado**. |
| `sql-webchat-v2-rollback.test.mjs` | HISTÓRICO (fora do `npm test` desde 15/11/2026): provava que reaplicar as funções do retrato desfazia a migração v2. O retrato de hoje já é o v2 "sempre ligado", então não há mais "comportamento anterior" para voltar e a verificação não pode passar. Script `test:v2-rollback`, só para consulta. |
| `sql-webchat-v2-medicos.test.mjs` | Próximo horário de cada médico só da API (a grade nunca vira horário) e aceite de oferta antiga só pela API. |
| `sql-webchat-v2-pos.test.mjs` | Pós-agendamento com o Klingo **simulado**: ver minhas marcações, cancelar (confirmação, 24 h, incerto), remarcar (antigo ativo/cancelado, incerto, ocupado, sem pedido original), resultado de exame, "não fica preso", webhook, auditoria de coerência. |
| `sql-webchat-v2-publico.test.mjs` | HISTÓRICO (fora do `npm test` desde 15/11/2026; script `test:v2-publico`, só para consulta): configuração pública antiga (arquivo `webchat-v2-config-publica.sql`, apagado em 14/11/2026 porque o v2 ficou sempre ligado). Aplica as partes antigas em cima do banco e descreve o caminho que existiu, não o de hoje. |
| `sql-klingo-agendamento-seguranca.test.mjs` | Trava no servidor da função pública `klingo-agendamento` (IP, CPF, escritas, desligamento, só hashes, permissões). Testes da função em si: `../supabase/functions/klingo-agendamento/agendamento.test.ts`. |
| `pos-agendamento.navegador.mjs` | Tela do chat: espera com título, lista de marcações, confirmação de cancelamento. |
| `painel-v2.navegador.mjs` | Painel (admin): Disponibilidade futura (filtros e cancelar), chaves do autoatendimento por capacidade, indicadores do pós-agendamento. |
| `calendario-api.navegador.mjs` | Tela do paciente: os 4 estados, 3 saídas, formulário de disponibilidade, "Minha disponibilidade", aviso de vaga. |
| `previsao.navegador.mjs` | Painel "Disponibilidade futura" (filtros por situação). |
| `../supabase/functions/chat-agenda-api/diagnostico.test.ts`, `../supabase/functions/disponibilidade-vigia/vigia.test.ts` | Diagnóstico por etapa da resposta da API (vazio × estrutura inválida × tudo filtrado × expirado) e janelas de 15 dias. |

**Retirado da corrente de `npm test` (14/11/2026):** `sql-klingo-auto.test.mjs` (script `test:klingo-auto-sql-legado`). Ele reaplicava as 15 partes `klingo-auto-*` sobre o retrato; como o retrato agora **é** a produção (que já contém essas partes) e o fluxo mudou (CPF primeiro), 21 das 73 verificações falham por motivo do teste, não do código. Reescrevê-lo contra o fluxo atual está em `docs/reestruturacao-2026-11-14/05-pendencias.md` (limitação 1).

**Carga (15/11/2026):** os testes de navegador (`acesso-chat`, `catalogo-painel`, `ao-vivo`, `medicos`) usam esperas curtas e falham de vez em quando se rodarem 4 ou mais ao mesmo tempo; sozinhos passam. Rodar as suítes uma por vez (ou no máximo 2 em paralelo) antes de concluir que a tela quebrou.

**Ambiente:** Os testes de navegador rodam com `CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome` (a variável não persiste entre comandos: defina no mesmo comando).
