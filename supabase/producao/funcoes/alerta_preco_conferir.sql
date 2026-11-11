-- public.alerta_preco_conferir(p_conversa uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.alerta_preco_conferir(p_conversa uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer;
begin
  if (select public.papel_atual()) is null or (select public.papel_atual()) not in ('admin', 'atendente') then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  update public.alerta_preco set conferido_em = now(), conferido_por = auth.uid() where conversa_id = p_conversa and conferido_em is null;
  get diagnostics n = row_count;
  return n;
end $function$;

