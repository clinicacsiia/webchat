-- public.painel_indicadores_equipe(p_de date, p_ate date, p_incluir_teste boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_indicadores_equipe(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_nivel text := public.org_nivel(); v_uid uuid := (select auth.uid()); v_de timestamptz; v_ate timestamptz; v_res jsonb;
begin
  if v_nivel is null then raise exception 'Não autorizado.' using errcode = '42501'; end if;
  p_de := coalesce(p_de, ((now() at time zone 'America/Sao_Paulo')::date - 29));
  p_ate := coalesce(p_ate, (now() at time zone 'America/Sao_Paulo')::date);
  if p_ate < p_de or p_ate - p_de > 400 then raise exception 'Período inválido.' using errcode = '22023'; end if;
  v_de := (p_de::timestamp at time zone 'America/Sao_Paulo'); v_ate := ((p_ate + 1)::timestamp at time zone 'America/Sao_Paulo');
  with quem as (
    select a.id, a.nome from public.agentes a
     where a.ativo and a.papel in ('admin', 'atendente')
       and (v_nivel in ('ti', 'gerente') or a.id = v_uid
            or (v_nivel = 'supervisor' and exists (select 1 from public.org_membro s join public.org_membro t on t.equipe_id = s.equipe_id
                                                    where s.agente_id = v_uid and s.funcao = 'supervisor' and s.ativo and t.agente_id = a.id and t.ativo)))),
  cv as (select c.id from public.conversas c where p_incluir_teste or not c.teste),
  msg as (select m.agente_id, count(*) as mensagens, count(distinct m.conversa_id) as conversas
            from public.mensagens m join cv on cv.id = m.conversa_id
           where m.autor = 'agente' and m.agente_id is not null and m.criado_em >= v_de and m.criado_em < v_ate group by m.agente_id),
  assum as (select e.para_agente as agente_id, count(*) as n from public.conversa_evento e join cv on cv.id = e.conversa_id
             where e.tipo = 'assumida' and e.em >= v_de and e.em < v_ate and e.para_agente is not null group by e.para_agente),
  enc as (select ce.por as agente_id, count(*) as n from public.conversa_encerramento ce join cv on cv.id = ce.conversa_id
           where ce.encerrada_em >= v_de and ce.encerrada_em < v_ate and ce.por is not null group by ce.por),
  -- Mesma regra do painel_indicadores_atendentes: quem marcou à mão; senão o dono da conversa; senão quem mais escreveu nela.
  agd as (select x.agente_id, count(*) as n
            from (select coalesce(p.agendado_por, c.agente_id, (select m.agente_id from public.mensagens m where m.conversa_id = p.conversa_id and m.autor = 'agente' and m.agente_id is not null
                                                                  group by m.agente_id order by count(*) desc, m.agente_id limit 1)) as agente_id
                    from public.pre_agendamentos p join cv on cv.id = p.conversa_id join public.conversas c on c.id = p.conversa_id
                   where coalesce(p.agendado_em, p.agendado_auto_em) >= v_de and coalesce(p.agendado_em, p.agendado_auto_em) < v_ate) x
           where x.agente_id is not null group by x.agente_id),
  tf as (select e.por as agente_id, count(*) as n from public.conversa_evento e join cv on cv.id = e.conversa_id
          where e.tipo = 'transferencia' and e.em >= v_de and e.em < v_ate and e.por is not null group by e.por),
  tr as (select e.para_agente as agente_id, count(*) as n from public.conversa_evento e join cv on cv.id = e.conversa_id
          where e.tipo = 'transferencia' and e.em >= v_de and e.em < v_ate and e.para_agente is not null group by e.para_agente),
  pes as (select q.id, q.nome, coalesce(msg.conversas, 0) as conversas_participou, coalesce(msg.mensagens, 0) as mensagens, coalesce(assum.n, 0) as assumidas, coalesce(enc.n, 0) as encerradas,
                 coalesce(agd.n, 0) as agendados, coalesce(tf.n, 0) as transferiu, coalesce(tr.n, 0) as recebeu
            from quem q left join msg on msg.agente_id = q.id left join assum on assum.agente_id = q.id left join enc on enc.agente_id = q.id
            left join agd on agd.agente_id = q.id left join tf on tf.agente_id = q.id left join tr on tr.agente_id = q.id)
  select jsonb_build_object('de', p_de, 'ate', p_ate, 'incluir_teste', p_incluir_teste,
    'pessoas', coalesce((select jsonb_agg(to_jsonb(p) order by p.nome) from pes p), '[]'::jsonb),
    'equipes', coalesce((select jsonb_agg(jsonb_build_object('equipe', x.nome, 'unidade', x.unidade, 'pessoas', x.pessoas, 'conversas_participou', x.conv, 'mensagens', x.msgs, 'encerradas', x.enc, 'agendados', x.agd, 'transferencias', x.tf) order by x.nome)
                          from (select e.nome, e.unidade, count(distinct p.id) as pessoas, coalesce(sum(p.conversas_participou), 0) as conv, coalesce(sum(p.mensagens), 0) as msgs,
                                       coalesce(sum(p.encerradas), 0) as enc, coalesce(sum(p.agendados), 0) as agd, coalesce(sum(p.transferiu), 0) as tf
                                  from public.org_equipe e join public.org_membro m on m.equipe_id = e.id and m.ativo and m.agente_id is not null join pes p on p.id = m.agente_id
                                 group by e.id) x), '[]'::jsonb),
    'agendados_pelo_sistema', (select count(*) from public.pre_agendamentos p join cv on cv.id = p.conversa_id where p.agendado_auto_em >= v_de and p.agendado_auto_em < v_ate))
    into v_res;
  return v_res;
end $function$;
