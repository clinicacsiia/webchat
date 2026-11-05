-- FLUXOGRAMA: entrada (todo usuário novo do Supabase Auth, via gatilho on_auth_user_created) -> validação (primeiro usuário? e-mail convidado? veio da tela de cadastro da EQUIPE, marcada com origem='equipe' nos metadados? chave config.cadastro_equipe_sem_convite?) -> lógica (equipe vira linha INATIVA em agentes e aparece na aba Avisos depois de confirmar o e-mail; paciente continua indo para contas_paciente) -> saída (agentes ou contas_paciente)
-- Versão 1.0 — 05/11/2026 / Mudança: pedido de acesso da equipe sem convite passa a criar a linha inativa em agentes (antes caía em contas_paciente e nunca aparecia em Avisos)
-- Só troca a função do gatilho (create or replace). Nada é apagado. Pode ser aplicado mais de uma vez.
-- Segurança: a linha criada é sempre INATIVA e atendente; só administrador libera (equipe_pedido_decidir).

create or replace function public.novo_usuario() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v_primeiro boolean; v_email text := lower(btrim(coalesce(new.email, ''))); v_papel text; v_nome text;
begin
  v_nome := coalesce(nullif(btrim(new.raw_user_meta_data ->> 'nome'), ''), nullif(split_part(coalesce(new.email, ''), '@', 1), ''), 'Sem nome');
  select not exists (select 1 from public.agentes) into v_primeiro;
  if v_primeiro then
    insert into public.agentes (id, nome, email, papel, ativo) values (new.id, v_nome, new.email, 'admin', true);
    return new;
  end if;
  if v_email <> '' then
    update public.equipe_convites set usado_em = now() where email = v_email and usado_em is null returning papel into v_papel;
  end if;
  if v_papel is not null then
    insert into public.agentes (id, nome, email, papel, ativo) values (new.id, v_nome, new.email, v_papel, false);
  elsif coalesce(new.raw_user_meta_data ->> 'origem', '') = 'equipe'
     or coalesce((select valor from public.config where chave = 'cadastro_equipe_sem_convite'), 'nao') = 'sim' then
    insert into public.agentes (id, nome, email, papel, ativo) values (new.id, v_nome, new.email, 'atendente', false);
  else
    insert into public.contas_paciente (id, email) values (new.id, new.email) on conflict (id) do nothing;
  end if;
  return new;
end $$;
