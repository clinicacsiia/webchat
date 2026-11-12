-- Autoatendimento com a API do Klingo — Parte 5: medidas, autogestão (avança e recua sozinha), rotinas. Escrito em 12/11/2026.
--
-- FLUXOGRAMA: o chat e o executor contam o que acontece (klingo_medida, klingo_operacao) -> a cada 10 min klingo_autogestao lê as medidas e decide:
--   horários: sombra -> sim quando a API deu certo e bate com a grade; sim -> sombra quando a API falha em metade das chamadas do dia;
--   marcar: teste -> sim (10%) depois de 20 marcações de teste sem incerto; 10% -> 50% -> 100% a cada 2 dias com taxa de sucesso alta; sim -> teste se houver 2 incertas ou muitas falhas técnicas em 24 h.
--   Toda decisão fica em klingo_decisao e AVISA a gestão (equipe_notificacao): o humano só entra quando o sistema recua.
-- Versão 1.0 — 12/11/2026 / Mudança: primeira versão.
-- Para voltar atrás: update public.config set valor = 'nao' where chave = 'klingo_autogestao'; (o sistema para de mexer nos interruptores); select cron.unschedule('klingo-autogestao'); etc. (ver rotinas no fim)

create table if not exists public.klingo_decisao (
  id bigint generated always as identity primary key,
  em timestamptz not null default now(),
  chave text not null,
  de text,
  para text,
  motivo jsonb not null default '{}'::jsonb
);
alter table public.klingo_decisao enable row level security;

-- Soma de uma medida nos últimos p_dias dias (1 = só hoje, em Bahia)
create or replace function public.klingo_medida_soma(p_tipo text, p_dias integer) returns bigint
language sql stable security definer set search_path to '' as $$
  select coalesce(sum(n), 0)::bigint from public.klingo_medida where tipo = p_tipo and dia > (now() at time zone 'America/Bahia')::date - greatest(p_dias, 1)
$$;

-- Modo sombra: compara o que a API ofereceu com o que a grade mostraria, SEM mudar nada para o paciente.
create or replace function public.klingo_sombra_medir(p_conversa uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare d jsonb := public.klingo_dados_conversa(p_conversa); v_proc integer := (d ->> 'procedimento')::integer; v_api integer; v_grade integer; v_a_na_g integer; v_g_na_a integer;
begin
  if v_proc is null or (d ->> 'n_procedimentos')::integer <> 1 then return; end if;
  with g as (select * from public.agenda_horarios(array[v_proc], current_date, current_date + 28, null, null, null, '[]'::jsonb)),
       o as (select * from public.klingo_oferta where conversa_id = p_conversa and expira_em > now())
  select (select count(*) from o), (select count(*) from g),
         (select count(*) from o where exists (select 1 from g where g.data = o.data and g.hora = o.hora and public.klingo_prof_confere(o.profissional, g.profissional))),
         (select count(*) from g where exists (select 1 from o where g.data = o.data and g.hora = o.hora and public.klingo_prof_confere(o.profissional, g.profissional)))
    into v_api, v_grade, v_a_na_g, v_g_na_a;
  perform public.klingo_medir('sombra_api', v_api); perform public.klingo_medir('sombra_grade', v_grade);
  perform public.klingo_medir('sombra_api_na_grade', v_a_na_g); perform public.klingo_medir('sombra_grade_na_api', v_g_na_a);
exception when others then null;
end $$;

-- Avisa a gestão (admin, TI e gerência), como já faz convenios_revisar.
create or replace function public.klingo_avisar_gestao(p_aviso text, p_detalhe jsonb default '{}'::jsonb) returns void
language sql security definer set search_path to '' as $$
  insert into public.equipe_notificacao (agente_id, tipo, detalhe)
  select distinct x.id, 'klingo_autogestao', jsonb_build_object('aviso', p_aviso) || coalesce(p_detalhe, '{}'::jsonb)
    from (select a.id from public.agentes a where a.ativo and a.papel = 'admin'
          union select m.agente_id from public.org_membro m where m.ativo and m.funcao in ('ti', 'gerente') and m.agente_id is not null) x
$$;

create or replace function public.klingo_decidir(p_chave text, p_para text, p_motivo jsonb, p_avisar text default null) returns void
language plpgsql security definer set search_path to '' as $$
declare v_de text := public.klingo_cfg(p_chave, '');
begin
  insert into public.config (chave, valor) values (p_chave, p_para) on conflict (chave) do update set valor = excluded.valor;
  insert into public.klingo_decisao (chave, de, para, motivo) values (p_chave, v_de, p_para, coalesce(p_motivo, '{}'::jsonb));
  if p_avisar is not null then perform public.klingo_avisar_gestao(p_avisar, jsonb_build_object('chave', p_chave, 'de', v_de, 'para', p_para)); end if;
end $$;

-- A autogestão. Limites escolhidos para errar para o lado seguro; qualquer recuo avisa a gestão.
create or replace function public.klingo_autogestao() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_hor text := public.klingo_cfg('klingo_api_horarios', 'nao'); v_mar text := public.klingo_cfg('klingo_api_marcar', 'teste');
  v_pct integer := coalesce(nullif(public.klingo_cfg('klingo_api_percentual', '100'), '')::integer, 100);
  ok7 bigint := public.klingo_medida_soma('horarios_api_ok', 7); er7 bigint := public.klingo_medida_soma('horarios_api_erro', 7) + public.klingo_medida_soma('horarios_api_limite', 7);
  lento7 bigint := public.klingo_medida_soma('horarios_ms_ge3s', 7); api7 bigint := public.klingo_medida_soma('sombra_api', 7); na7 bigint := public.klingo_medida_soma('sombra_api_na_grade', 7);
  ok1 bigint := public.klingo_medida_soma('horarios_api_ok', 1); er1 bigint := public.klingo_medida_soma('horarios_api_erro', 1) + public.klingo_medida_soma('horarios_api_limite', 1);
  v_dh timestamptz; v_dm timestamptz; v_dp timestamptz; v_rh timestamptz; v_rm timestamptz; suc bigint; inc bigint; tec bigint; suc24 bigint; inc24 bigint; tec24 bigint; suc_p bigint; inc_p bigint; tec_p bigint; acoes text[] := '{}';
  v_tecnica constant text[] := array['plano_inativo', 'plano_desconhecido', 'sem_medico', 'nascimento_divergente', 'cadastro_divergente'];   -- falha de regra de negócio não conta como falha técnica
begin
  if public.klingo_cfg('klingo_autogestao', 'sim') <> 'sim' then return jsonb_build_object('ligada', false); end if;
  select max(em) into v_dh from public.klingo_decisao where chave = 'klingo_api_horarios';
  select max(em) into v_dm from public.klingo_decisao where chave = 'klingo_api_marcar';
  select max(em) into v_dp from public.klingo_decisao where chave = 'klingo_api_percentual';
  -- recuo é segurança: só é segurado por OUTRO recuo recente (evita oscilar), nunca por um avanço
  select max(em) into v_rh from public.klingo_decisao where chave = 'klingo_api_horarios' and para = 'sombra';
  select max(em) into v_rm from public.klingo_decisao where chave = 'klingo_api_marcar' and para = 'teste';

  -- horários
  if v_hor = 'sim' and er1 >= 20 and er1 * 2 >= ok1 + er1 and (v_rh is null or v_rh < now() - interval '30 minutes') then
    perform public.klingo_decidir('klingo_api_horarios', 'sombra', jsonb_build_object('erros_hoje', er1, 'ok_hoje', ok1), 'A agenda em tempo real do Klingo falhou em metade das consultas hoje; o chat voltou a mostrar a grade (previsão). O sistema tenta de novo sozinho.');
    acoes := array_append(acoes, 'horarios:recuou');
  elsif v_hor = 'sombra' and ok7 >= 30 and er7 * 20 <= ok7 + er7 and lento7 * 20 <= ok7 and api7 >= 200 and na7 * 100 >= api7 * 85 and (v_dh is null or v_dh < now() - interval '1 day') then
    perform public.klingo_decidir('klingo_api_horarios', 'sim', jsonb_build_object('ok_7d', ok7, 'erros_7d', er7, 'lentos_7d', lento7, 'api_7d', api7, 'api_na_grade_7d', na7), 'O chat passou a mostrar os horários reais do Klingo (a API respondeu bem por 7 dias e bate com a grade).');
    acoes := array_append(acoes, 'horarios:avancou');
  end if;

  -- marcar sozinho (operações dos últimos 30 dias, 24 h e desde a última decisão)
  select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'),
         count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica)))
    into suc, inc, tec from public.klingo_operacao where tipo = 'marcar' and criado_em > now() - interval '30 days';
  select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'),
         count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica)))
    into suc24, inc24, tec24 from public.klingo_operacao where tipo = 'marcar' and criado_em > now() - interval '24 hours';
  if v_mar = 'sim' and (inc24 >= 2 or (tec24 >= 3 and tec24 * 5 >= suc24 + tec24 + inc24)) and (v_rm is null or v_rm < now() - interval '30 minutes') then
    perform public.klingo_decidir('klingo_api_marcar', 'teste', jsonb_build_object('incertas_24h', inc24, 'falhas_tecnicas_24h', tec24, 'sucessos_24h', suc24), 'A marcação automática foi pausada: houve marcações incertas ou falhas técnicas demais nas últimas 24 h. Só os telefones de teste continuam usando. Confira as operações antes de liberar de novo.');
    acoes := array_append(acoes, 'marcar:recuou');
  elsif v_mar = 'teste' and suc >= 20 and inc = 0 and suc * 100 >= (suc + tec) * 90 and (v_dm is null or v_dm < now() - interval '1 day') then
    perform public.klingo_decidir('klingo_api_percentual', '10', jsonb_build_object('sucessos_30d', suc, 'falhas_tecnicas_30d', tec), null);
    perform public.klingo_decidir('klingo_api_marcar', 'sim', jsonb_build_object('sucessos_30d', suc, 'incertas_30d', inc, 'falhas_tecnicas_30d', tec), 'A marcação automática foi liberada para 10% das conversas (20 marcações de teste sem nenhuma incerta). O sistema aumenta sozinho se continuar bem.');
    acoes := array_append(acoes, 'marcar:avancou_10');
  elsif v_mar = 'sim' and v_pct < 100 and (v_dp is null or v_dp < now() - interval '2 days') then
    select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'), count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica)))
      into suc_p, inc_p, tec_p from public.klingo_operacao where tipo = 'marcar' and criado_em > coalesce(v_dp, now() - interval '30 days');
    if suc_p >= 10 and inc_p = 0 and suc_p * 100 >= (suc_p + tec_p) * 95 then
      perform public.klingo_decidir('klingo_api_percentual', case when v_pct < 50 then '50' else '100' end, jsonb_build_object('sucessos', suc_p, 'falhas_tecnicas', tec_p), 'A marcação automática aumentou para ' || case when v_pct < 50 then '50%' else '100%' end || ' das conversas (taxa de sucesso alta e nenhuma incerta).');
      acoes := array_append(acoes, 'marcar:avancou_pct');
    end if;
  end if;
  return jsonb_build_object('ligada', true, 'acoes', to_jsonb(acoes), 'horarios', v_hor, 'marcar', v_mar, 'percentual', v_pct);
end $$;

-- Rotina de revisão dos pacientes antigos: só chama a Edge Function se houver alguém para conferir.
create or replace function public.klingo_revisao_disparar() returns void
language plpgsql security definer set search_path to '' as $$
declare v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo();
begin
  if v_base = '' or v_seg is null or jsonb_array_length(public.klingo_revisao_pendentes(1)) = 0 then return; end if;
  perform net.http_post(url := v_base || 'klingo-identificar', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('acao', 'revisar', 'limite', 30), timeout_milliseconds := 120000);
exception when others then null;
end $$;

-- Sincronização noturna do catálogo (convênios e especialidades)
create or replace function public.klingo_sincronizar_disparar() returns void
language plpgsql security definer set search_path to '' as $$
declare v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo();
begin
  if v_base = '' or v_seg is null then return; end if;
  perform net.http_post(url := v_base || 'klingo-sincronizar', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('acao', 'catalogo'), timeout_milliseconds := 120000);
exception when others then null;
end $$;

create or replace function public.klingo_limpar() returns void
language sql security definer set search_path to '' as $$
  delete from public.klingo_oferta where expira_em < now() - interval '1 day';
  delete from public.klingo_medida where dia < (now() at time zone 'America/Bahia')::date - 90;
  delete from public.klingo_evento where recebido_em < now() - interval '30 days';
  delete from public.klingo_conversa_ident where em < now() - interval '30 days';
$$;

-- procedimento da oferta: na consulta a API devolve mais de um procedimento da especialidade (ex.: 1096 e 1472); vale qualquer um da mesma especialidade do que o paciente escolheu
create or replace function pg_temp.trocar(t text, velho text, novo text) returns text language plpgsql as $t$
begin
  if position(novo in t) > 0 then return t; end if;   -- já aplicado: a migração pode ser repetida sem estragar
  if (length(t) - length(replace(t, velho, ''))) / greatest(length(velho), 1) <> 1 then raise exception 'trecho nao encontrado exatamente uma vez: %', left(velho, 60); end if;
  return replace(t, velho, novo);
end $t$;
do $do$ declare d text;
begin
  d := pg_get_functiondef('public.klingo_pode_marcar(uuid)'::regprocedure);
  d := pg_temp.trocar(d, $a$  if o.procedimento is distinct from (d ->> 'procedimento')::int then return jsonb_build_object('ok', false, 'motivo', 'oferta_de_outro_procedimento'); end if;$a$,
    $a$  if o.procedimento is distinct from (d ->> 'procedimento')::int
     and not exists (select 1 from public.klingo_especialidade e where (d ->> 'procedimento')::int = any (e.procedimentos) and o.procedimento = any (e.procedimentos)) then
    return jsonb_build_object('ok', false, 'motivo', 'oferta_de_outro_procedimento');
  end if;$a$);
  execute d;
end $do$;

do $do$ declare f text; begin
  for f in select unnest(array['klingo_medida_soma(text, integer)', 'klingo_sombra_medir(uuid)', 'klingo_avisar_gestao(text, jsonb)', 'klingo_decidir(text, text, jsonb, text)', 'klingo_autogestao()',
      'klingo_revisao_disparar()', 'klingo_sincronizar_disparar()', 'klingo_limpar()']) loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $do$;

-- Rotinas (pg_cron, horário UTC: Bahia = UTC-3)
select cron.schedule('klingo-operacao-vigia', '* * * * *', 'select public.klingo_operacao_vigiar()');
select cron.schedule('klingo-autogestao', '*/10 * * * *', 'select public.klingo_autogestao()');
select cron.schedule('klingo-revisar-pacientes', '*/5 * * * *', 'select public.klingo_revisao_disparar()');
select cron.schedule('klingo-sincronizar', '50 6 * * *', 'select public.klingo_sincronizar_disparar()');
select cron.schedule('klingo-limpeza', '27 7 * * *', 'select public.klingo_limpar()');
