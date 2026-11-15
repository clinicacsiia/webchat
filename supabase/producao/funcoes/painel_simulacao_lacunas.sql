-- public.painel_simulacao_lacunas(p_dias integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_simulacao_lacunas(p_dias integer DEFAULT 28)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tz text := 'America/Sao_Paulo';
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_dias integer := greatest(7, least(coalesce(p_dias, 28), 90));
  v_de timestamptz; v_fut timestamptz; v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem a simulação.' using errcode = '42501';
  end if;
  v_de := (v_hoje - v_dias)::timestamp at time zone v_tz;
  v_fut := (v_hoje + 16)::timestamp at time zone v_tz;
  with e as (
    select x.id, x.status, k.paciente_chave, x.confirm_status, x.atendimento_id, x.cancelamento_motivo,
           (h.chegada_em is not null or exists (select 1 from public.jornada_evento v where v.card_id = x.card_id and v.para_coluna = 'em_atendimento' and v.origem = 'klingo'
                                                  and (v.quando at time zone v_tz)::date = (x.agendado_para at time zone v_tz)::date)) as tem_chegada,
           (h.inicio_em is not null and h.fim_em is not null) as tem_horas,
           (p.fone_chave is not null) as tem_fone,
           (c.m is not null) as na_conf, coalesce(c.origem, 'sem_origem') <> 'sem_origem' as tem_origem, coalesce(cardinality(c.vazios), 0) = 0 as cadastro_ok,
           exists (select 1 from public.app_resultado r where r.exame_id = x.id and r.entregue_em is not null) as tem_resultado
      from public.jornada_exame x
      join public.jornada_card k on k.id = x.card_id
      left join public.jornada_paciente p on p.prontuario = k.paciente_chave
      left join public.atendimento_hora h on h.marcacao_id = x.marcacao_id
      left join public.klingo_conferencia c on c.m = substr(x.marcacao_id, 2)
     where x.marcacao_id like 'm%' and x.agendado_para >= v_de and x.agendado_para < v_fut
       and x.status in ('agendado', 'confirmado', 'atendido', 'faltou', 'cancelado', 'remarcado')
  )
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', v_hoje - v_dias, 'ate', v_hoje + 15),
    'linhas', coalesce((select jsonb_agg(jsonb_build_object(
        'status', s, 'marcacoes', n, 'pessoas', pessoas,
        'campos', jsonb_build_object(
          'chegada',        jsonb_build_object('de', case when s = 'atendido' then n end, 'com', case when s = 'atendido' then c_cheg end),
          'inicio_fim',     jsonb_build_object('de', case when s = 'atendido' then n end, 'com', case when s = 'atendido' then c_horas end),
          'atendimento_id', jsonb_build_object('de', case when s = 'atendido' then n end, 'com', case when s = 'atendido' then c_atend end),
          'resultado',      jsonb_build_object('de', case when s = 'atendido' then n end, 'com', case when s = 'atendido' then c_res end),
          'confirmacao',    jsonb_build_object('de', n, 'com', c_conf),
          'telefone',       jsonb_build_object('de', n, 'com', c_fone),
          'origem',         jsonb_build_object('de', n_conf, 'com', c_orig),
          'cadastro',       jsonb_build_object('de', n_conf, 'com', c_cad),
          'motivo',         jsonb_build_object('de', case when s in ('cancelado', 'remarcado') then n end, 'com', case when s in ('cancelado', 'remarcado') then c_mot end))
      ) order by ord)
      from (select status as s, case status when 'agendado' then 1 when 'confirmado' then 2 when 'atendido' then 3 when 'faltou' then 4 when 'cancelado' then 5 else 6 end as ord,
                   count(*) as n, count(distinct paciente_chave) as pessoas,
                   count(*) filter (where tem_chegada) as c_cheg, count(*) filter (where tem_horas) as c_horas,
                   count(*) filter (where atendimento_id is not null) as c_atend, count(*) filter (where tem_resultado) as c_res,
                   count(*) filter (where confirm_status in ('Confirmado', 'A Confirmar', 'Sem Resposta')) as c_conf,
                   count(*) filter (where tem_fone) as c_fone,
                   count(*) filter (where na_conf) as n_conf, count(*) filter (where na_conf and tem_origem) as c_orig, count(*) filter (where na_conf and cadastro_ok) as c_cad,
                   count(*) filter (where nullif(btrim(cancelamento_motivo), '') is not null) as c_mot
              from e group by status) z), '[]'::jsonb),
    'hora_real', jsonb_build_object(
        'atendidos', (select count(*) from e where status = 'atendido'),
        'com_inicio_e_fim', (select count(*) from e where status = 'atendido' and tem_horas),
        'ultima_leitura', (select max(lido_em) from public.atendimento_hora)))
    into v_out;
  return v_out;
end;
$function$;

