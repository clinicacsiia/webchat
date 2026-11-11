# Preferências de trabalho (dono do projeto)

- **Sempre que o dono precisar fazer algo (aprovar, colar um segredo, abrir uma tela), entregue o link direto** da página onde a ação acontece. Projeto Supabase: `nrvuynjwcgwpjdptkiay` (https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay).
- Arquivo que só existe na sessão (ex.: chave gerada) não tem link: **envie o arquivo para o dono** e diga o link onde usar. Segredo nunca vai para o repositório nem para uma página publicada.
- Responda em português do Brasil, em linguagem simples.
- A ferramenta de migração do Supabase pede confirmação em comandos que parecem destrutivos (ex.: `drop trigger`) e expira em 60 s; prefira `create or replace` e divida migrações em partes menores.
- **Relatórios do Klingo (pendência crítica):** antes de começar qualquer tarefa que dependa de dado do Klingo, **avise o dono** se ainda há relatório a editar ou criar (lista em `docs/klingo-relatorios-pendentes.md`) e diga qual falta. Não suponha colunas ou filtros que o relatório não tem.

# Como trabalhar neste repositório (desde a auditoria de 11/11/2026)

- **Comece por `docs/DOCUMENTACAO.md`** (o sistema inteiro) e `docs/pendencias-do-dono.md` (o que depende do dono).
- **A verdade do banco é `supabase/producao/`** (retrato da produção, uma função por arquivo). Os arquivos `supabase/*.sql` são o histórico das mudanças e podem estar diferentes do banco. Para mexer numa função, parta de `supabase/producao/funcoes/<nome>.sql`.
- **Toda mudança de banco:** arquivo novo em `supabase/` (fluxograma, versão, rollback) → testar no clone (`testes/sql-producao.test.mjs`, `testes/sql-ponta-a-ponta.test.mjs`) → aplicar em partes → medir o efeito na produção → **refazer o retrato** (`supabase/producao/LEIAME.md`) → `npm run test:retrato`.
- **Toda mudança de tela:** trocar `VERSAO_APP` (chat) e `VERSAO` nos `sw.js`; `npm run test:retrato` acusa função ou parâmetro que não existe no banco.
- Na produção, ler só estrutura, contagens, tempos e erros técnicos. Nunca nome, telefone, CPF ou texto de conversa.
- O dono trabalha em várias sessões ao mesmo tempo: **antes de continuar um trabalho parado, `git fetch` e comparar com a `main` e com as migrações aplicadas** (`supabase_migrations.schema_migrations`).

