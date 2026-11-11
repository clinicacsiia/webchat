-- public.painel_incidentes(p_codigo text, p_dias integer, p_limite integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_incidentes(p_codigo text DEFAULT NULL::text, p_dias integer DEFAULT 7, p_limite integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_busca text := nullif(upper(btrim(coalesce(p_codigo, ''))), '');
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  return coalesce((
    select jsonb_agg(x order by x ->> 'criado_em' desc) from (
      select jsonb_build_object('codigo', i.codigo, 'tipo', i.tipo, 'conversa_id', i.conversa_id, 'passo', i.passo, 'versao', i.versao, 'criado_em', i.criado_em,
                                'rotulo', i.detalhe ->> 'rotulo', 'detalhe', i.detalhe) x
      from public.incidente_chat i
      where (v_busca is not null and i.codigo like '%' || v_busca || '%')
         or (v_busca is null and i.criado_em >= now() - make_interval(days => greatest(1, least(coalesce(p_dias, 7), 90))))
      order by i.criado_em desc limit greatest(1, least(coalesce(p_limite, 50), 200))) q), '[]'::jsonb);
end $function$;

