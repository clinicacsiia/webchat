-- Respostas prontas (aba "Atalhos" do painel). Escrito em 11/11/2026.
-- O administrador cadastra modelos de resposta com um atalho (ex.: "bomdia"). Na conversa, a equipe digita "/" e o atalho e o texto entra na caixa de resposta.
-- Todos da equipe (admin e atendente) leem; só o administrador cria, edita e apaga. Pode ser aplicado de novo sem efeito.
-- Para voltar atrás: drop table public.respostas_prontas;

create table if not exists public.respostas_prontas (
  id uuid primary key default gen_random_uuid(),
  atalho text not null,
  texto text not null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint respostas_prontas_atalho_ck check (atalho ~ '^[a-z0-9_-]{1,30}$'),
  constraint respostas_prontas_texto_ck check (length(btrim(texto)) between 1 and 4000)
);
create unique index if not exists respostas_prontas_atalho_uq on public.respostas_prontas (atalho);

alter table public.respostas_prontas enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'respostas_prontas' and policyname = 'respostas_prontas_select') then
    create policy respostas_prontas_select on public.respostas_prontas for select using ((select public.papel_atual()) is not null);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'respostas_prontas' and policyname = 'respostas_prontas_insert') then
    create policy respostas_prontas_insert on public.respostas_prontas for insert with check ((select public.papel_atual()) = 'admin');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'respostas_prontas' and policyname = 'respostas_prontas_update') then
    create policy respostas_prontas_update on public.respostas_prontas for update using ((select public.papel_atual()) = 'admin') with check ((select public.papel_atual()) = 'admin');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'respostas_prontas' and policyname = 'respostas_prontas_delete') then
    create policy respostas_prontas_delete on public.respostas_prontas for delete using ((select public.papel_atual()) = 'admin');
  end if;
end $$;
revoke all on public.respostas_prontas from anon;
grant select, insert, update, delete on public.respostas_prontas to authenticated;
