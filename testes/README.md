# Testes

Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial

Esta pasta **não vai para o GitHub Pages** (o site publica a raiz, mas nenhuma página aponta para cá) e não é lida pelo painel. Serve para repetir, em qualquer máquina, a bateria que sustenta a auditoria de `docs/auditoria-2026-10-30.md`.

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
| `npm run test:python` | Algoritmo biométrico (`biometria/avaliar_assinatura.py`), inclusive executado com os *builtins* restritos do nó Python do n8n | 27 de 27 |
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

Os testes do Python ficam em `biometria/test_avaliar_assinatura.py` e os da Edge Function em `supabase/functions/sync-catalogo-klingo/*.test.ts`, junto do código que testam.
