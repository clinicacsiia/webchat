-- public.particular_valor_disparar(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.particular_valor_disparar(p_conversa uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo(); v_pid int := public.particular_plano_id(); v_ids int[];
begin
  if v_base = '' or v_seg is null or not public.particular_valor_ativo(p_conversa) then return; end if;
  select array_agg(distinct i.procedimento_id) into v_ids from public.pre_agendamento_itens i
   where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null
     and not exists (select 1 from public.klingo_preco_api k where k.procedimento_id = i.procedimento_id and k.plano_id = v_pid
                      and ((k.valor is not null and k.consultado_em > now() - interval '12 hours') or (k.valor is null and k.consultado_em > now() - interval '30 minutes')));
  if v_ids is null then return; end if;
  perform net.http_post(url := v_base || 'klingo-preco', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('acao', 'preco', 'plano', v_pid, 'ids', to_jsonb(v_ids)), timeout_milliseconds := 20000);
exception when others then null;
end $function$;

