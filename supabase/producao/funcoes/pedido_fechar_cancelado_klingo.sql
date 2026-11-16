-- public.pedido_fechar_cancelado_klingo(p_vouchers text[])
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pedido_fechar_cancelado_klingo(p_vouchers text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; n integer := 0; v_lista text;
begin
  for r in select pa.id, pa.conversa_id, pa.klingo_marcacoes from public.pre_agendamentos pa
            where pa.status = 'agendado' and pa.klingo_marcacoes && p_vouchers loop
    -- só fecha quando TODAS as marcações do pedido estão canceladas na Jornada (cancelada ou remarcada não se confunde: remarcada tem outro status)
    if exists (select 1 from unnest(r.klingo_marcacoes) m
                where not exists (select 1 from public.jornada_exame e where e.marcacao_id = 'm' || m and e.status = 'cancelado')) then continue; end if;
    update public.pre_agendamentos set status = 'cancelado', conferencia_status = 'sumiu', conferencia_em = now(), atualizado_em = now() where id = r.id and status = 'agendado';
    if not found then continue; end if;
    update public.klingo_marcacao set situacao = 'cancelada', consultado_em = now() where voucher = any (r.klingo_marcacoes) and situacao in ('ativa', 'nao_listada');
    update public.conversas set alerta_agenda = null where id = r.conversa_id and alerta_agenda = 'Marcação sumiu do Klingo';
    v_lista := array_to_string(r.klingo_marcacoes, ', ');
    perform public.fluxo_nota(r.conversa_id, 'O Klingo mostra a marcação ' || v_lista || ' CANCELADA (feita direto no Klingo). O pedido deixou de ficar em aberto.');
    n := n + 1;
  end loop;
  return n;
end $function$;

