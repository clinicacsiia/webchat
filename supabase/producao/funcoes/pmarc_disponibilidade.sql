-- public.pmarc_disponibilidade(p_procedimento integer, p_dados jsonb DEFAULT '{}'::jsonb)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.pmarc_disponibilidade(p_procedimento integer, p_dados jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d jsonb := case when jsonb_typeof(p_dados) = 'object' then p_dados else '{}'::jsonb end;
  v_turno text := coalesce(nullif(d ->> 'turno', ''), 'qualquer'); v_apos time; v_ate time; v_dia date; v_unid text := nullif(btrim(coalesce(d ->> 'unidade', '')), '');
  v_hoje date := (now() at time zone 'America/Bahia')::date; v_ate_dia date; v_proc record; v_dias jsonb; v_total integer; v_meta timestamptz;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  -- cada consulta monta a grade de vários dias: limite global (não há como identificar quem pede)
  delete from public.pmarc_tentativa where quando < now() - interval '6 hours';
  if (select count(*) from public.pmarc_tentativa where marca = 'global' and tipo = 'disp' and quando > now() - interval '1 minute') >= 120 then
    return jsonb_build_object('ok', false, 'motivo', 'muitos');
  end if;
  insert into public.pmarc_tentativa (marca, tipo) values ('global', 'disp');

  select p.id, p.nome into v_proc from public.catalogo_procedimento p where p.id = p_procedimento and p.ativo;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'procedimento_invalido'); end if;
  if v_turno not in ('manha', 'tarde', 'noite', 'qualquer') then v_turno := 'qualquer'; end if;
  if coalesce(d ->> 'hora_apos', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then v_apos := (d ->> 'hora_apos')::time; end if;
  if coalesce(d ->> 'hora_ate', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then v_ate := (d ->> 'hora_ate')::time; end if;
  begin v_dia := nullif(d ->> 'data_ate', '')::date; exception when others then v_dia := null; end;
  v_ate_dia := least(greatest(coalesce(v_dia, v_hoje + 21), v_hoje), v_hoje + 30);
  -- a página manda o nome curto; na grade do Klingo o nome é longo ("CLÍNICA DE SAÚDE E IMAGEM - CSI"). Nome desconhecido = sem filtro.
  v_unid := case upper(coalesce(v_unid, '')) when 'CSI' then 'CLÍNICA DE SAÚDE E IMAGEM - CSI' when 'RM/TC' then 'CLÍNICA DE SAÚDE E IMAGEM - RM/TC' when 'CSI RM/TC' then 'CLÍNICA DE SAÚDE E IMAGEM - RM/TC'
                 when 'DESENVOAR' then 'DESENVOAR' end;

  select (select max(m.valido_desde) from public.agenda_ocupacao_meta m where m.id = 1) into v_meta;
  with h as materialized (
    select h.data, h.hora, case when public.norm_nome(h.unidade) like '%RM TC' then 'RM/TC' when public.norm_nome(h.unidade) like '%CSI' then 'CSI' when public.norm_nome(h.unidade) = 'DESENVOAR' then 'DESENVOAR' else h.unidade end as unidade, h.profissional
    from public.agenda_horarios(array[p_procedimento], v_hoje, v_ate_dia, v_unid, null, null, '[]'::jsonb, 120) h
    where public.unidade_chave(h.unidade) in (select u.chave from public.unidade_config u where u.ativo)
      and (v_turno = 'qualquer' or (v_turno = 'manha' and h.hora < '12:00') or (v_turno = 'tarde' and h.hora >= '12:00' and h.hora < '18:00') or (v_turno = 'noite' and h.hora >= '18:00'))
      and (v_apos is null or h.hora::time >= v_apos) and (v_ate is null or h.hora::time <= v_ate)
  ), dias as (select distinct h.data from h order by h.data limit 10)
  select (select count(*) from h),
         coalesce((select jsonb_agg(jsonb_build_object('data', dd.data, 'slots', (select jsonb_agg(jsonb_build_object('hora', s.hora, 'unidade', s.unidade, 'profissional', s.profissional) order by s.hora)
                                                                                    from (select * from h where h.data = dd.data order by h.hora limit 8) s)) order by dd.data) from dias dd), '[]'::jsonb)
    into v_total, v_dias;
  return jsonb_build_object('ok', true, 'procedimento', jsonb_build_object('id', v_proc.id, 'nome', v_proc.nome), 'de', v_hoje, 'ate', v_ate_dia, 'total', v_total,
    'dias', v_dias, 'atualizado_em', v_meta,
    'aviso', 'Estes horários são uma PREVISÃO a partir da agenda da clínica. Não estão reservados nem confirmados: a nossa equipe confirma pelo webchat, WhatsApp e telefone. Alguns profissionais não atendem todos os planos: a equipe confere o seu.');
end $function$;

