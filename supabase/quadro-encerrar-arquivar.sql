-- Quadro das conversas: tirar cartão do quadro (arquivar) e mover para mais etapas (03/11/2026).
-- Arquivar não apaga: o cartão some do quadro e a sincronização do chat não o recria (ela acha o cartão arquivado pela mesma chave/dia/unidade).
create or replace function public.jornada_arquivar_card(p_card bigint, p_versao integer, p_nota text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare c public.jornada_card%rowtype;
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if not public.jornada_pode() then raise exception 'Sem permissão para a Jornada.'; end if;
  select * into c from public.jornada_card where id = p_card for update;
  if not found then raise exception 'Card não encontrado.'; end if;
  if c.versao <> p_versao then raise exception 'CONFLITO: o card foi alterado por outra pessoa. Atualize a tela e tente de novo.'; end if;
  if c.arquivado_em is not null then return jsonb_build_object('ok', true); end if;
  update public.jornada_card set arquivado_em = now(), versao = versao + 1, atualizado_em = now() where id = c.id;
  insert into public.jornada_evento (card_id, tipo, origem, usuario, de_coluna, detalhe)
  values (c.id, 'nota', 'pessoa', auth.uid(), c.coluna, jsonb_build_object('acao', 'arquivado', 'nota', left(coalesce(p_nota, ''), 500)));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.jornada_arquivar_card(bigint, integer, text) from public, anon;
grant execute on function public.jornada_arquivar_card(bigint, integer, text) to authenticated;

insert into public.jornada_transicao (de, para) values
  ('orcamento','contato'), ('autorizacao','contato'), ('autorizacao','orcamento'),
  ('perdido','orcamento'), ('perdido','autorizacao'),
  ('contato','concluido'), ('orcamento','concluido'), ('autorizacao','concluido')
on conflict do nothing;
