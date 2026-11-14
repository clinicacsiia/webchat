-- public.disponibilidade_oportunidades_gravar(p_pedido uuid, p_ofertas jsonb, p_sombra boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_oportunidades_gravar(p_pedido uuid, p_ofertas jsonb, p_sombra boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.disponibilidade_pedido; o record; v_opp uuid; v_n integer := 0; v_compat integer := 0; v_max_dia integer; v_max_total integer; v_bloq text; v_canal text := 'chat'; v_notif_estado text;
begin
  select * into r from public.disponibilidade_pedido where id = p_pedido for update;
  if r.id is null or r.estado <> 'ativa' or r.expira_em <= now() then return jsonb_build_object('ok', false, 'motivo', 'estado_' || coalesce(r.estado, 'inexistente')); end if;
  for o in select (x ->> 'chave') as chave, (x ->> 'data')::date as data, (x ->> 'hora') as hora, (x ->> 'unidade') as unidade, (x ->> 'profissional') as prof
             from jsonb_array_elements(case when jsonb_typeof(p_ofertas) = 'array' then p_ofertas else '[]'::jsonb end) x
            where (x ->> 'data') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'hora') ~ '^\d{2}:\d{2}$' and nullif(x ->> 'chave', '') is not null order by 2, 3 loop
    if not public.disponibilidade_compativel(r, o.data, o.hora, o.unidade, o.prof) then continue; end if;
    v_compat := v_compat + 1;
    if p_sombra then continue; end if;
    if exists (select 1 from public.disponibilidade_oportunidade where pedido_id = r.id and oferta_chave = o.chave) then continue; end if;
    insert into public.disponibilidade_oportunidade (pedido_id, oferta_chave, data, hora, unidade, profissional, valida_ate) values (r.id, left(o.chave, 120), o.data, o.hora, left(o.unidade, 120), left(o.prof, 120), now() + interval '2 hours') returning id into v_opp;
    update public.disponibilidade_pedido set ultima_oportunidade = jsonb_build_object('data', o.data, 'hora', o.hora, 'unidade', o.unidade), ultima_oportunidade_em = now() where id = r.id;
    perform public.disponibilidade_mudar_estado(r.id, 'oportunidade_identificada', 'sistema', jsonb_build_object('data', o.data, 'hora', o.hora));
    v_n := v_n + 1;
    v_max_dia := coalesce(nullif(public.klingo_cfg('disponibilidade_max_avisos_dia', '2'), '')::integer, 2); v_max_total := coalesce(nullif(public.klingo_cfg('disponibilidade_max_avisos_total', '6'), '')::integer, 6);
    v_notif_estado := case when not r.aceita_notificacao or not ('chat' = any (r.canais)) then 'bloqueada_sem_autorizacao'
                           when (select count(*) from public.disponibilidade_notificacao n where n.pedido_id = r.id and n.estado = 'entregue_ao_chat' and n.entregue_em > now() - interval '24 hours') >= v_max_dia
                             or (select count(*) from public.disponibilidade_notificacao n where n.pedido_id = r.id and n.estado = 'entregue_ao_chat') >= v_max_total then 'bloqueada_limite'
                           else 'pendente' end;
    insert into public.disponibilidade_notificacao (pedido_id, oportunidade_id, canal, estado) values (r.id, v_opp, v_canal, v_notif_estado);
    perform public.disponibilidade_evento_gravar(r.id, 'oportunidade', 'sistema', jsonb_build_object('notificacao', v_notif_estado));
    exit;
  end loop;
  if p_sombra then perform public.klingo_medir('disponibilidade_sombra_compativeis', v_compat); end if;
  return jsonb_build_object('ok', true, 'compativeis', v_compat, 'novas', v_n);
end $function$;

