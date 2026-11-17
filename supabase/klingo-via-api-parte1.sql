-- FLUXOGRAMA: o Klingo registra o responsável de cada marcação; o da API do chat é `biclinicacsi` -> a leitura do relatório #14554 passa a marcar `via_api` (só sim/não, sem guardar nome nenhum) -> os indicadores separam marcada pela API (com e sem atendente na conversa) de marcada por uma pessoa
-- Versão 1.0 — 17/11/2026 / Mudança: coluna nova `klingo_conferencia.via_api boolean not null default false` (true = o responsável da marcação no Klingo é `biclinicacsi`, a API do chat). Só um sim/não; nenhum nome é guardado.
-- Aplicar em partes (parte1, parte2, parte3), nesta ordem. Teste: `cd testes && npm run test:via-api-sql`.
-- ROLLBACK (parte 1): ver o fim deste arquivo.

alter table public.klingo_conferencia add column if not exists via_api boolean not null default false;
comment on column public.klingo_conferencia.via_api is 'true = marcação feita pela API do chat (responsável biclinicacsi no relatório #14554 do Klingo). Só sim/não, sem nome.';

-- ROLLBACK da parte 1 (só se as partes 2 e 3 também forem desfeitas antes): alter table public.klingo_conferencia drop column via_api;
