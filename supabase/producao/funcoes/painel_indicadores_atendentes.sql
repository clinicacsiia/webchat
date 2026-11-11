-- public.painel_indicadores_atendentes(p_de date, p_ate date, p_unidade text, p_incluir_teste boolean)
-- Pode executar: authenticated, service_role
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
  agd as (select p.agendado_por as agente_id, count(*) as n from public.pre_agendamentos p join cv on cv.id = p.conversa_id
           where p.agendado_em >= v_i and p.agendado_em < v_f and p.agendado_por is not null group by p.agendado_por),
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
  pes as (select q.nome, coalesce(msg.conversas, 0) as conversas, coalesce(agd.n, 0) as agendados, coalesce(nota.n, 0) as avaliacoes, nota.media as nota_media,
                 coalesce(resp.primeiras, 0) as primeiras, resp.espera_mediana_min
            from quem q left join msg on msg.agente_id = q.id left join agd on agd.agente_id = q.id left join nota on nota.agente_id = q.id left join resp on resp.agente_id = q.id
           where q.papel = 'atendente' or coalesce(msg.conversas, 0) > 0 or coalesce(agd.n, 0) > 0)
  select jsonb_build_object('periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'unidade', v_un, 'gerado_em', now(),
    'pessoas', coalesce((select jsonb_agg(to_jsonb(p) order by p.nome) from pes p), '[]'::jsonb),
    'nota_media_geral', (select round(avg(nota_atendimento)::numeric, 1) from av join prin on prin.conversa_id = av.conversa_id where prin.agente_id in (select id from quem)))
    into v_out;
  return v_out;
end $function$;

