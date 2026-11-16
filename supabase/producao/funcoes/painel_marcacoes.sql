-- public.painel_marcacoes(p_conversa uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_marcacoes(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_hoje date := (now() at time zone 'America/Bahia')::date; o record;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  select estado, codigo, criado_em into o from public.klingo_operacao where conversa_id = p_conversa and tipo = 'ler_vouchers' and detalhe ->> 'por' = 'painel' order by criado_em desc limit 1;
  return jsonb_build_object('consulta', case when o.estado is null then null else jsonb_build_object('estado', o.estado, 'codigo', o.codigo, 'em', o.criado_em) end,
    'marcacoes', coalesce((select jsonb_agg(jsonb_build_object('voucher', m.voucher, 'procedimento', m.procedimento, 'unidade', m.unidade, 'profissional', m.profissional, 'data', m.data, 'hora', m.hora, 'origem', m.origem, 'consultado_em', m.consultado_em) order by m.data, m.hora)
      from public.klingo_marcacao m where m.conversa_id = p_conversa and m.situacao = 'ativa' and m.data >= v_hoje), '[]'::jsonb));
end $function$;

