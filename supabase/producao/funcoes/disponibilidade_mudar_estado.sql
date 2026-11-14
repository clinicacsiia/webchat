-- public.disponibilidade_mudar_estado(p_pedido uuid, p_para text, p_origem text, p_detalhe jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_mudar_estado(p_pedido uuid, p_para text, p_origem text DEFAULT 'sistema'::text, p_detalhe jsonb DEFAULT '{}'::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_de text;
begin
  select estado into v_de from public.disponibilidade_pedido where id = p_pedido for update;
  if v_de is null or v_de = p_para then return false; end if;
  update public.disponibilidade_pedido set estado = p_para,
         convertida_em = case when p_para = 'convertida_em_agendamento' then now() else convertida_em end where id = p_pedido;
  perform public.disponibilidade_evento_gravar(p_pedido, 'estado:' || p_para, p_origem, coalesce(p_detalhe, '{}'::jsonb) || jsonb_build_object('de', v_de));
  return true;
exception when check_violation then return false;
end $function$;

