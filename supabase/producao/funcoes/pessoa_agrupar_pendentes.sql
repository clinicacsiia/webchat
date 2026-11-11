-- public.pessoa_agrupar_pendentes()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pessoa_agrupar_pendentes()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; v_n integer := 0;
begin
  for r in select c.id from public.conversas c
            where not exists (select 1 from public.conversa_grupo g where g.conversa_id = c.id) and c.criado_em > now() - interval '120 days'
            order by c.criado_em limit 500 loop
    begin v_n := v_n + public.pessoa_agrupar(r.id); exception when others then null; end;
  end loop;
  return v_n;
end $function$;

