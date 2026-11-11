-- public.convenio_eventos(p_limite integer, p_so_novos boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.convenio_eventos(p_limite integer DEFAULT 100, p_so_novos boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(q) order by q.criado_em desc, q.id desc) from (
    select e.id, e.criado_em, e.operadora, e.tipo, e.descricao, e.antes, e.depois, e.variacao_pct, e.relevante, e.origem, (e.visto_em is null) as novo
    from public.convenio_evento e where (not p_so_novos or e.visto_em is null) order by e.criado_em desc, e.id desc limit greatest(1, least(coalesce(p_limite, 100), 500))) q), '[]'::jsonb);
end $function$;

