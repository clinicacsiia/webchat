-- public.paciente_historico_para_ia(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.paciente_historico_para_ia(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_conf jsonb; v_pid uuid; v_lib boolean; v_n int; v_pend uuid; v_pendj jsonb; v_ult jsonb;
  v_agora timestamp := now() at time zone 'America/Bahia';
begin
  v_conf := public.paciente_conferir(p_conversa);
  v_pid := nullif(v_conf ->> 'paciente_id', '')::uuid;
  if v_pid is null then return jsonb_build_object('tem_historico', false); end if;
  v_lib := coalesce((v_conf ->> 'dt_nasc_conferida') = 'true', false);
  select count(*) into v_n from public.paciente_historico where paciente_id = v_pid and not cancelado;
  v_pend := public.pre_pendencia_anterior(p_conversa);
  if v_n = 0 and v_pend is null then return jsonb_build_object('tem_historico', false); end if;
  if not v_lib then
    return jsonb_build_object('tem_historico', v_n > 0, 'visitas', v_n, 'tem_pedido_pela_metade', v_pend is not null, 'liberado', false);
  end if;
  select coalesce(jsonb_agg(x order by x ->> 'ordem' desc), '[]'::jsonb) into v_ult from (
    select jsonb_build_object(
      'ordem', to_char(coalesce(h.ocorreu_em, h.criado_em at time zone 'America/Bahia'), 'YYYYMMDDHH24MI'),
      'quando', to_char(coalesce(h.ocorreu_em, h.criado_em at time zone 'America/Bahia'), 'DD/MM/YYYY'),
      'futuro', coalesce(h.ocorreu_em > v_agora, false),
      'unidade', regexp_replace(h.unidade, '^CLÍNICA DE SAÚDE E IMAGEM - ', ''), 'profissional', h.profissional, 'plano', h.plano,
      'exames', (select coalesce(jsonb_agg(jsonb_build_object('modalidade', e ->> 'modalidade', 'parte_do_corpo', e ->> 'parte_do_corpo',
                   'lado', case e ->> 'lado' when 'D' then 'direito' when 'E' then 'esquerdo' when 'A' then 'ambos' else null end,
                   'exame', e ->> 'exame', 'quantidade', (e ->> 'quantidade')::int)), '[]'::jsonb) from jsonb_array_elements(h.exames) e)) as x
    from public.paciente_historico h where h.paciente_id = v_pid and not h.cancelado
    order by coalesce(h.ocorreu_em, h.criado_em at time zone 'America/Bahia') desc limit 3) q;
  if v_pend is not null then
    select jsonb_build_object('status', pa.status, 'etapa', pa.etapa, 'plano', pa.plano, 'unidade', pa.unidade,
      'quando', to_char(pa.atualizado_em at time zone 'America/Bahia', 'DD/MM'),
      'exames', (select coalesce(jsonb_agg(jsonb_build_object('modalidade', i.modalidade, 'parte_do_corpo', i.regiao_nome,
                   'lado', case i.lado when 'D' then 'direito' when 'E' then 'esquerdo' when 'A' then 'ambos' else null end, 'exame', i.procedimento, 'quantidade', i.quantidade) order by i.id), '[]'::jsonb)
                 from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo))
      into v_pendj from public.pre_agendamentos pa where pa.conversa_id = v_pend;
  end if;
  return jsonb_build_object('tem_historico', v_n > 0, 'visitas', v_n, 'liberado', true, 'ultimas', (select coalesce(jsonb_agg(u - 'ordem' order by u ->> 'ordem' desc), '[]'::jsonb) from jsonb_array_elements(v_ult) u),
                            'pedido_pela_metade', v_pendj);
end $function$;

