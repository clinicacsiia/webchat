-- public.jornada_aplicar_klingo(p_card bigint, p_alvo text, p_detalhe jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_aplicar_klingo(p_card bigint, p_alvo text, p_detalhe jsonb DEFAULT '{}'::jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.jornada_card%rowtype;
begin
  select * into c from public.jornada_card where id = p_card for update;
  if not found then
    raise exception 'Card % não existe.', p_card;
  end if;
  if c.coluna = p_alvo then
    return 'igual';
  end if;

  if not public.jornada_klingo_pode_mover(c.coluna, p_alvo) then
    if not exists (
      select 1 from public.jornada_evento e
      where e.card_id = c.id and e.tipo = 'divergencia' and e.para_coluna = p_alvo and e.de_coluna = c.coluna
    ) then
      insert into public.jornada_evento (card_id, tipo, origem, de_coluna, para_coluna, detalhe)
      values (c.id, 'divergencia', 'klingo', c.coluna, p_alvo, coalesce(p_detalhe, '{}'::jsonb) || jsonb_build_object('motivo', 'O Klingo indica outra coluna, mas o cartão já está mais adiante ou numa coluna da equipe.'));
    end if;
    return 'ignorado';
  end if;

  update public.jornada_card set coluna = p_alvo, coluna_desde = now(), versao = versao + 1, atualizado_em = now() where id = c.id;
  insert into public.jornada_evento (card_id, tipo, origem, de_coluna, para_coluna, detalhe) values (c.id, 'movido', 'klingo', c.coluna, p_alvo, coalesce(p_detalhe, '{}'::jsonb));
  return 'moveu';
end;
$function$;

