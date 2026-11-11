-- public.fila_mudar(p_id uuid, p_para text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_mudar(p_id uuid, p_para text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.fila_equipe_ok();
    if p_para not in ('atendido', 'cancelado', 'chamado') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
      if p_para = 'chamado' then
          delete from public.fila_aviso where tipo = 'vez' and fila_id = p_id and exists (select 1 from public.fila_chegada where id = p_id and status = 'chamado');
            end if;
              update public.fila_chegada set status = p_para,
                       chamado_em = case when p_para = 'chamado' then now() else chamado_em end,
                                concluido_em = case when p_para in ('atendido', 'cancelado') then now() else concluido_em end
                                   where id = p_id and status in ('aguardando', 'chamado');
                                     if not found then raise exception 'Essa pessoa não está mais na fila.' using errcode = 'P0002'; end if;
                                     end $function$;

