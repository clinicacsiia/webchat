-- public.fluxo_assunto_aplicar(p_conversa uuid, p_passo text, v text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_assunto_aplicar(p_conversa uuid, p_passo text, v text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; ctx jsonb := public.fluxo_ctx(p_conversa); f jsonb; x text;
begin
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  case p_passo
  when 'assunto_resultado' then
    if v = 'resolvido' then perform public.fluxo_set(p_conversa, '{"assunto_resolvido": true}');
    elsif v = 'atendente' then perform public.fluxo_set(p_conversa, '{"assunto_resultado_feito": true}');
    else return '{"ok": false}'; end if;
  when 'assunto_confirma' then
    if v = 'sim' then
      perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_confirmado', true, 'assunto_texto', left('Cancelar ' || coalesce(d ->> 'assunto_item', ''), 500)));
      return '{"ok": true, "transferir": true}';
    elsif v = 'nao' then
      perform public.fluxo_set(p_conversa, '{"assunto_item": null, "assunto_qual_feito": true}');
    else return '{"ok": false}'; end if;
  when 'assunto_qual' then
    if v = 'nenhum' then
      perform public.fluxo_set(p_conversa, '{"assunto_qual_feito": true}');
      return '{"ok": true}';
    end if;
    if v is null or v !~ '^i[0-9]{1,2}$' then return '{"ok": false}'; end if;
    select e into f from jsonb_array_elements(public.fluxo_assunto_futuros(p_conversa)) e where (e ->> 'idx')::int = substr(v, 2)::int;
    if f is null then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_item', f ->> 'item', 'assunto_qual_feito', true));
    if d ->> 'assunto' = 'Remarcar' then
      if public.pre_reaproveitar(p_conversa, 'ultimo:' || (f ->> 'idx')) then
        x := public.paciente_historico_para_ia(p_conversa) -> 'ultimas' -> (f ->> 'idx')::int ->> 'plano';
        perform public.fluxo_set(p_conversa, jsonb_build_object('motivo', 'exame', 'assunto_item', null,
          'plano_anterior', case when nullif(btrim(coalesce(x, '')), '') is not null then left(btrim(x), 120) else null end));
        perform public.fluxo_nota(p_conversa, 'REMARCAÇÃO de ' || (f ->> 'item') || ': cancelar o horário antigo no sistema e marcar o novo');
        return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('assunto_remarcar_ok', ctx || jsonb_build_object('item', f ->> 'item')));
      end if;
      perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_texto', left('Remarcar ' || (f ->> 'item'), 500)));
      return '{"ok": true, "transferir": true}';
    end if;
  else
    return '{"ok": false}';
  end case;
  return '{"ok": true}';
end $function$;

