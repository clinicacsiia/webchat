-- FLUXOGRAMA: entrada (atendente/supervisão escolhe uma ou várias conversas e uma PESSOA ou uma UNIDADE de destino; o paciente liga/silencia os avisos no sino do chat; a gestão pede os indicadores por pessoa e equipe) -> validação (tudo ou nada: se UMA conversa do lote for inválida nada é transferido e o resumo diz qual e por quê; máximo de 50; encerrada não transfere; permissão pela mesma regra da Etapa B — em modo observação só REGISTRA o que seria recusado) -> lógica (pessoa: troca o responsável e reinicia as 24 h; unidade: devolve à fila da unidade sem dono e muda unidade_responsavel; um evento "transferencia" com de/para/quem/motivo; aviso no sino de quem recebe) -> saída (conversa_transferir, painel_indicadores_equipe, chat_push_silenciar/chat_push_estado e o gatilho de push que respeita o silêncio)
-- Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial da Etapa D (TRANS-01, TRANS-02, NOT-01, NOT-02, MON-01, MON-03).
-- Pré-requisitos: etapa-b-estrutura.sql, c1-reentrada.sql (equipe_notificacao), etapa0-eventos-e-teste.sql (conversa_evento), agendado-autoria.sql, chat-push.sql. Aditivo.
-- DESLIGAR o silêncio: o gatilho só respeita conversas.push_silenciado_em; basta zerar. A transferência antiga (update direto do painel) continua funcionando enquanto o painel não trocar.
-- ROLLBACK: drop function public.conversa_transferir(uuid[], uuid, text, text), public.painel_indicadores_equipe(date, date, boolean), public.chat_push_silenciar(uuid, text, boolean), public.chat_push_estado(uuid, text); (reaplicar chat_push_trg de chat-push.sql)

-- ===== TRANSFERÊNCIA (uma ou em lote) =====
create or replace function public.conversa_transferir(p_conversas uuid[], p_para_agente uuid default null, p_para_unidade text default null, p_motivo text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_uid uuid := (select auth.uid()); v_papel text := (select public.papel_atual()); v_modo text; r record; v_ids uuid[];
  v_inv jsonb := '[]'::jsonb; v_ok uuid[] := '{}'; v_dest public.agentes; v_motivo text := nullif(left(btrim(coalesce(p_motivo, '')), 300), ''); v_uni text := nullif(btrim(coalesce(p_para_unidade, '')), ''); v_n integer; v_quem text;
begin
  if v_papel not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '42501'; end if;
  if (p_para_agente is null) = (v_uni is null) then raise exception 'Escolha uma pessoa OU uma unidade.' using errcode = '22023'; end if;
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_conversas, '{}')) x;
  if v_ids is null then raise exception 'Escolha ao menos uma conversa.' using errcode = '22023'; end if;
  if cardinality(v_ids) > 50 then raise exception 'No máximo 50 conversas por vez.' using errcode = '22023'; end if;
  if p_para_agente is not null then
    select * into v_dest from public.agentes where id = p_para_agente and ativo and papel in ('admin', 'atendente');
    if not found then raise exception 'Essa pessoa não pode receber conversas.' using errcode = '22023'; end if;
  elsif not exists (select 1 from public.unidade_config where chave = v_uni and ativo) then
    raise exception 'Unidade inválida.' using errcode = '22023';
  end if;
  v_modo := coalesce((select valor from public.config where chave = 'permissao_modo'), 'desligado');
  -- 1) valida TODAS antes de mexer em qualquer uma
  for r in select c.id, c.status, c.agente_id, coalesce(c.unidade_responsavel, c.unidade_inicial) as un from public.conversas c where c.id = any (v_ids) order by c.id for update loop
    if r.status = 'encerrada' then v_inv := v_inv || jsonb_build_object('id', r.id, 'motivo', 'A conversa está encerrada.'); continue; end if;
    if p_para_agente is not null and r.agente_id = p_para_agente then v_inv := v_inv || jsonb_build_object('id', r.id, 'motivo', 'Já está com essa pessoa.'); continue; end if;
    if v_uni is not null and r.un is not distinct from v_uni and r.agente_id is null then v_inv := v_inv || jsonb_build_object('id', r.id, 'motivo', 'Já está na fila dessa unidade.'); continue; end if;
    if not public.org_pode_ver(v_uid, v_papel, r.agente_id, r.un) then
      insert into public.permissao_observacao (agente_id, acao, conversa_id, unidade, detalhe) values (v_uid, 'transferir', r.id, r.un, jsonb_build_object('modo', v_modo));
      if v_modo = 'ligado' then v_inv := v_inv || jsonb_build_object('id', r.id, 'motivo', 'Sem permissão para esta conversa.'); continue; end if;
    end if;
    v_ok := v_ok || r.id;
  end loop;
  select count(*) into v_n from public.conversas where id = any (v_ids);
  if v_n <> cardinality(v_ids) then v_inv := v_inv || jsonb_build_object('id', null, 'motivo', 'Alguma conversa não foi encontrada.'); end if;
  if jsonb_array_length(v_inv) > 0 then
    return jsonb_build_object('ok', false, 'transferidas', 0, 'recusadas', v_inv, 'mensagem', 'Nada foi transferido: ' || jsonb_array_length(v_inv) || ' conversa(s) não podem ser transferidas.');
  end if;
  -- 2) aplica (a mesma transação: ou vai tudo, ou nada)
  for r in select c.id, c.agente_id, coalesce(c.unidade_responsavel, c.unidade_inicial) as un from public.conversas c where c.id = any (v_ok) loop
    if p_para_agente is not null then
      update public.conversas set agente_id = p_para_agente, status = case when status = 'aguardando' then 'em_atendimento' else status end where id = r.id;
    else
      update public.conversas set agente_id = null, unidade_responsavel = v_uni, status = 'aguardando' where id = r.id;
    end if;
    insert into public.conversa_evento (conversa_id, tipo, de_agente, para_agente, por, motivo, detalhe)
    values (r.id, 'transferencia', r.agente_id, p_para_agente, v_uid, v_motivo, jsonb_build_object('de_unidade', r.un, 'para_unidade', coalesce(v_uni, r.un), 'lote', cardinality(v_ok)));
  end loop;
  -- 3) avisa no sino: uma notificação por pessoa (não uma por conversa)
  select coalesce(nome, 'Alguém') into v_quem from public.agentes where id = v_uid;
  if p_para_agente is not null then
    insert into public.equipe_notificacao (agente_id, tipo, conversa_id, detalhe)
    values (p_para_agente, 'transferida_para_voce', case when cardinality(v_ok) = 1 then v_ok[1] end, jsonb_build_object('de', v_quem, 'quantidade', cardinality(v_ok), 'motivo', v_motivo));
  else
    insert into public.equipe_notificacao (agente_id, tipo, conversa_id, detalhe)
    select distinct m.agente_id, 'transferida_para_unidade', case when cardinality(v_ok) = 1 then v_ok[1] end, jsonb_build_object('de', v_quem, 'quantidade', cardinality(v_ok), 'unidade', v_uni, 'motivo', v_motivo)
      from public.org_membro m join public.org_equipe e on e.id = m.equipe_id
     where m.ativo and m.agente_id is not null and m.agente_id <> v_uid and e.ativa and (e.unidade = v_uni or e.transversal);
  end if;
  return jsonb_build_object('ok', true, 'transferidas', cardinality(v_ok), 'recusadas', '[]'::jsonb);
end $$;
revoke all on function public.conversa_transferir(uuid[], uuid, text, text) from public, anon;
grant execute on function public.conversa_transferir(uuid[], uuid, text, text) to authenticated;

-- ===== INDICADORES POR PESSOA E EQUIPE (MON-01/03) =====
-- Cada pessoa conta "participou" nas conversas em que escreveu; o total geral conta a conversa UMA vez. Dia = fuso de Brasília. Testes ficam fora.
create or replace function public.painel_indicadores_equipe(p_de date default null, p_ate date default null, p_incluir_teste boolean default false) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_nivel text := public.org_nivel(); v_uid uuid := (select auth.uid()); v_de timestamptz; v_ate timestamptz; v_res jsonb;
begin
  if v_nivel is null then raise exception 'Não autorizado.' using errcode = '42501'; end if;
  p_de := coalesce(p_de, ((now() at time zone 'America/Sao_Paulo')::date - 29));
  p_ate := coalesce(p_ate, (now() at time zone 'America/Sao_Paulo')::date);
  if p_ate < p_de or p_ate - p_de > 400 then raise exception 'Período inválido.' using errcode = '22023'; end if;
  v_de := (p_de::timestamp at time zone 'America/Sao_Paulo'); v_ate := ((p_ate + 1)::timestamp at time zone 'America/Sao_Paulo');
  with quem as (   -- quem este usuário pode enxergar
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
  agd as (select p.agendado_por as agente_id, count(*) as n from public.pre_agendamentos p join cv on cv.id = p.conversa_id
           where p.agendado_em >= v_de and p.agendado_em < v_ate and p.agendado_por is not null group by p.agendado_por),
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
end $$;
revoke all on function public.painel_indicadores_equipe(date, date, boolean) from public, anon;
grant execute on function public.painel_indicadores_equipe(date, date, boolean) to authenticated;

-- ===== SINO DO PACIENTE (NOT-01): ativo / silenciado / bloqueado-no-aparelho; silenciar e reativar =====
alter table public.conversas add column if not exists push_silenciado_em timestamptz;
comment on column public.conversas.push_silenciado_em is 'O paciente silenciou os avisos desta conversa no sino do chat (nulo = avisos normais).';
create or replace function public.chat_push_silenciar(p_conversa uuid, p_token text, p_silenciar boolean) returns boolean
language plpgsql security definer set search_path to '' as $$
begin
  perform 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  update public.conversas set push_silenciado_em = case when coalesce(p_silenciar, false) then coalesce(push_silenciado_em, now()) end where id = p_conversa;
  return coalesce(p_silenciar, false);
end $$;
revoke all on function public.chat_push_silenciar(uuid, text, boolean) from public;
grant execute on function public.chat_push_silenciar(uuid, text, boolean) to anon, authenticated;

create or replace function public.chat_push_estado(p_conversa uuid, p_token text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  perform 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  return jsonb_build_object('inscrito', exists (select 1 from public.chat_push_inscricao where conversa_id = p_conversa),
                            'silenciado', (select push_silenciado_em is not null from public.conversas where id = p_conversa));
end $$;
revoke all on function public.chat_push_estado(uuid, text) from public;
grant execute on function public.chat_push_estado(uuid, text) to anon, authenticated;

create or replace function public.chat_push_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v_url text; v_seg text;
begin
  if new.autor <> 'agente' then return null; end if;
  if not exists (select 1 from public.chat_push_inscricao where conversa_id = new.conversa_id) then return null; end if;
  if exists (select 1 from public.conversas where id = new.conversa_id and push_silenciado_em is not null) then return null; end if;   -- o paciente silenciou
  select valor into v_url from public.config where chave = 'chat_push_url';
  v_seg := public.fila_aviso_segredo();
  if coalesce(v_url, '') <> '' and coalesce(v_seg, '') <> '' then
    begin
      perform net.http_post(url := v_url, body := jsonb_build_object('conversa', new.conversa_id, 'mensagem', new.id),
                            headers := jsonb_build_object('Content-Type', 'application/json', 'x-fila-aviso-segredo', v_seg));
    exception when others then null;
    end;
  end if;
  return null;
end $$;
