-- public.klingo_operacao_vigiar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_operacao_vigiar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; v_re integer := 0; v_inc integer := 0; v_enc integer := 0;
begin
  for r in select id from public.klingo_operacao where estado = 'pendente' and criado_em < now() - interval '45 seconds' and tentativas < 3 loop
    perform public.klingo_operacao_disparar(r.id); v_re := v_re + 1;
  end loop;
  for r in select id from public.klingo_operacao
            where (estado = 'executando' and iniciado_em < now() - interval '3 minutes') or (estado = 'pendente' and (tentativas >= 3 or criado_em < now() - interval '4 minutes')) loop
    update public.klingo_operacao set estado = 'executando' where id = r.id and estado = 'pendente';
    perform public.klingo_operacao_concluir(r.id, 'incerto', jsonb_build_object('codigo', 'sem_resposta_do_executor'));
    v_inc := v_inc + 1;
  end loop;
  for r in select c.id from public.conversas c join public.pre_agendamentos pa on pa.conversa_id = c.id
            where c.status <> 'encerrada' and pa.agendado_origem = 'chat_api' and pa.agendado_auto_em < now() - interval '2 hours'
              and coalesce((select max(m.criado_em) from public.mensagens m where m.conversa_id = c.id and m.autor = 'cliente'), pa.agendado_auto_em) < now() - interval '2 hours'
              and c.primeiro_humano_em is null and c.ia_ativa loop
    begin
      update public.conversas set status = 'encerrada', encerrada_em = now(), motivo_encerramento = 'agendado', encerramento_origem = 'sistema' where id = r.id;
      v_enc := v_enc + 1;
    exception when others then null;
    end;
  end loop;
  return jsonb_build_object('redisparadas', v_re, 'incertas', v_inc, 'encerradas', v_enc);
end $function$;

