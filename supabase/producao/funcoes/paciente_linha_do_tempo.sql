-- public.paciente_linha_do_tempo(p_conversa uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.paciente_linha_do_tempo(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ids uuid[]; v jsonb;
begin
  perform public.pessoa_equipe();
  v_ids := public.pessoa_membros(p_conversa);
  select coalesce(jsonb_agg(jsonb_build_object('conversa_id', y.conversa_id, 'exames', y.exames, 'status', y.estado, 'quando', y.quando, 'passo', y.passo)
                 order by y.ordem, y.criado_em desc), '[]'::jsonb) into v
    from (select z.*, case z.estado when 'faltou' then 1 when 'cancelou' then 1 when 'remarcou' then 1 when 'pronto' then 2 when 'marcado' then 3 when 'rascunho' then 4 else 5 end as ordem,
                 case z.estado when 'faltou' then 'Faltou: oferecer um novo horário ou registrar que recusou'
                               when 'cancelou' then 'Cancelou: oferecer de novo ou registrar que recusou'
                               when 'remarcou' then 'Remarcação em andamento'
                               when 'pronto' then 'Falta a equipe marcar o horário'
                               when 'marcado' then 'Aguardando o dia do exame'
                               when 'rascunho' then 'Pedido não concluído: perguntar se quer continuar'
                               else 'Concluído' end as passo
            from (select pa.conversa_id, pa.criado_em,
                         coalesce(nullif((select string_agg(coalesce(nullif(i.procedimento, ''), i.modalidade), ' + ' order by i.id) from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo), ''), nullif(pa.procedimento, '')) as exames,
                         case when pa.status = 'agendado' then coalesce(f.desfecho, 'marcado') else pa.status end as estado,
                         f.quando
                    from public.pre_agendamentos pa
                    left join lateral (select ff.desfecho, ff.quando from public.agendamento_fechamento ff where ff.pre_id = pa.id order by ff.fechado_em desc limit 1) f on true
                   where pa.conversa_id = any (v_ids)) z
           where z.exames is not null) y;
  return v;
end $function$;

