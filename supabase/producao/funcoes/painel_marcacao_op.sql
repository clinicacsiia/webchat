-- public.painel_marcacao_op(p_op uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_marcacao_op(p_op uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare o record;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  select tipo, estado, codigo into o from public.klingo_operacao where id = p_op and detalhe ->> 'por' = 'painel';
  if o.tipo is null then return jsonb_build_object('ok', false, 'motivo', 'nao_encontrada'); end if;
  return jsonb_build_object('ok', true, 'tipo', o.tipo, 'estado', o.estado, 'codigo', o.codigo);
end $function$;

