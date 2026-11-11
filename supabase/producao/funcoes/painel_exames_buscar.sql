-- public.painel_exames_buscar(p_termo text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_exames_buscar(p_termo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare k text := public.fluxo_norm_exame(left(coalesce(p_termo, ''), 120));
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'nome', q.nome) order by q.demanda desc, q.nome) from (
    select x.id, x.nome, x.demanda from public.fluxo_exames x
    where k <> '' and (select bool_and(x.chave ~ ('\m' || w)) from unnest(string_to_array(k, ' ')) w where length(w) >= 2)
    order by x.demanda desc limit 15) q), '[]'::jsonb);
end $function$;

