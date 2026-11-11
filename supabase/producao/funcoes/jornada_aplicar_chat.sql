-- public.jornada_aplicar_chat(p_card bigint, p_alvo text, p_detalhe jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_aplicar_chat(p_card bigint, p_alvo text, p_detalhe jsonb DEFAULT '{}'::jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.jornada_card%rowtype;
  o_atual integer;
  o_alvo integer;
begin
  select * into c from public.jornada_card where id = p_card for update;
  if not found then
    raise exception 'Card % não existe.', p_card;
  end if;
  if c.coluna = p_alvo then
    return 'igual';
  end if;
  select ordem into o_atual from public.jornada_coluna where id = c.coluna;
  select ordem into o_alvo from public.jornada_coluna where id = p_alvo;
  if o_atual is null or o_alvo is null or c.coluna not in ('contato', 'orcamento', 'autorizacao', 'agendado', 'perdido') then
    return 'ignorado';
  end if;
  if not (p_alvo in ('agendado', 'perdido') or o_alvo > o_atual or (c.coluna = 'perdido' and p_alvo in ('contato', 'orcamento'))) then
    return 'ignorado';
  end if;
  update public.jornada_card set coluna = p_alvo, coluna_desde = now(), versao = versao + 1, atualizado_em = now() where id = c.id;
  insert into public.jornada_evento (card_id, tipo, origem, de_coluna, para_coluna, detalhe) values (c.id, 'movido', 'sistema', c.coluna, p_alvo, coalesce(p_detalhe, '{}'::jsonb));
  return 'moveu';
end;
$function$;

