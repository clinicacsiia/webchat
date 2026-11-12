-- FLUXOGRAMA: entrada (um pedido do chat vira "agendado": a atendente marca, ou a conferência/o reconhecimento do Klingo marca sozinho) -> validação (só quem tem permissão lê os indicadores, como antes) -> lógica (o agendamento é creditado a quem marcou à mão; se foi o sistema, ao dono da conversa; sem dono, a quem mais escreveu nela; sem ninguém, não é creditado) -> saída (painel_indicadores_atendentes e painel_indicadores_equipe passam a trazer "agendados" com esse crédito; atendentes traz também "agendados_automaticos")
-- Versão 1.0 — 12/11/2026 / Mudança: pedido do dono em 12/11/2026 (aba Indicadores mostrava 0 em "Agendamentos feitos" porque o sistema confirma sozinho com o Klingo). Troca a decisão Q-15 de 10/11/2026 ("automático, sem crédito a pessoa").
-- Só muda duas funções (create or replace, mesma assinatura e permissões). Pedidos antigos sem agendado_em passam a contar pela data de agendado_auto_em.
-- ROLLBACK: recriar as duas funções a partir da versão anterior em supabase/producao/funcoes/ (histórico do git: commit 8f84a93).
-- APLICAR EM PARTES (a ferramenta de migração expira em 60 s): primeiro a função de atendentes, depois a da equipe.

-- Parte 1: painel_indicadores_atendentes
CREATE OR REPLACE FUNCTION public.painel_indicadores_atendentes(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_i timestamptz; v_f timestamptz; v_out jsonb;
  v_uid uuid := (select auth.uid()); v_nivel text := public.org_nivel();
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje);
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;
  v_i := (v_de::timestamp at time zone 'America/Sao_Paulo'); v_f := ((v_ate + 1)::timestamp at time zone 'America/Sao_Paulo');
  with
  quem as (select a.id, a.nome, a.papel from public.agentes a
            where a.ativo and a.papel in ('admin', 'atendente')
              and (v_nivel in ('ti', 'gerente') or a.id = v_uid
                   or (v_nivel = 'supervisor' and exists (select 1 from public.org_membro s join public.org_membro t on t.equipe_id = s.equipe_id
                                                           where s.agente_id = v_uid and s.funcao = 'supervisor' and s.ativo and t.agente_id = a.id and t.ativo)))),
  pu as (select x.conversa_id from public.painel_conversa_pessoa_un() x
          where v_un is null or x.chaves is null or cardinality(x.chaves) = 0 or v_un = any (x.chaves)),
  cv as (select c.id, c.criado_em from public.conversas c join pu on pu.conversa_id = c.id where p_incluir_teste or not c.teste),
  msg as (select m.agente_id, count(distinct m.conversa_id) as conversas from public.mensagens m join cv on cv.id = m.conversa_id
           where m.autor = 'agente' and m.agente_id is not null and m.criado_em >= v_i and m.criado_em < v_f group by m.agente_id),
  -- Crédito do agendamento: quem marcou à mão; se o sistema confirmou sozinho com o Klingo, o dono da conversa; sem dono, quem mais escreveu nela. Sem ninguém: fica só no total do sistema.
  agd as (select x.agente_id, count(*) as n, count(*) filter (where x.automatico) as n_auto
            from (select coalesce(p.agendado_por, c.agente_id, (select m.agente_id from public.mensagens m where m.conversa_id = p.conversa_id and m.autor = 'agente' and m.agente_id is not null
                                                                  group by m.agente_id order by count(*) desc, m.agente_id limit 1)) as agente_id,
                         p.agendado_por is null as automatico
                    from public.pre_agendamentos p join cv on cv.id = p.conversa_id join public.conversas c on c.id = p.conversa_id
                   where coalesce(p.agendado_em, p.agendado_auto_em) >= v_i and coalesce(p.agendado_em, p.agendado_auto_em) < v_f) x
           where x.agente_id is not null group by x.agente_id),
  prim as (select distinct on (m.conversa_id) m.conversa_id, m.agente_id, m.criado_em as quando
             from public.mensagens m join cv on cv.id = m.conversa_id
            where (cv.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate and m.autor = 'agente' and m.agente_id is not null
            order by m.conversa_id, m.criado_em),
  resp as (select prim.agente_id, count(*) as primeiras,
                  round((percentile_cont(0.5) within group (order by extract(epoch from (prim.quando - cv.criado_em)) / 60))::numeric, 0) as espera_mediana_min
             from prim join cv on cv.id = prim.conversa_id where prim.quando >= cv.criado_em group by prim.agente_id),
  av as (select a.conversa_id, a.nota_atendimento from public.avaliacao_atendimento a join cv on cv.id = a.conversa_id
          where (a.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
  prin as (select distinct on (x.conversa_id) x.conversa_id, x.agente_id
             from (select m.conversa_id, m.agente_id, count(*) as n from public.mensagens m
                    where m.conversa_id in (select conversa_id from av) and m.autor = 'agente' and m.agente_id is not null group by 1, 2) x
            order by x.conversa_id, x.n desc),
  nota as (select prin.agente_id, count(*) as n, round(avg(av.nota_atendimento)::numeric, 1) as media
             from av join prin on prin.conversa_id = av.conversa_id group by prin.agente_id),
  pes as (select q.nome, coalesce(msg.conversas, 0) as conversas, coalesce(agd.n, 0) as agendados, coalesce(agd.n_auto, 0) as agendados_automaticos, coalesce(nota.n, 0) as avaliacoes, nota.media as nota_media,
                 coalesce(resp.primeiras, 0) as primeiras, resp.espera_mediana_min
            from quem q left join msg on msg.agente_id = q.id left join agd on agd.agente_id = q.id left join nota on nota.agente_id = q.id left join resp on resp.agente_id = q.id
           where q.papel = 'atendente' or coalesce(msg.conversas, 0) > 0 or coalesce(agd.n, 0) > 0)
  select jsonb_build_object('periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'unidade', v_un, 'gerado_em', now(),
    'pessoas', coalesce((select jsonb_agg(to_jsonb(p) order by p.nome) from pes p), '[]'::jsonb),
    'nota_media_geral', (select round(avg(nota_atendimento)::numeric, 1) from av join prin on prin.conversa_id = av.conversa_id where prin.agente_id in (select id from quem)))
    into v_out;
  return v_out;
end $function$;

-- Parte 2: painel_indicadores_equipe
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
