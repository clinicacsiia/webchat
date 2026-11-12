-- Respostas prontas: atalho com maiúsculas, minúsculas, acentos e até 50 caracteres. Escrito em 12/11/2026.
-- Antes: só a-z, 0-9, - e _, até 30. Agora: letras (com acento, maiúsculas ou minúsculas), números, - e _, até 50.
-- O atalho é guardado do jeito que foi digitado; "Endereço" e "endereço" contam como o mesmo atalho (não pode repetir).
-- Para voltar atrás (só se nenhum atalho novo tiver sido criado):
--   alter table public.respostas_prontas drop constraint respostas_prontas_atalho_ck;
--   alter table public.respostas_prontas add constraint respostas_prontas_atalho_ck check (atalho ~ '^[a-z0-9_-]{1,30}$');
--   drop index if exists public.respostas_prontas_atalho_uq; create unique index respostas_prontas_atalho_uq on public.respostas_prontas (atalho);

-- Parte 1: nova regra do atalho
alter table public.respostas_prontas drop constraint if exists respostas_prontas_atalho_ck;
alter table public.respostas_prontas add constraint respostas_prontas_atalho_ck
  check (atalho ~ '^[A-Za-z0-9À-ÖØ-öø-ÿ_-]{1,50}$');

-- Parte 2: não repetir, sem diferenciar maiúscula de minúscula
create unique index if not exists respostas_prontas_atalho_lower_uq on public.respostas_prontas (lower(atalho));
drop index if exists public.respostas_prontas_atalho_uq;
