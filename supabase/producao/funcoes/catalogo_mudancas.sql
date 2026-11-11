-- public.catalogo_mudancas(p_limite integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.catalogo_mudancas(p_limite integer DEFAULT 200)
 RETURNS TABLE(detectada_em timestamp with time zone, tipo text, evento text, chave text, descricao text, campo text, antes text, depois text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (select public.papel_atual()) is distinct from 'admin' then
    raise exception 'Somente administrador.' using errcode = '42501';
  end if;
  return query
    select m.detectada_em, m.tipo, m.evento, m.chave, m.descricao, m.campo, m.antes, m.depois
    from public.catalogo_mudanca m order by m.id desc limit least(greatest(p_limite, 1), 1000);
end $function$;

