-- public.jornada_checklist_do_card(p_card bigint)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_checklist_do_card(p_card bigint)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  n integer;
begin
  if not public.jornada_regra_ativa('checklist_por_coluna') then
    return 0;
  end if;
  insert into public.jornada_tarefa (card_id, titulo, origem, chave)
  select c.id, m.titulo, 'sistema', 'ck:' || m.id
  from public.jornada_card c
  join public.jornada_checklist_modelo m on m.coluna = c.coluna and m.ativa
  where c.id = p_card and c.arquivado_em is null
  on conflict (card_id, chave) where chave is not null do nothing;
  get diagnostics n = row_count;
  return n;
end;
$function$;

