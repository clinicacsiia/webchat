-- public.ind_clinica_periodo(p_de date, p_ate date, p_un text, p_teste boolean, p_tipo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ind_clinica_periodo(p_de date, p_ate date, p_un text, p_teste boolean, p_tipo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_cli jsonb;
begin
  with
  ex as (select e.status, e.confirm_status, e.operadora, e.unidade, e.agendado_em, e.agendado_para, e.marcacao_id, e.procedimento,
                lower(btrim(coalesce(e.cancelamento_motivo, ''))) as m
           from public.jornada_exame e
          where e.status <> 'pedido'
            and (p_teste or e.marcacao_id not in (select 'm' || z.m from public.klingo_conferencia z join public.conversas c on c.id = z.conversa_id where c.teste))
            and (p_un is null or public.unidade_chave(e.unidade) is null or public.unidade_chave(e.unidade) = p_un)
            and (p_tipo is null or (case when e.procedimento ~* '^consulta' then 'consulta' else 'exame' end) = p_tipo)),
  pm as (select distinct 'm' || unnest(klingo_marcacoes) as m from public.pre_agendamentos where klingo_marcacoes is not null),
  ep as (select * from ex where (agendado_para at time zone 'America/Sao_Paulo')::date between p_de and p_ate),
  ef as (select ep.*, ((ep.agendado_para at time zone 'America/Sao_Paulo')::date - (ep.agendado_em at time zone 'America/Sao_Paulo')::date) as ant
           from ep where ep.status in ('atendido', 'faltou')),
  nv as (select ex.* from ex where ex.status <> 'remarcado' and (ex.agendado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate),
  cc as (select case
           when m = '' or m ~ '^[^[:alnum:]]*$' or length(m) < 3 then 'sem_motivo'
           when m ~ 'duplic|dupli|erro|errad|eror|correç|corrig|unificad|lançamento|lancamento|teste' then 'erro_duplicidade'
           when m ~ 'conv[eêé]nio|autoriza|suspens|geap|cassi|promedica|negou|plano|sedaç|sedac|n[aã]o (faz|atend|realiz)|esse exame' then 'convenio_cobertura'
           when m ~ 'outro (local|lugar|m[eé]dico|especialista)|em outro|outra cl[ií]nica|mais pr[oó]xim|j[aá] (realiz|fez|fiz|feito)|mora em' then 'outro_lugar'
           when m ~ 'remarc|antecip|remanej|reagend|mudou a data|mudamos|marcou para|para o dia|para dezembro|depois' then 'remarcou_depois'
           when m ~ 'dra |dr |m[eé]dic[oa] n[aã]o|imprevisto|agenda cheia' then 'imprevisto_clinica'
           when m ~ 'cancel|desmarc|desist|pediu|solicit|pc |paciente|pela mesma|wpp|wellon|wellow|welon|msg|mensagem|liga|tel|m[aã]e|responsavel|n[aã]o (poder|vai|quis|consegu|ir)' then 'paciente_cancelou'
           else 'outros' end as cat
         from ep where ep.status = 'cancelado')
  select jsonb_build_object(
    'novas_marcacoes', (select count(*) from nv),
    'novas_pelo_chat', (select count(*) from nv where nv.marcacao_id in (select m from pm)),
    'previstos', (select count(*) from ep),
    'atendidos', (select count(*) from ep where status = 'atendido'),
    'faltaram', (select count(*) from ep where status = 'faltou'),
    'cancelados', (select count(*) from ep where status = 'cancelado'),
    'remarcados', (select count(*) from ep where status = 'remarcado'),
    'por_vir', (select count(*) from ep where status in ('agendado', 'confirmado')),
    'falta_unidade', coalesce((select jsonb_agg(jsonb_build_object('nome', s.nome, 'atendidos', s.a, 'faltaram', s.f) order by s.nome)
        from (select coalesce(unidade, 'Sem unidade') as nome, count(*) filter (where status = 'atendido') as a, count(*) filter (where status = 'faltou') as f from ef group by 1) s), '[]'::jsonb),
    'falta_antecedencia', coalesce((select jsonb_agg(jsonb_build_object('nome', s.nome, 'atendidos', s.a, 'faltaram', s.f) order by s.o)
        from (select case when ant <= 1 then 'No mesmo dia ou no dia seguinte' when ant <= 7 then 'De 2 a 7 dias antes' when ant <= 15 then 'De 8 a 15 dias antes' else 'Mais de 15 dias antes' end as nome,
                     case when ant <= 1 then 1 when ant <= 7 then 2 when ant <= 15 then 3 else 4 end as o,
                     count(*) filter (where status = 'atendido') as a, count(*) filter (where status = 'faltou') as f
                from ef where ant is not null group by 1, 2) s), '[]'::jsonb),
    'falta_confirmacao', coalesce((select jsonb_agg(jsonb_build_object('nome', s.nome, 'atendidos', s.a, 'faltaram', s.f) order by s.nome)
        from (select coalesce(confirm_status, 'Sem informação') as nome, count(*) filter (where status = 'atendido') as a, count(*) filter (where status = 'faltou') as f from ef group by 1) s), '[]'::jsonb),
    'falta_plano', coalesce((select jsonb_agg(jsonb_build_object('nome', s.nome, 'atendidos', s.a, 'faltaram', s.f) order by s.nome)
        from (select case when operadora ilike '%partic%' then 'Particular' else 'Convênio' end as nome, count(*) filter (where status = 'atendido') as a, count(*) filter (where status = 'faltou') as f from ef group by 1) s), '[]'::jsonb),
    'cancel_motivos', coalesce((select jsonb_object_agg(x.cat, x.n) from (select cat, count(*) as n from cc group by cat) x), '{}'::jsonb)
  ) into v_cli;
  return v_cli;
end $function$;
