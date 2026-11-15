-- FLUXOGRAMA: entrada (a tela /simulacao/ pede o acerto da confirmação por dia; o motivo de cancelamento vem em texto livre) -> validação (painel_simulacao_acerto: papel_atual() admin ou atendente; sim_causa é só texto -> texto, sem tabela) -> lógica (acerto: por dia, atendidos, faltas, cancelados e remarcados, e a falta separada por situação da confirmação; sim_causa: agrupa o motivo escrito pela equipe em 8 causas) -> saída (um JSON por dia; um código de causa)
-- Versão 1.0 — 15/11/2026 / Mudança: arquivo de histórico criado DEPOIS de as duas funções já estarem na produção (aplicadas numa sessão que não deixou arquivo). O texto abaixo é o da produção, conferido por hash (md5 do corpo) contra o retrato `supabase/producao/funcoes/`. Não aplicar de novo: é só registro.
--
-- Nenhum dado de paciente: só contagens por dia. `sim_causa` é IMMUTABLE e não lê tabela; por isso `anon` poder executá-la (e `sim_unidade`, `sim_modalidade`, `sim_minuto`) não expõe nada.
--
-- ROLLBACK (rodar no editor SQL do Supabase; pede confirmação por causa do drop):
--   drop function public.painel_simulacao_acerto(integer);
--   drop function public.sim_causa(text);

CREATE OR REPLACE FUNCTION public.sim_causa(p_motivo text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when m = '' or m ~ '^[^[:alnum:]]*$' or length(m) < 3 then 'sem_motivo'
    when m ~ 'duplic|dupli|erro|errad|eror|correç|corrig|unificad|lançamento|lancamento|teste' then 'erro_duplicidade'
    when m ~ 'conv[eêé]nio|autoriza|suspens|geap|cassi|promedica|negou|plano|sedaç|sedac|n[aã]o (faz|atend|realiz)|esse exame' then 'convenio_cobertura'
    when m ~ 'outro (local|lugar|m[eé]dico|especialista)|em outro|outra cl[ií]nica|mais pr[oó]xim|j[aá] (realiz|fez|fiz|feito)|mora em' then 'outro_lugar'
    when m ~ 'remarc|antecip|remanej|reagend|mudou a data|mudamos|marcou para|para o dia|para dezembro|depois' then 'remarcou_depois'
    when m ~ 'dra |dr |m[eé]dic[oa] n[aã]o|imprevisto|agenda cheia' then 'imprevisto_clinica'
    when m ~ 'cancel|desmarc|desist|pediu|solicit|pc |paciente|pela mesma|wpp|wellon|wellow|welon|msg|mensagem|liga|tel|m[aã]e|responsavel|n[aã]o (poder|vai|quis|consegu|ir)' then 'paciente_cancelou'
    else 'outros' end
  from (select lower(btrim(coalesce(p_motivo, ''))) as m) z
$function$;

CREATE OR REPLACE FUNCTION public.painel_simulacao_acerto(p_dias integer DEFAULT 365)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tz text := 'America/Sao_Paulo';
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_dias integer := greatest(7, least(coalesce(p_dias, 365), 400));
  v_de timestamptz; v_ate timestamptz; v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem a simulação.' using errcode = '42501';
  end if;
  v_de := (v_hoje - v_dias)::timestamp at time zone v_tz;
  v_ate := v_hoje::timestamp at time zone v_tz;
  select jsonb_build_object(
    'de', v_hoje - v_dias, 'ate', v_hoje - 1, 'primeiro_dia', min(d), 'gerado_em', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'dias', coalesce(jsonb_agg(jsonb_build_object(
        'dia', d, 'atendidos', att, 'faltaram', fal, 'cancelados', can, 'remarcados', rem,
        'conf', jsonb_build_object(
          'confirmado',  jsonb_build_object('n', c_n, 'f', c_f),
          'a_confirmar', jsonb_build_object('n', a_n, 'f', a_f),
          'sem_resposta', jsonb_build_object('n', s_n, 'f', s_f),
          'outro',       jsonb_build_object('n', o_n, 'f', o_f))) order by d), '[]'::jsonb))
    into v_out
    from (select (e.agendado_para at time zone v_tz)::date as d,
                 count(*) filter (where e.status = 'atendido') as att, count(*) filter (where e.status = 'faltou') as fal,
                 count(*) filter (where e.status = 'cancelado') as can, count(*) filter (where e.status = 'remarcado') as rem,
                 count(*) filter (where e.status in ('atendido', 'faltou') and e.confirm_status = 'Confirmado') as c_n,
                 count(*) filter (where e.status = 'faltou' and e.confirm_status = 'Confirmado') as c_f,
                 count(*) filter (where e.status in ('atendido', 'faltou') and e.confirm_status = 'A Confirmar') as a_n,
                 count(*) filter (where e.status = 'faltou' and e.confirm_status = 'A Confirmar') as a_f,
                 count(*) filter (where e.status in ('atendido', 'faltou') and e.confirm_status = 'Sem Resposta') as s_n,
                 count(*) filter (where e.status = 'faltou' and e.confirm_status = 'Sem Resposta') as s_f,
                 count(*) filter (where e.status in ('atendido', 'faltou') and (e.confirm_status is null or e.confirm_status not in ('Confirmado', 'A Confirmar', 'Sem Resposta'))) as o_n,
                 count(*) filter (where e.status = 'faltou' and (e.confirm_status is null or e.confirm_status not in ('Confirmado', 'A Confirmar', 'Sem Resposta'))) as o_f
            from public.jornada_exame e
           where e.marcacao_id like 'm%' and e.agendado_para >= v_de and e.agendado_para < v_ate
             and public.sim_unidade(e.unidade) is not null and public.sim_modalidade(e.procedimento) is not null
           group by 1) z;
  return v_out;
end;
$function$;
