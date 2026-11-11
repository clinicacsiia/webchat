-- public.fluxo_t(p_chave text, p_v jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_t(p_chave text, p_v jsonb DEFAULT '{}'::jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare t text; k text; v text;
begin
  select texto into t from public.fluxo_texto where chave = p_chave;
  t := coalesce(t, p_chave);
  for k, v in select key, value from jsonb_each_text(coalesce(p_v, '{}'::jsonb)) loop
    t := replace(t, '{' || k || '}', coalesce(v, ''));
  end loop;
  return t;
end $function$;

