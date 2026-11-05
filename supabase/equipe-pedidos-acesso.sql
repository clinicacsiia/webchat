-- FLUXOGRAMA: entrada (pessoa da equipe criou conta e confirmou o e-mail -> linha INATIVA em agentes) -> validação (só administrador; só e-mail confirmado em auth.users) -> lógica (aba Avisos lista o pedido; administrador aprova = ativo true, ou recusa = apaga a conta) -> saída (equipe_pedidos, equipe_pedido_decidir)
-- Versão 1.0 — 05/11/2026 / Mudança: Implementação inicial
-- Nenhum comando destrutivo além da recusa (apaga a conta recusada, que ainda não tinha acesso). Pode ser aplicado mais de uma vez.

create or replace function public.equipe_pedidos() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome, 'email', a.email, 'papel', a.papel, 'criado_em', a.criado_em) order by a.criado_em)
      from public.agentes a join auth.users u on u.id = a.id
     where not a.ativo and u.email_confirmed_at is not null), '[]'::jsonb);
end $$;

create or replace function public.equipe_pedido_decidir(p_agente uuid, p_aprovar boolean, p_papel text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_ok boolean;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Só administrador decide pedidos de acesso.' using errcode = '42501'; end if;
  if p_papel is not null and p_papel not in ('admin','atendente','marketing') then raise exception 'Papel inválido.' using errcode = '22023'; end if;
  select exists (select 1 from public.agentes a join auth.users u on u.id = a.id where a.id = p_agente and not a.ativo and u.email_confirmed_at is not null) into v_ok;
  if not v_ok then raise exception 'Pedido não encontrado ou já decidido.' using errcode = 'P0002'; end if;
  if p_aprovar then
    update public.agentes set ativo = true, papel = coalesce(p_papel, papel) where id = p_agente;
  else
    delete from auth.users where id = p_agente;   -- agentes sai junto (on delete cascade)
  end if;
  return jsonb_build_object('ok', true, 'aprovado', p_aprovar);
end $$;

revoke all on function public.equipe_pedidos(), public.equipe_pedido_decidir(uuid, boolean, text) from public, anon;
grant execute on function public.equipe_pedidos(), public.equipe_pedido_decidir(uuid, boolean, text) to authenticated;
