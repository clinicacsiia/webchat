-- public.agendamento_conferir_klingo()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agendamento_conferir_klingo()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_sal text; a record; v_fecha text; v_id bigint; v_n integer := 0; v_enc integer := 0;
begin
  select valor into v_sal from public.config where chave = 'ia_segredo';
  for a in
    select v.conversa_id, v.quando < (now() at time zone 'America/Bahia') - interval '1 hour' as passou_1h,
           (select array_agg(distinct e.status) from public.jornada_card c
              join public.jornada_paciente p on p.prontuario = c.paciente_chave
              join public.jornada_exame e on e.card_id = c.id
             where c.arquivado_em is null and c.conversa_id is null and c.data_ref = v.quando::date
               and p.fone_chave = encode(sha256(convert_to(right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) || coalesce(v_sal, ''), 'UTF8')), 'hex')
               and public.nome_confere(p.nome, public.pessoa_ficha(v.conversa_id) ->> 'nome')) as sts
      from public.v_agendamento_aberto v
      join public.conversas cv on cv.id = v.conversa_id join public.contatos ct on ct.id = cv.contato_id
     where v.quando is not null and v.quando::date <= (now() at time zone 'America/Bahia')::date
  loop
    if a.sts is null then continue; end if;
    v_fecha := case when 'atendido' = any (a.sts) then 'compareceu' when 'faltou' = any (a.sts) then 'faltou' when 'remarcado' = any (a.sts) then 'remarcou'
                    when 'cancelado' = any (a.sts) and not ('agendado' = any (a.sts) or 'confirmado' = any (a.sts)) then 'cancelou' end;
    if v_fecha is null or (v_fecha <> 'compareceu' and not a.passou_1h) then continue; end if;
    v_id := public.agendamento_fechar_interno(a.conversa_id, v_fecha, 'klingo', null, 'Conferido no Klingo.');
    if v_id is not null then
      if v_fecha = 'remarcou' then update public.agendamento_fechamento set remarcacao = 'feita' where id = v_id; end if;
      v_n := v_n + 1;
      v_enc := v_enc + public.conversa_encerrar_se_resolvida(a.conversa_id);
    end if;
  end loop;
  return jsonb_build_object('fechados', v_n, 'encerradas', v_enc);
end $function$;

