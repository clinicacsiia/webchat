-- public.ia_evento_motivo(p_pre uuid, p_motivo text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.ia_evento_motivo(p_pre uuid, p_motivo text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_txt text; v_id bigint;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin','atendente') then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_motivo, '')), '') is null then return; end if;
  v_txt := case when btrim(p_motivo) in ('Paciente desistiu', 'Horário indisponível', 'Exame errado ou faltando', 'Plano ou convênio', 'Preço', 'Duplicado ou teste')
                then btrim(p_motivo) else 'Outro motivo' end;
  select e.id into v_id from public.ia_evento e
   where e.pre_agendamento_id = p_pre and e.tipo = 'status' and e.para = 'cancelado' and e.por = 'atendente'
     and e.agente_id = (select auth.uid()) and e.criado_em > now() - interval '10 minutes'
   order by e.criado_em desc limit 1;
  if v_id is null then
    raise exception 'Não achei um cancelamento seu, feito há menos de 10 minutos, para registrar o motivo.' using errcode = 'P0002';
  end if;
  update public.ia_evento set detalhe = v_txt where id = v_id;
end $function$;

