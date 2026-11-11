-- public.jornada_arquivar_card(p_card bigint, p_versao integer, p_nota text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_arquivar_card(p_card bigint, p_versao integer, p_nota text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;

