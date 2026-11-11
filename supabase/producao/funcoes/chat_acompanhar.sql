-- public.chat_acompanhar(p_conversa uuid, p_token text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_acompanhar(p_conversa uuid, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb;
begin
  perform public.chat_valida(p_conversa, p_token);
  select jsonb_build_object('conversa', c.status, 'agente', a.nome, 'em_horario', public.horario_trabalho_agora(), 'equipe_online', public.horario_trabalho_agora(),
    'pedido', pa.status, 'tipo', pa.tipo, 'conferencia', pa.conferencia_status,
    'confirmado', coalesce(pa.status = 'agendado' or pa.conferencia_status = 'confirmado', false),
    'espera_longa', coalesce(c.espera_aviso_paciente_em >= c.cliente_aguarda_desde, false),
    'horarios', coalesce((select jsonb_agg(jsonb_build_object('data', e ->> 'data', 'hora', e ->> 'hora', 'unidade', regexp_replace(coalesce(e ->> 'unidade', ''), '^CLÍNICA DE SAÚDE E IMAGEM - ', 'CSI ')) order by (e ->> 'grupo')::int)
                          from jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e), '[]'::jsonb))
    into r
  from public.conversas c left join public.agentes a on a.id = c.agente_id
  left join public.pre_agendamentos pa on pa.conversa_id = c.id
  where c.id = p_conversa;
  return r;
end $function$;

