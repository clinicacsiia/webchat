-- Fase 5: aprendizado com o que acontece depois da IA.
-- A IA monta o pré-agendamento; o atendente e o Klingo mostram onde ela errou. Esta fase REGISTRA isso (sem dado de paciente)
-- e mostra no painel (aba Aprendizado, só administrador): funil, qualidade, alertas, exames problemáticos, preços e exemplos para o prompt.
--
-- 1. ia_evento           : linha do tempo de cada pré-agendamento (criado, mudança de status, veredito da conferência). Preenchida por gatilho.
-- 2. preco_observado     : preço "Previsto" lançado no Klingo, agregado por exame e operadora (a Edge Function envia só o agregado).
-- 3. ia_relatorio        : números do painel.  ia_precos_divergentes : catálogo x Klingo.  ia_exemplos : casos para melhorar o prompt.
-- 4. ia_evento_motivo    : o atendente pode registrar por que cancelou (motivos da lista do painel; números e e-mails são mascarados).
-- Tudo é aditivo: nada existente é alterado. Pode ser rodado mais de uma vez.

-- ===== 1. Linha do tempo =====
create table if not exists public.ia_evento (
  id bigint generated always as identity primary key,
  pre_agendamento_id uuid references public.pre_agendamentos(id) on delete set null,
  conversa_id uuid,
  tipo text not null check (tipo in ('criado','status','conferencia')),
  de text,
  para text,
  por text not null default 'sistema' check (por in ('atendente','sistema')),
  agente_id uuid,
  detalhe text,
  contexto jsonb not null default '{}'::jsonb,   -- exames, plano, unidade, etapa no momento: nada que identifique o paciente
  criado_em timestamptz not null default now()
);
comment on table public.ia_evento is 'Linha do tempo dos pré-agendamentos (criado, status, conferência) para medir onde a IA erra. Sem dado de paciente. Só admin lê (pelas funções ia_*).';
create index if not exists ia_evento_pre_idx on public.ia_evento (pre_agendamento_id, criado_em);
create index if not exists ia_evento_criado_idx on public.ia_evento (criado_em desc);
alter table public.ia_evento enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ia_evento' and policyname = 'ia_evento_select') then
    create policy ia_evento_select on public.ia_evento for select using ((select public.papel_atual()) = 'admin');
  end if;
end $$;

-- Quem mexeu: atendente do painel (tem sessão de agente ativo) ou o sistema (IA, conferência automática, crons).
create or replace function public.ia_evento_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
declare
  v_agente uuid := (select auth.uid());
  v_por text := 'sistema';
  v_ctx jsonb;
begin
  if v_agente is not null and exists (select 1 from public.agentes a where a.id = v_agente and a.ativo) then
    v_por := 'atendente';
  else
    v_agente := null;
  end if;

  select jsonb_build_object(
    'tipo', new.tipo, 'especialidade', new.especialidade, 'plano', new.plano, 'unidade', new.unidade, 'etapa', new.etapa,
    'exames', coalesce((select jsonb_agg(distinct coalesce(i.procedimento, i.regiao_nome)) from public.pre_agendamento_itens i
                         where i.conversa_id = new.conversa_id and i.ativo and coalesce(i.procedimento, i.regiao_nome) is not null),
                       case when new.procedimento is not null then jsonb_build_array(new.procedimento) else '[]'::jsonb end))
    into v_ctx;

  if tg_op = 'INSERT' then
    insert into public.ia_evento (pre_agendamento_id, conversa_id, tipo, para, por, agente_id, contexto)
    values (new.id, new.conversa_id, 'criado', new.status, v_por, v_agente, v_ctx);
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.ia_evento (pre_agendamento_id, conversa_id, tipo, de, para, por, agente_id, detalhe, contexto)
    values (new.id, new.conversa_id, 'status', old.status, new.status, v_por, v_agente,
            case when new.status = 'agendado' and new.agendado_auto_em is distinct from old.agendado_auto_em then 'automatico' end, v_ctx);
  end if;
  if new.conferencia_status is distinct from old.conferencia_status and new.conferencia_status is not null then
    insert into public.ia_evento (pre_agendamento_id, conversa_id, tipo, de, para, por, agente_id, detalhe, contexto)
    values (new.id, new.conversa_id, 'conferencia', old.conferencia_status, new.conferencia_status, v_por, v_agente,
            left(new.conferencia_detalhe, 300), v_ctx);
  end if;
  return new;
exception when others then
  raise warning 'ia_evento_trg: %', sqlerrm;   -- registrar nunca pode atrapalhar o atendimento
  return new;
end $$;
revoke all on function public.ia_evento_trg() from public, anon, authenticated;

create or replace trigger ia_evento_pre
  after insert or update of status, conferencia_status on public.pre_agendamentos
  for each row execute function public.ia_evento_trg();

-- Motivo do cancelamento, informado pelo atendente que cancelou (opcional). Só vale para um cancelamento feito por quem chama, nos últimos 10 minutos.
-- Números longos (telefone, CPF) e e-mails são mascarados por segurança: o motivo nunca deve carregar dado de paciente.
create or replace function public.ia_evento_motivo(p_pre uuid, p_motivo text) returns void
language plpgsql security definer set search_path to '' as $$
declare v_txt text; v_id bigint;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin','atendente') then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  v_txt := nullif(btrim(regexp_replace(regexp_replace(coalesce(p_motivo, ''), '[^[:space:]]+@[^[:space:]]+', '[e-mail]', 'g'), '[0-9][0-9. ()-]{2,}[0-9]', '[número]', 'g')), '');
  if v_txt is null then return; end if;
  select e.id into v_id from public.ia_evento e
   where e.pre_agendamento_id = p_pre and e.tipo = 'status' and e.para = 'cancelado' and e.por = 'atendente'
     and e.agente_id = (select auth.uid()) and e.criado_em > now() - interval '10 minutes'
   order by e.criado_em desc limit 1;
  if v_id is null then
    raise exception 'Não achei um cancelamento seu, feito há menos de 10 minutos, para registrar o motivo.' using errcode = 'P0002';
  end if;
  update public.ia_evento set detalhe = left(v_txt, 300) where id = v_id;
end $$;
revoke all on function public.ia_evento_motivo(uuid, text) from public, anon;
grant execute on function public.ia_evento_motivo(uuid, text) to authenticated;

-- ===== 2. Preço lançado no Klingo (relatório #7, coluna Previsto), só agregado =====
create table if not exists public.preco_observado (
  procedimento_norm text not null,
  operadora_norm text not null,
  procedimento text not null,
  operadora text not null,
  valor_tipico numeric(12,2) not null,   -- o valor que mais se repete na janela
  valor_min numeric(12,2) not null,
  valor_max numeric(12,2) not null,
  amostras integer not null check (amostras >= 1),
  janela_ini date,
  janela_fim date,
  atualizado_em timestamptz not null default now(),
  primary key (procedimento_norm, operadora_norm)
);
comment on table public.preco_observado is 'Preço Previsto das marcações do Klingo (relatório #7), agregado por exame e operadora na janela lida. Sem dado de paciente. Serve para conferir o catalogo_preco.';
alter table public.preco_observado enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'preco_observado' and policyname = 'preco_observado_select') then
    create policy preco_observado_select on public.preco_observado for select using ((select public.papel_atual()) = 'admin');
  end if;
end $$;

-- Chave de comparação: igual à norm_nome (maiúsculas, sem acento), mas MANTÉM os números, porque "2 INCIDENCIAS" e "3 INCIDENCIAS" são exames (e preços) diferentes.
create or replace function public.norm_chave(t text) returns text
language sql stable set search_path to '' as $$
  select nullif(btrim(regexp_replace(regexp_replace(upper(extensions.unaccent(coalesce(t, ''))), '[^A-Z0-9 ]', ' ', 'g'), '\s+', ' ', 'g')), '')
$$;
revoke all on function public.norm_chave(text) from public, anon, authenticated;

-- p_linhas: [{"procedimento","operadora","valor_tipico","valor_min","valor_max","amostras","ini","fim"}]. Sobrescreve (não acumula): rodar de novo não duplica.
create or replace function public.preco_observado_registrar(p_linhas jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_n int := 0; l jsonb; v_pn text; v_on text; v_tip numeric; v_min numeric; v_max numeric; v_am int;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then return jsonb_build_object('gravadas', 0); end if;
  if jsonb_array_length(p_linhas) > 5000 then raise exception 'Linhas demais (máximo 5000).' using errcode = '22023'; end if;
  for l in select x from jsonb_array_elements(p_linhas) x loop
    begin
      v_pn := public.norm_chave(l ->> 'procedimento'); v_on := public.norm_chave(l ->> 'operadora');
      v_tip := (l ->> 'valor_tipico')::numeric; v_min := (l ->> 'valor_min')::numeric; v_max := (l ->> 'valor_max')::numeric;
      v_am := (l ->> 'amostras')::int;
      if coalesce(v_pn, '') = '' or coalesce(v_on, '') = '' or v_tip is null or v_tip <= 0 or v_min is null or v_max is null or coalesce(v_am, 0) < 1 then continue; end if;
      insert into public.preco_observado (procedimento_norm, operadora_norm, procedimento, operadora, valor_tipico, valor_min, valor_max, amostras, janela_ini, janela_fim, atualizado_em)
      values (v_pn, v_on, left(l ->> 'procedimento', 200), left(l ->> 'operadora', 120), v_tip, v_min, v_max, v_am,
              nullif(l ->> 'ini', '')::date, nullif(l ->> 'fim', '')::date, now())
      on conflict (procedimento_norm, operadora_norm) do update set
        procedimento = excluded.procedimento, operadora = excluded.operadora, valor_tipico = excluded.valor_tipico, valor_min = excluded.valor_min,
        valor_max = excluded.valor_max, amostras = excluded.amostras, janela_ini = excluded.janela_ini, janela_fim = excluded.janela_fim, atualizado_em = now();
      v_n := v_n + 1;
    exception when others then
      raise warning 'preco_observado_registrar: %', sqlerrm;
    end;
  end loop;
  return jsonb_build_object('gravadas', v_n);
end $$;
revoke all on function public.preco_observado_registrar(jsonb) from public, anon, authenticated;
grant execute on function public.preco_observado_registrar(jsonb) to service_role;

-- ===== 3. Relatórios do painel (só administrador) =====
-- Pedidos acompanhados pela Fase 5: criados dentro da janela E depois que o registro começou (têm o evento "criado").
-- Pedidos anteriores à instalação não têm histórico e distorceriam todos os percentuais. Só as outras funções ia_* chamam.
create or replace function public.ia_coorte(p_ini timestamptz) returns table (id uuid)
language sql stable security definer set search_path to '' as $$
  select p.id from public.pre_agendamentos p
   where p.criado_em >= p_ini and exists (select 1 from public.ia_evento c where c.pre_agendamento_id = p.id and c.tipo = 'criado')
$$;
revoke all on function public.ia_coorte(timestamptz) from public, anon, authenticated;

create or replace function public.ia_relatorio(p_dias integer default 28) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_dias int := least(greatest(coalesce(p_dias, 28), 7), 365);
  v_ini timestamptz := now() - make_interval(days => least(greatest(coalesce(p_dias, 28), 7), 365));
  v_desde timestamptz := (select min(e.criado_em) from public.ia_evento e);
  v_resumo jsonb; v_alertas jsonb; v_abandono jsonb; v_semanas jsonb; v_exames jsonb; v_atend jsonb; v_conv jsonb; v_tempo numeric;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then
    raise exception 'Somente o administrador vê o relatório de aprendizado.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'criados', count(*),
    'agendados_auto', count(*) filter (where p.status = 'agendado' and p.agendado_auto_em is not null),
    'agendados_auto_sem_alerta', count(*) filter (where p.status = 'agendado' and p.agendado_auto_em is not null
        and not exists (select 1 from public.ia_evento e where e.pre_agendamento_id = p.id and e.tipo = 'conferencia' and e.para <> 'confirmado')),
    'agendados_manual', count(*) filter (where p.status = 'agendado' and p.agendado_auto_em is null),
    'cancelados', count(*) filter (where p.status = 'cancelado'),
    'prontos_esperando', count(*) filter (where p.status = 'pronto'),
    'em_andamento', count(*) filter (where p.status = 'rascunho' and p.atualizado_em >= now() - interval '24 hours'),
    'abandonados', count(*) filter (where p.status = 'rascunho' and p.atualizado_em < now() - interval '24 hours'),
    'com_alerta_agora', count(*) filter (where p.conferencia_status is not null and p.conferencia_status <> 'confirmado'))
    into v_resumo
    from public.pre_agendamentos p where p.id in (select c.id from public.ia_coorte(v_ini) c);

  select coalesce(jsonb_object_agg(x.para, x.n), '{}'::jsonb) into v_alertas
    from (select e.para, count(distinct e.pre_agendamento_id) as n from public.ia_evento e
           where e.tipo = 'conferencia' and e.para <> 'confirmado' and e.pre_agendamento_id in (select c.id from public.ia_coorte(v_ini) c)
           group by e.para) x;

  select coalesce(jsonb_object_agg(x.etapa, x.n), '{}'::jsonb) into v_abandono
    from (select coalesce(p.etapa, 'pedido') as etapa, count(*) as n from public.pre_agendamentos p
           where p.status = 'rascunho' and p.atualizado_em < now() - interval '24 hours' and p.id in (select c.id from public.ia_coorte(v_ini) c) group by 1) x;

  -- uma amostra por pedido: da primeira vez em "pronto" até o primeiro "agendado" depois dela
  select round((percentile_cont(0.5) within group (order by x.minutos))::numeric, 1) into v_tempo
    from (select (extract(epoch from (a.t - p.t)) / 60)::double precision as minutos
            from (select e.pre_agendamento_id, min(e.criado_em) as t from public.ia_evento e
                   where e.tipo = 'status' and e.para = 'pronto' and e.pre_agendamento_id in (select c.id from public.ia_coorte(v_ini) c)
                   group by e.pre_agendamento_id) p
            cross join lateral (select min(e2.criado_em) as t from public.ia_evento e2
                                 where e2.pre_agendamento_id = p.pre_agendamento_id and e2.tipo = 'status' and e2.para = 'agendado' and e2.criado_em >= p.t) a
           where a.t is not null) x;

  select coalesce(jsonb_agg(jsonb_build_object('semana', s.semana, 'criados', s.criados, 'agendados', s.agendados, 'com_alerta', s.com_alerta, 'cancelados', s.cancelados) order by s.semana), '[]'::jsonb)
    into v_semanas
    from (select date_trunc('week', p.criado_em at time zone 'America/Bahia')::date as semana,
                 count(*) as criados,
                 count(*) filter (where p.status = 'agendado') as agendados,
                 count(*) filter (where exists (select 1 from public.ia_evento e where e.pre_agendamento_id = p.id and e.tipo = 'conferencia' and e.para <> 'confirmado')) as com_alerta,
                 count(*) filter (where p.status = 'cancelado') as cancelados
            from public.pre_agendamentos p where p.id in (select c.id from public.ia_coorte(v_ini) c) group by 1) s;

  -- Exames com mais problema (alerta da conferência ou cancelamento) sobre o total de pedidos do exame. As duas contagens vêm dos mesmos eventos,
  -- então "com problema" nunca passa de "pedidos do exame".
  select coalesce(jsonb_agg(jsonb_build_object('exame', y.exame, 'problemas', y.problemas, 'total', y.total) order by y.problemas desc, y.exame), '[]'::jsonb) into v_exames
    from (select x.exame,
                 count(distinct e.pre_agendamento_id) filter (where (e.tipo = 'conferencia' and e.para <> 'confirmado') or (e.tipo = 'status' and e.para = 'cancelado')) as problemas,
                 count(distinct e.pre_agendamento_id) as total
            from public.ia_evento e
            cross join lateral jsonb_array_elements_text(coalesce(e.contexto -> 'exames', '[]'::jsonb)) x(exame)
           where e.pre_agendamento_id in (select c.id from public.ia_coorte(v_ini) c)
           group by x.exame
          having count(distinct e.pre_agendamento_id) filter (where (e.tipo = 'conferencia' and e.para <> 'confirmado') or (e.tipo = 'status' and e.para = 'cancelado')) > 0
           order by 2 desc, 1 limit 10) y;

  select jsonb_build_object(
    'marcou_agendado', count(*) filter (where e.tipo = 'status' and e.para = 'agendado' and e.por = 'atendente'),
    'cancelou', count(*) filter (where e.tipo = 'status' and e.para = 'cancelado' and e.por = 'atendente'),
    'desfez_agendado', count(*) filter (where e.tipo = 'status' and e.de = 'agendado' and e.para in ('pronto', 'rascunho') and e.por = 'atendente'),
    'cancelou_com_motivo', count(*) filter (where e.tipo = 'status' and e.para = 'cancelado' and e.por = 'atendente' and e.detalhe is not null))
    into v_atend from public.ia_evento e where e.pre_agendamento_id in (select c.id from public.ia_coorte(v_ini) c);

  select jsonb_build_object('total', count(*), 'assumidas_por_atendente', count(*) filter (where not c.ia_ativa))
    into v_conv from public.conversas c where c.criado_em >= greatest(v_ini, coalesce(v_desde, now()));

  return jsonb_build_object('dias', v_dias, 'desde', v_ini, 'registro_desde', v_desde, 'resumo', v_resumo, 'alertas', v_alertas, 'abandono_por_etapa', v_abandono,
    'tempo_mediano_pronto_agendado_min', v_tempo, 'semanas', v_semanas, 'exames_problema', v_exames, 'atendentes', v_atend, 'conversas', v_conv,
    'observacao', 'Conta só os pedidos criados depois que o registro da Fase 5 começou; pedidos anteriores não entram.');
end $$;
revoke all on function public.ia_relatorio(integer) from public, anon;
grant execute on function public.ia_relatorio(integer) to authenticated;

-- Preço previsto do catálogo x preço lançado no Klingo. Escolhe, para cada exame e operadora, a linha do catálogo mais próxima do que o Klingo mostra.
create or replace function public.ia_precos_divergentes(p_limite integer default 30, p_minimo_pct numeric default 10) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_lim int := least(greatest(coalesce(p_limite, 30), 1), 200); v_min numeric := greatest(coalesce(p_minimo_pct, 10), 1); v_res jsonb;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then
    raise exception 'Somente o administrador vê o relatório de aprendizado.' using errcode = '42501';
  end if;
  with par as (
    select distinct on (o.procedimento_norm, o.operadora_norm)
           o.procedimento, o.operadora, o.amostras, o.valor_tipico, o.valor_min, o.valor_max, o.atualizado_em,
           c.valor as catalogo, c.fonte, c.confianca,
           round((o.valor_tipico - c.valor) / nullif(c.valor, 0) * 100, 1) as dif_pct
      from public.preco_observado o
      join public.catalogo_procedimento p on public.norm_chave(p.nome) = o.procedimento_norm
      join public.catalogo_preco c on c.procedimento_id = p.id and c.status = 'ativo' and c.valor is not null and c.valor > 0
       and ((c.fonte = 'particular' and o.operadora_norm like '%PARTICULAR%')
         or (c.fonte = 'convenio' and public.norm_chave(c.operadora) = o.operadora_norm))
     order by o.procedimento_norm, o.operadora_norm, abs(o.valor_tipico - c.valor)
  )
  select jsonb_build_object(
      'comparados', (select count(*) from par),
      'sem_referencia', (select count(*) from public.preco_observado) - (select count(*) from par),
      'divergentes_total', (select count(*) from par where abs(dif_pct) >= v_min),
      'divergentes', coalesce((select jsonb_agg(jsonb_build_object('exame', d.procedimento, 'operadora', d.operadora, 'catalogo', d.catalogo,
              'klingo', d.valor_tipico, 'dif_pct', d.dif_pct, 'amostras', d.amostras, 'fonte', d.fonte, 'confianca', d.confianca) order by abs(d.dif_pct) desc)
          from (select * from par where abs(dif_pct) >= v_min order by abs(dif_pct) desc limit v_lim) d), '[]'::jsonb),
      'atualizado_em', (select max(atualizado_em) from public.preco_observado))
    into v_res;
  return v_res;
end $$;
revoke all on function public.ia_precos_divergentes(integer, numeric) from public, anon;
grant execute on function public.ia_precos_divergentes(integer, numeric) to authenticated;

-- Casos recentes com problema, sem dado de paciente, para o administrador melhorar o prompt do n8n.
create or replace function public.ia_exemplos(p_dias integer default 28, p_limite integer default 40) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_ini timestamptz := now() - make_interval(days => least(greatest(coalesce(p_dias, 28), 7), 365)); v_lim int := least(greatest(coalesce(p_limite, 40), 1), 200); v_res jsonb;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then
    raise exception 'Somente o administrador vê o relatório de aprendizado.' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(x.j order by x.criado_em desc), '[]'::jsonb) into v_res
    from (select e.criado_em,
                 jsonb_build_object('quando', e.criado_em, 'caso', case when e.tipo = 'conferencia' then e.para else 'cancelado' end, 'por', e.por,
                   'exames', coalesce(e.contexto -> 'exames', '[]'::jsonb), 'plano', e.contexto ->> 'plano', 'unidade', e.contexto ->> 'unidade',
                   'etapa', e.contexto ->> 'etapa', 'detalhe', e.detalhe) as j
            from public.ia_evento e
           where e.criado_em >= v_ini and ((e.tipo = 'conferencia' and e.para <> 'confirmado') or (e.tipo = 'status' and e.para = 'cancelado'))
           order by e.criado_em desc limit v_lim) x;
  return v_res;
end $$;
revoke all on function public.ia_exemplos(integer, integer) from public, anon;
grant execute on function public.ia_exemplos(integer, integer) to authenticated;
