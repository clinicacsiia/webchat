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

`npm test` roda as seis suítes na ordem abaixo e para na primeira que falhar. Cada uma também roda sozinha.

| Comando | O que prova | Resultado em 30/10/2026 |
|---|---|---|
| `npm run test:edge` | Conferência da marcação no Klingo e leitura de preços (`supabase/functions/sync-catalogo-klingo/`) | 27 de 27 |
| `npm run test:python` | Algoritmo biométrico (`biometria/avaliar_assinatura.py`), inclusive executado com os *builtins* restritos do nó Python do n8n | 27 de 27 |
| `npm run test:sql` | `supabase/fila-biometria.sql` num Postgres embutido (PGlite): RLS, JWT, máquina de estados, 3 tentativas, imutabilidade, broadcast | 46 de 46 |
| `npm run test:delta` | `supabase/fila-biometria-v2-delta.sql` aplicado sobre o estado v1 dá o mesmo banco da instalação nova (corpo, *definer* e privilégio de execução das 23 funções) | 5 de 5 |
| `npm run test:sw` | O `sw.js` não serve `/fila/` (nem `/painel/`) pelo cache do chat; a URL da fila leva o token e a chave única `./` serviria o chat no lugar da fila | 10 de 10 |
| `npm run test:navegador` | Chat, painel (deslogado e admin) e fila abrem e montam a tela sem exceção de JavaScript | 6 de 6 |

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
