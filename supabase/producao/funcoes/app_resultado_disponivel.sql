-- public.app_resultado_disponivel(p_ids jsonb)
-- Pode executar: ninguém pela API (só o dono/gatilhos/rotinas)
CREATE OR REPLACE FUNCTION public.app_resultado_disponivel(p_ids jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer;
begin
  update public.app_resultado set estado = 'disponivel', disponivel_em = now()
   where estado = 'aguardando' and id in (select (x)::uuid from jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)) x);
  get diagnostics n = row_count;
  return n;
end $function$;

