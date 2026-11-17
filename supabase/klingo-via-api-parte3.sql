-- FLUXOGRAMA: o Klingo registra o responsável de cada marcação; o da API do chat é `biclinicacsi` -> a leitura do relatório #14554 passa a marcar `via_api` (só sim/não, sem guardar nome nenhum) -> os indicadores separam marcada pela API (com e sem atendente na conversa) de marcada por uma pessoa
-- Versão 1.0 — 17/11/2026 / Mudança: `painel_indicadores_plataforma` devolve `quem_marcou` (marcações ligadas ao chat: pela API ou por uma pessoa, com ou sem atendente na conversa).
-- Aplicar em partes (parte1, parte2, parte3), nesta ordem. Teste: `cd testes && npm run test:via-api-sql`.
-- ROLLBACK (parte 3): ver o fim deste arquivo.

-- public.painel_indicadores_plataforma(p_de date, p_ate date, p_unidade text, p_incluir_teste boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_indicadores_plataforma(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_out jsonb;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje);
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;
  with
  base as (
    select k.m, k.origem, k.ligacao, k.conversa_id, k.status_klingo, k.unidade, k.marcado_em, k.via_api, (c.primeiro_humano_em is not null) as com_atendente, je.status as st, je.procedimento,
           lower(btrim(coalesce(je.cancelamento_motivo, ''))) as mot,
           case when je.procedimento is not null then (case when je.procedimento ~* '^consulta' then 'consulta' else 'exame' end)
                else (select case x.tipo when 'consulta' then 'consulta' when 'exame' then 'exame' end from public.pre_agendamentos x where x.conversa_id = k.conversa_id order by x.criado_em desc limit 1) end as tipo
      from public.klingo_conferencia k
      join public.conversas c on c.id = k.conversa_id
      left join public.jornada_exame je on je.marcacao_id = 'm' || k.m
     where k.marcado_em between v_de and v_ate and (p_incluir_teste or not c.teste)
       and (v_un is null or k.unidade is null or k.unidade = v_un)),
  p as (select b.*, case when b.st = 'remarcado' then 'remarcada'
                         when b.status_klingo = 'Cancelada' or b.st = 'cancelado' then 'cancelada'
                         when b.st = 'atendido' then 'atendida' when b.st = 'faltou' then 'faltou'
                         when b.st in ('agendado', 'confirmado') then 'por_vir' else 'sem_dado' end as resultado,
               coalesce(b.tipo, 'sem_tipo') as t from base b),
  clin as (select case when je.procedimento ~* '^consulta' then 'consulta' else 'exame' end as t, count(*) as n
             from public.klingo_conferencia k left join public.conversas c on c.id = k.conversa_id left join public.jornada_exame je on je.marcacao_id = 'm' || k.m
            where k.marcado_em between v_de and v_ate and (p_incluir_teste or c.id is null or not c.teste) and (v_un is null or k.unidade is null or k.unidade = v_un) and je.procedimento is not null group by 1),
  cc as (select case
           when mot = '' or mot ~ '^[^[:alnum:]]*$' or length(mot) < 3 then 'sem_motivo'
           when mot ~ 'duplic|dupli|erro|errad|eror|correç|corrig|unificad|lançamento|lancamento|teste' then 'erro_duplicidade'
           when mot ~ 'conv[eêé]nio|autoriza|suspens|geap|cassi|promedica|negou|plano|sedaç|sedac|n[aã]o (faz|atend|realiz)|esse exame' then 'convenio_cobertura'
           when mot ~ 'outro (local|lugar|m[eé]dico|especialista)|em outro|outra cl[ií]nica|mais pr[oó]xim|j[aá] (realiz|fez|fiz|feito)|mora em' then 'outro_lugar'
           when mot ~ 'remarc|antecip|remanej|reagend|mudou a data|mudamos|marcou para|para o dia|para dezembro|depois' then 'remarcou_depois'
           when mot ~ 'dra |dr |m[eé]dic[oa] n[aã]o|imprevisto|agenda cheia' then 'imprevisto_clinica'
           when mot ~ 'cancel|desmarc|desist|pediu|solicit|pc |paciente|pela mesma|wpp|wellon|wellow|welon|msg|mensagem|liga|tel|m[aã]e|responsavel|n[aã]o (poder|vai|quis|consegu|ir)' then 'paciente_cancelou'
           else 'outros' end as cat from p where resultado = 'cancelada')
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'unidade', v_un, 'gerado_em', now(),
    'conversas', (select count(distinct conversa_id) from p),
    'por_tipo', coalesce((select jsonb_object_agg(q.t, q.o) from (
        select t, jsonb_build_object('total', count(*), 'canceladas', count(*) filter (where resultado = 'cancelada'), 'remarcadas', count(*) filter (where resultado = 'remarcada'),
               'ativas', count(*) filter (where resultado in ('atendida', 'faltou', 'por_vir', 'sem_dado')), 'atendidas', count(*) filter (where resultado = 'atendida'),
               'faltaram', count(*) filter (where resultado = 'faltou'), 'por_vir', count(*) filter (where resultado = 'por_vir'), 'sem_dado', count(*) filter (where resultado = 'sem_dado')) as o
          from p group by t) q), '{}'::jsonb),
    'total', (select jsonb_build_object('total', count(*), 'canceladas', count(*) filter (where resultado = 'cancelada'), 'remarcadas', count(*) filter (where resultado = 'remarcada'),
               'ativas', count(*) filter (where resultado in ('atendida', 'faltou', 'por_vir', 'sem_dado')), 'atendidas', count(*) filter (where resultado = 'atendida'),
               'faltaram', count(*) filter (where resultado = 'faltou'), 'por_vir', count(*) filter (where resultado = 'por_vir'), 'sem_dado', count(*) filter (where resultado = 'sem_dado')) from p),
    'por_origem', coalesce((select jsonb_object_agg(o, n) from (select origem as o, count(*) as n from p group by 1) q), '{}'::jsonb),
    'por_ligacao', coalesce((select jsonb_object_agg(l, n) from (select ligacao as l, count(*) as n from p group by 1) q), '{}'::jsonb),
    'cancel_motivos', coalesce((select jsonb_object_agg(x.cat, x.n) from (select cat, count(*) as n from cc group by cat) x), '{}'::jsonb),
    'clinica_mesmo_periodo', coalesce((select jsonb_object_agg(t, n) from clin), '{}'::jsonb),
    'quem_marcou', (select jsonb_build_object(
        'api_sem_atendente', count(*) filter (where via_api and not com_atendente), 'api_com_atendente', count(*) filter (where via_api and com_atendente),
        'pessoa_sem_atendente', count(*) filter (where not via_api and not com_atendente), 'pessoa_com_atendente', count(*) filter (where not via_api and com_atendente)) from p)
  ) into v_out;
  return v_out;
end $function$;

REVOKE ALL ON FUNCTION public.painel_indicadores_plataforma(date, date, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.painel_indicadores_plataforma(date, date, text, boolean) TO authenticated, service_role;

-- ROLLBACK da parte 3: reaplicar supabase/producao/funcoes/painel_indicadores_plataforma.sql da versão anterior (git: commit anterior a este arquivo).
