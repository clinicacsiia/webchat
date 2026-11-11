-- public.painel_indicadores_decisao(p_de date, p_ate date, p_unidade text, p_incluir_teste boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_indicadores_decisao(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_len integer; v_ant_ate date; v_ant_de date;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje);
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;
  v_len := v_ate - v_de + 1;
  v_ant_ate := v_de - 1; v_ant_de := v_de - v_len;
  return jsonb_build_object(
    'periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'anterior_periodo', jsonb_build_object('de', v_ant_de, 'ate', v_ant_ate),
    'unidade', v_un, 'incluir_teste', coalesce(p_incluir_teste, false), 'gerado_em', now(),
    'atual', public.ind_decisao_periodo(v_de, v_ate, v_un, coalesce(p_incluir_teste, false)),
    'anterior', public.ind_decisao_periodo(v_ant_de, v_ant_ate, v_un, coalesce(p_incluir_teste, false)));
end $function$;

