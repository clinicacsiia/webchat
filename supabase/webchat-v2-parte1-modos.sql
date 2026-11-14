-- FLUXOGRAMA: entrada (chave de config + conversa) -> validação (valor normalizado: nao | teste | sombra | sim; chave mestra klingo_auto só LIMITA, nunca promove) -> processamento (klingo_modo decide o modo EFETIVO por conversa e por capacidade;
--   klingo_ativo = pode AGIR/EXPOR ao paciente; klingo_sombra = só lê e mede; autogestão só RECUA e RECOMENDA; promoção só por klingo_promover, com admin e justificativa)
--   -> persistência (config_auditoria guarda chave, antes, depois, origem, justificativa e versão de TODA mudança em config; klingo_decisao guarda recuos e recomendações) -> saída (booleano/texto para as funções do chat e as Edge Functions)
-- Versão 2.0 — 14/11/2026 / Mudança: (1) klingo_auto = sim deixava de ser teto e virava promoção: "teste" e "sombra" valiam para TODOS os pacientes; agora o mestre só limita (nao desliga tudo; teste limita à lista de teste; sim/legado não muda nada).
--   (2) "sombra" só lê e mede, nunca expõe nem escreve. (3) Uma chave por capacidade (cancelar, remarcar, resultado, solicitação futura, monitor, notificação). (4) Autogestão só recua; promover = klingo_promover (admin + justificativa).
--   (5) Auditoria de config. (6) klingo_liberado deixa de esconder serviço; klingo_automatizavel diz o que dá para marcar sozinho. (7) klingo_oferta ganha "sombra" e klingo_consulta guarda cada etapa da consulta à API (sem dado pessoal).
--
-- Como voltar atrás (tudo é create or replace ou coluna/tabela nova; nada é apagado):
--   a) reaplicar as definições de supabase/producao/funcoes/{klingo_ativo,klingo_liberado,klingo_decidir,klingo_autogestao,klingo_pode_marcar}.sql (retrato de 14/11/2026, antes desta migração);
--   b) update public.config set valor = 'sim' where chave = 'klingo_so_liberados';  (a chave já valia 'sim' antes);
--   c) as tabelas config_auditoria, klingo_consulta e a coluna klingo_oferta.sombra podem ficar (não são lidas por nada antigo).
-- Efeito esperado na produção (valores de 14/11/2026: klingo_auto=sim, horarios=sombra, marcar/pos/pre_cadastro=teste, so_liberados=sim):
--   marcar/pós/pré-cadastro passam de "todos os pacientes" para "só o telefone da lista de teste"; horários passam de "grava ofertas e filtra o calendário de todos" para "só mede"; todos os serviços voltam ao cardápio.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 1. Trilha de alteração da configuração
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.config_auditoria (
  id bigint generated always as identity primary key,
  em timestamptz not null default now(),
  chave text not null,
  valor_antes text,
  valor_depois text,
  operacao text not null check (operacao in ('insert', 'update', 'delete')),
  origem text not null,
  justificativa text,
  versao text not null default 'webchat-v2.0'
);
create index if not exists config_auditoria_chave_em_idx on public.config_auditoria (chave, em desc);
alter table public.config_auditoria enable row level security;
revoke all on table public.config_auditoria from anon, authenticated;
grant select on table public.config_auditoria to authenticated;
do $p$ begin   -- criação condicional (sem "drop": a ferramenta de migração do Supabase pede confirmação em drop e expira em 60 s)
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'config_auditoria' and policyname = 'config_auditoria_select') then
    create policy config_auditoria_select on public.config_auditoria as permissive for select to authenticated using (((select public.papel_atual()) = 'admin'::text));
  end if;
end $p$;
comment on table public.config_auditoria is 'Toda mudança em public.config: quem (origem), quando, valor antes/depois (segredos e endereços saem como "(oculto)"), justificativa e versão. Só o admin lê.';

create or replace function public.config_auditar() returns trigger
  language plpgsql security definer set search_path to ''
as $function$
declare v_chave text; v_antes text; v_depois text; v_oculto boolean; v_orig text;
begin
  if tg_op = 'DELETE' then v_chave := old.chave; v_antes := old.valor; v_depois := null;
  elsif tg_op = 'INSERT' then v_chave := new.chave; v_antes := null; v_depois := new.valor;
  else
    if new.valor is not distinct from old.valor then return new; end if;
    v_chave := new.chave; v_antes := old.valor; v_depois := new.valor;
  end if;
  v_oculto := v_chave ~* '(segredo|token|senha|url|vapid|chave_|_key)';
  v_orig := coalesce(nullif(current_setting('app.origem', true), ''), case when auth.uid() is not null then 'painel:' || auth.uid()::text else 'sql:' || current_user::text end);
  insert into public.config_auditoria (chave, valor_antes, valor_depois, operacao, origem, justificativa, versao)
  values (v_chave, case when v_oculto and v_antes is not null then '(oculto)' else left(v_antes, 300) end, case when v_oculto and v_depois is not null then '(oculto)' else left(v_depois, 300) end,
          lower(tg_op), left(v_orig, 120), left(nullif(current_setting('app.justificativa', true), ''), 500), coalesce(nullif(current_setting('app.versao', true), ''), 'webchat-v2.0'));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $function$;
revoke all on function public.config_auditar() from public, anon, authenticated;

do $t$ begin
  if not exists (select 1 from pg_trigger where tgname = 'config_auditar_trg' and tgrelid = 'public.config'::regclass) then
    create trigger config_auditar_trg after insert or update or delete on public.config for each row execute function public.config_auditar();
  end if;
end $t$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 2. Modos por capacidade
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Valor normalizado da chave (nao|teste|sombra|sim). Cancelar/remarcar/consultar herdam klingo_api_pos enquanto não têm chave própria (compatibilidade).
create or replace function public.klingo_modo_chave(p_chave text) returns text
  language sql stable security definer set search_path to ''
as $function$
  select case when v in ('nao', 'teste', 'sombra', 'sim') then v else 'nao' end
    from (select lower(btrim(coalesce((select valor from public.config where chave = p_chave),
                                      case when p_chave in ('klingo_api_cancelar', 'klingo_api_remarcar', 'klingo_api_consultar') then (select valor from public.config where chave = 'klingo_api_pos') end,
                                      'nao'))) as v) x
$function$;

-- Capacidades que só LEEM: nelas "sombra" existe. Em qualquer outra, sombra vale "nao" (sombra nunca escreve nem expõe).
create or replace function public.klingo_aceita_sombra(p_chave text) returns boolean
  language sql immutable set search_path to ''
as $function$ select p_chave in ('klingo_api_horarios', 'previsao_monitor_modo', 'klingo_api_resultado') $function$;

-- Modo EFETIVO para uma conversa: nao | sombra | teste | sim.
--   1. mestre "nao" desliga tudo (inclusive sombra);
--   2. sombra (só em capacidade de leitura) não depende da lista nem do percentual, e quem chama NUNCA mostra o resultado ao paciente;
--   3. telefone da lista de teste usa a capacidade em "teste" ou "sim";
--   4. mestre "teste" é TETO: todo o resto fica "nao"; chave "teste" também: só a lista;
--   5. chave "sim" com mestre sim/legado: percentual de conversas.
-- O mestre NUNCA sobe uma chave: "sim" no mestre não transforma teste/sombra em sim.
create or replace function public.klingo_modo(p_conversa uuid, p_chave text) returns text
  language plpgsql stable security definer set search_path to ''
as $function$
declare v_m text := public.klingo_mestre(); v_modo text := public.klingo_modo_chave(p_chave); v_tel text; v_lista boolean := false; v_pct integer;
begin
  if v_m = 'nao' or v_modo = 'nao' then return 'nao'; end if;
  if v_modo = 'sombra' then return case when public.klingo_aceita_sombra(p_chave) then 'sombra' else 'nao' end; end if;
  if p_conversa is null or not exists (select 1 from public.conversas c where c.id = p_conversa) then return 'nao'; end if;   -- conversa que não existe nunca libera nada
  if p_conversa is not null then
    select right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) into v_tel from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
    if v_tel is not null and length(v_tel) = 8 then
      v_lista := exists (select 1 from regexp_split_to_table(public.klingo_cfg('klingo_api_telefones_teste', ''), '[^0-9]+') t where length(t) >= 8 and right(t, 8) = v_tel);
    end if;
  end if;
  if v_lista then return case when v_modo = 'sim' and v_m <> 'teste' then 'sim' else 'teste' end; end if;
  if v_modo = 'teste' or v_m = 'teste' then return 'nao'; end if;
  v_pct := least(100, greatest(0, coalesce(nullif(public.klingo_cfg('klingo_api_percentual', '100'), '')::integer, 100)));
  return case when p_conversa is not null and (abs(hashtext(p_conversa::text)) % 100) < v_pct then 'sim' else 'nao' end;
exception when others then return 'nao';
end $function$;

-- Pode AGIR / EXPOR ao paciente? (a antiga klingo_ativo, agora sem a promoção indevida). "sombra" NÃO conta.
create or replace function public.klingo_ativo(p_conversa uuid, p_chave text) returns boolean
  language sql stable security definer set search_path to ''
as $function$ select public.klingo_modo(p_conversa, p_chave) in ('teste', 'sim') $function$;

-- Só mede? (leitura sem expor e sem escrever)
create or replace function public.klingo_sombra(p_conversa uuid, p_chave text) returns boolean
  language sql stable security definer set search_path to ''
as $function$ select public.klingo_modo(p_conversa, p_chave) = 'sombra' $function$;

revoke all on function public.klingo_modo_chave(text), public.klingo_aceita_sombra(text), public.klingo_modo(uuid, text), public.klingo_ativo(uuid, text), public.klingo_sombra(uuid, text) from public, anon, authenticated;
grant execute on function public.klingo_modo_chave(text), public.klingo_aceita_sombra(text), public.klingo_modo(uuid, text), public.klingo_ativo(uuid, text), public.klingo_sombra(uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3. Promoção só com autorização; autogestão só recua e recomenda
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.klingo_chave_de_modo(p_chave text) returns boolean
  language sql immutable set search_path to ''
as $function$ select p_chave in ('klingo_auto', 'klingo_api_horarios', 'klingo_api_marcar', 'klingo_api_pre_cadastro', 'klingo_api_pos', 'klingo_api_cancelar', 'klingo_api_remarcar', 'klingo_api_consultar',
                                  'klingo_api_resultado', 'klingo_webhook', 'previsao_modo', 'previsao_monitor_modo', 'notificacao_modo', 'pedido_horario_modo') $function$;

create or replace function public.klingo_modo_nivel(p_valor text) returns integer
  language sql immutable set search_path to ''
as $function$ select case lower(coalesce(p_valor, '')) when 'sombra' then 1 when 'teste' then 2 when 'ligado' then 3 when 'sim' then 3 when 'legado' then 3 else 0 end $function$;

-- Usada pela autogestão e por qualquer rotina: grava a mudança e a decisão. RECUAR pode; SUBIR é recusado (só klingo_promover sobe).
create or replace function public.klingo_decidir(p_chave text, p_para text, p_motivo jsonb, p_avisar text default null) returns void
  language plpgsql security definer set search_path to ''
as $function$
declare v_de text := public.klingo_cfg(p_chave, '');
begin
  if public.klingo_chave_de_modo(p_chave) and public.klingo_modo_nivel(p_para) > public.klingo_modo_nivel(v_de)
     and coalesce(current_setting('app.promocao_autorizada', true), '') <> p_chave then
    raise exception 'Promover % de % para % exige autorização explícita (klingo_promover).', p_chave, v_de, p_para using errcode = '42501';
  end if;
  perform set_config('app.origem', coalesce(nullif(current_setting('app.origem', true), ''), 'autogestao'), true);
  perform set_config('app.justificativa', left(coalesce(p_avisar, p_motivo::text), 500), true);
  insert into public.config (chave, valor) values (p_chave, p_para) on conflict (chave) do update set valor = excluded.valor;
  insert into public.klingo_decisao (chave, de, para, motivo) values (p_chave, v_de, p_para, coalesce(p_motivo, '{}'::jsonb));
  if p_avisar is not null then perform public.klingo_avisar_gestao(p_avisar, jsonb_build_object('chave', p_chave, 'de', v_de, 'para', p_para)); end if;
end $function$;

-- A única porta para SUBIR um modo (teste -> sim, sombra -> sim, nao -> teste ...). Só admin logado, com justificativa; fica na auditoria e em klingo_decisao.
create or replace function public.klingo_promover(p_chave text, p_para text, p_justificativa text) returns jsonb
  language plpgsql security definer set search_path to ''
as $function$
declare v_de text := public.klingo_cfg(p_chave, ''); v_uid uuid := auth.uid();
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' or v_uid is null then raise exception 'Somente o administrador autoriza esta mudança.' using errcode = '42501'; end if;
  if not public.klingo_chave_de_modo(p_chave) then raise exception 'Chave não é um interruptor de modo.' using errcode = '22023'; end if;
  if p_para not in ('nao', 'teste', 'sombra', 'sim', 'ligado', 'legado') then raise exception 'Valor inválido.' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_justificativa, ''))) < 10 then raise exception 'Escreva a justificativa (mínimo 10 letras).' using errcode = '22023'; end if;
  perform set_config('app.promocao_autorizada', p_chave, true);
  perform set_config('app.origem', 'promocao:' || v_uid::text, true);
  perform set_config('app.justificativa', left(btrim(p_justificativa), 500), true);
  insert into public.config (chave, valor) values (p_chave, p_para) on conflict (chave) do update set valor = excluded.valor;
  insert into public.klingo_decisao (chave, de, para, motivo) values (p_chave, v_de, p_para, jsonb_build_object('autorizado_por', v_uid, 'justificativa', left(btrim(p_justificativa), 500)));
  return jsonb_build_object('ok', true, 'chave', p_chave, 'de', v_de, 'para', p_para);
end $function$;
revoke all on function public.klingo_chave_de_modo(text), public.klingo_modo_nivel(text), public.klingo_decidir(text, text, jsonb, text), public.klingo_promover(text, text, text) from public, anon, authenticated;
grant execute on function public.klingo_chave_de_modo(text), public.klingo_modo_nivel(text), public.klingo_decidir(text, text, jsonb, text) to service_role;
grant execute on function public.klingo_promover(text, text, text) to authenticated, service_role;

-- Recomendação: fica em klingo_decisao com chave "recomendacao:<chave>" (não muda nenhuma configuração). No máximo uma por chave a cada 7 dias.
create or replace function public.klingo_recomendar(p_chave text, p_para text, p_motivo jsonb, p_aviso text) returns boolean
  language plpgsql security definer set search_path to ''
as $function$
declare v_de text := public.klingo_cfg(p_chave, '');
begin
  if public.klingo_modo_nivel(p_para) <= public.klingo_modo_nivel(v_de) then return false; end if;
  if exists (select 1 from public.klingo_decisao where chave = 'recomendacao:' || p_chave and em > now() - interval '7 days') then return false; end if;
  insert into public.klingo_decisao (chave, de, para, motivo) values ('recomendacao:' || p_chave, v_de, p_para, coalesce(p_motivo, '{}'::jsonb));
  perform public.klingo_avisar_gestao(p_aviso, jsonb_build_object('chave', p_chave, 'de', v_de, 'recomendado', p_para, 'recomendacao', true));
  return true;
end $function$;
revoke all on function public.klingo_recomendar(text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.klingo_recomendar(text, text, jsonb, text) to service_role;

-- Autogestão (a cada 10 min): RECUA quando há risco e RECOMENDA quando as medidas estão boas. Nunca avança chave nenhuma.
create or replace function public.klingo_autogestao() returns jsonb
  language plpgsql security definer set search_path to ''
as $function$
declare
  v_m text := public.klingo_mestre(); v_hor text := public.klingo_modo_chave('klingo_api_horarios'); v_mar text := public.klingo_modo_chave('klingo_api_marcar');
  v_com7 bigint := public.klingo_medida_soma('horarios_api_com_horarios', 7); v_er7 bigint := public.klingo_medida_soma('horarios_api_erro', 7) + public.klingo_medida_soma('horarios_api_limite', 7);
  v_len7 bigint := public.klingo_medida_soma('horarios_ms_ge3s', 7); v_api7 bigint := public.klingo_medida_soma('sombra_api', 7); v_na7 bigint := public.klingo_medida_soma('sombra_api_na_grade', 7);
  v_ok1 bigint := public.klingo_medida_soma('horarios_api_ok', 1); v_er1 bigint := public.klingo_medida_soma('horarios_api_erro', 1) + public.klingo_medida_soma('horarios_api_limite', 1);
  v_rh timestamptz; v_rm timestamptz; v_rmest timestamptz; suc bigint; inc bigint; tec bigint; suc24 bigint; inc24 bigint; tec24 bigint; acoes text[] := '{}';
  v_tecnica constant text[] := array['plano_inativo', 'plano_desconhecido', 'sem_medico', 'nascimento_divergente', 'cadastro_divergente'];
begin
  if public.klingo_cfg('klingo_autogestao', 'sim') <> 'sim' then return jsonb_build_object('ligada', false); end if;
  if v_m = 'nao' then return jsonb_build_object('ligada', true, 'acoes', '[]'::jsonb, 'mestre', v_m); end if;
  select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'),
         count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica) or coalesce(codigo, '') like 'divergencia%'))
    into suc, inc, tec from public.klingo_operacao where tipo = 'marcar' and criado_em > now() - interval '30 days';
  select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'),
         count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica) or coalesce(codigo, '') like 'divergencia%'))
    into suc24, inc24, tec24 from public.klingo_operacao where tipo = 'marcar' and criado_em > now() - interval '24 hours';
  select max(em) into v_rmest from public.klingo_decisao where chave = 'klingo_auto' and para = 'teste';
  select max(em) into v_rh from public.klingo_decisao where chave = 'klingo_api_horarios' and para = 'sombra';
  select max(em) into v_rm from public.klingo_decisao where chave = 'klingo_api_marcar' and para = 'teste';

  -- RECUOS (suspender por risco é permitido; o paciente continua pelo atendimento de sempre)
  if v_m in ('sim', 'legado') and (inc24 >= 2 or (tec24 >= 3 and tec24 * 5 >= suc24 + tec24 + inc24) or (v_er1 >= 20 and v_er1 * 2 >= v_ok1 + v_er1)) and (v_rmest is null or v_rmest < now() - interval '30 minutes') then
    perform public.klingo_decidir('klingo_auto', 'teste', jsonb_build_object('incertas_24h', inc24, 'falhas_tecnicas_24h', tec24, 'sucessos_24h', suc24, 'erros_horarios_hoje', v_er1),
      'O autoatendimento do Klingo voltou para "só telefones de teste": houve marcações incertas, falhas técnicas ou a agenda do Klingo falhou demais. Confira as operações antes de liberar de novo.');
    acoes := array_append(acoes, 'mestre:recuou');
  end if;
  if v_hor = 'sim' and v_er1 >= 20 and v_er1 * 2 >= v_ok1 + v_er1 and (v_rh is null or v_rh < now() - interval '30 minutes') then
    perform public.klingo_decidir('klingo_api_horarios', 'sombra', jsonb_build_object('erros_hoje', v_er1, 'ok_hoje', v_ok1), 'A agenda em tempo real do Klingo falhou em metade das consultas hoje; o chat parou de mostrar horários da API (pedido vai à equipe).');
    acoes := array_append(acoes, 'horarios:recuou');
  end if;
  if v_mar = 'sim' and (inc24 >= 2 or (tec24 >= 3 and tec24 * 5 >= suc24 + tec24 + inc24)) and (v_rm is null or v_rm < now() - interval '30 minutes') then
    perform public.klingo_decidir('klingo_api_marcar', 'teste', jsonb_build_object('incertas_24h', inc24, 'falhas_tecnicas_24h', tec24, 'sucessos_24h', suc24), 'A marcação automática foi pausada (marcações incertas ou falhas técnicas demais nas últimas 24 h). Só os telefones de teste continuam. Confira as operações antes de liberar de novo.');
    acoes := array_append(acoes, 'marcar:recuou');
  end if;

  -- RECOMENDAÇÕES (quem decide é o administrador, por klingo_promover; aqui nenhuma chave muda)
  if v_hor = 'sombra' and v_com7 >= 30 and v_er7 * 20 <= v_com7 + v_er7 and v_len7 * 20 <= v_com7 and v_api7 >= 200 and v_na7 * 100 >= v_api7 * 85 then
    if public.klingo_recomendar('klingo_api_horarios', 'sim', jsonb_build_object('com_horarios_7d', v_com7, 'erros_7d', v_er7, 'lentos_7d', v_len7, 'api_7d', v_api7, 'api_na_grade_7d', v_na7),
         'Recomendação (nada foi alterado): a API de horários respondeu bem por 7 dias. Se concordar, o administrador pode liberar "horários" para os pacientes.') then
      acoes := array_append(acoes, 'horarios:recomendado');
    end if;
  end if;
  if v_mar = 'teste' and suc >= 20 and inc = 0 and suc * 100 >= (suc + tec) * 90 then
    if public.klingo_recomendar('klingo_api_marcar', 'sim', jsonb_build_object('sucessos_30d', suc, 'incertas_30d', inc, 'falhas_tecnicas_30d', tec),
         'Recomendação (nada foi alterado): 20 marcações de teste sem nenhuma incerta. É o mínimo do piloto, não prova de segurança; o administrador decide se libera para uma parte dos pacientes.') then
      acoes := array_append(acoes, 'marcar:recomendado');
    end if;
  end if;
  return jsonb_build_object('ligada', true, 'acoes', to_jsonb(acoes), 'mestre', v_m, 'horarios', v_hor, 'marcar', v_mar, 'percentual', public.klingo_cfg('klingo_api_percentual', '100'));
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 4. Catálogo: a clínica oferece tudo; a API só decide o CAMINHO (marcar sozinho x equipe x solicitação futura)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Visibilidade: nenhum serviço some do chat por falta de integração (klingo_so_liberados deixa de ter efeito; a função continua existindo porque chat_consultas/chat_exames a chamam).
create or replace function public.klingo_liberado(p_conversa uuid, p_proc integer, p_tipo text) returns boolean
  language sql stable security definer set search_path to ''
as $function$ select true $function$;

-- Elegibilidade de automação: o que a API do Klingo reconhece para consultar horários (não decide se o catálogo mostra o serviço).
create or replace function public.klingo_automatizavel(p_proc integer, p_tipo text) returns boolean
  language sql stable security definer set search_path to ''
as $function$
  select case when p_tipo = 'consulta' then exists (select 1 from public.klingo_especialidade e where e.liberada_api and p_proc = any (e.procedimentos))
              when p_tipo = 'exame' then p_proc is not null
              else false end
$function$;
revoke all on function public.klingo_liberado(uuid, integer, text), public.klingo_automatizavel(integer, text) from public, anon, authenticated;
grant execute on function public.klingo_liberado(uuid, integer, text), public.klingo_automatizavel(integer, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 5. Ofertas: marca de sombra e o registro de cada consulta à API
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.klingo_oferta add column if not exists sombra boolean not null default false;
comment on column public.klingo_oferta.sombra is 'true = veio de uma consulta em modo sombra (só para medir). Nunca aparece no calendário do paciente nem serve de base para marcar.';

create table if not exists public.klingo_consulta (
  id bigint generated always as identity primary key,
  em timestamptz not null default now(),
  conversa_id uuid,
  modo text not null,
  tipo text,
  procedimento integer,
  plano integer,
  resultado text not null check (resultado in ('ok_com_horarios', 'api_sem_horarios', 'todos_filtrados', 'estrutura_invalida', 'erro_api', 'limite', 'erro_gravacao', 'sem_traducao_plano', 'fora_do_escopo', 'dados_incompletos', 'sem_pedido', 'desligado')),
  http_status integer,
  n_recebidos integer,
  n_validos integer,
  n_filtrados integer,
  n_gravados integer,
  ms integer,
  detalhe text
);
create index if not exists klingo_consulta_em_idx on public.klingo_consulta (em desc);
alter table public.klingo_consulta enable row level security;
revoke all on table public.klingo_consulta from anon, authenticated;
comment on table public.klingo_consulta is 'Uma linha por consulta de horários à API do Klingo, com o resultado de cada etapa. Sem CPF, nome, nascimento ou telefone. Apagada após 30 dias.';

create or replace function public.klingo_consulta_registrar(p_conversa uuid, p_modo text, p_tipo text, p_procedimento integer, p_plano integer, p_resultado text,
    p_http integer default null, p_recebidos integer default null, p_validos integer default null, p_filtrados integer default null, p_gravados integer default null, p_ms integer default null, p_detalhe text default null) returns void
  language plpgsql security definer set search_path to ''
as $function$
begin
  insert into public.klingo_consulta (conversa_id, modo, tipo, procedimento, plano, resultado, http_status, n_recebidos, n_validos, n_filtrados, n_gravados, ms, detalhe)
  values (p_conversa, left(p_modo, 12), left(p_tipo, 12), p_procedimento, p_plano, p_resultado, p_http, p_recebidos, p_validos, p_filtrados, p_gravados, p_ms, left(p_detalhe, 200));
  perform public.klingo_medir(case when p_modo = 'monitor' then 'monitor_' else 'consulta_' end || p_resultado);
  if p_modo = 'monitor' then return; end if;   -- as consultas do motor de vagas não entram nas métricas da tela (nem no que a autogestão recomenda)
  -- "ok" só quando a API respondeu e a estrutura era válida; "com_horarios" só quando sobrou pelo menos um horário gravável.
  if p_resultado in ('ok_com_horarios', 'api_sem_horarios', 'todos_filtrados') then perform public.klingo_medir('horarios_api_ok', 1, p_ms); end if;
  if p_resultado = 'ok_com_horarios' then perform public.klingo_medir('horarios_api_com_horarios'); end if;
  if p_resultado = 'api_sem_horarios' then perform public.klingo_medir('horarios_api_sem_horarios'); end if;
  if p_resultado = 'estrutura_invalida' then perform public.klingo_medir('horarios_api_estrutura_invalida'); end if;
  if p_resultado = 'todos_filtrados' then perform public.klingo_medir('horarios_api_filtrados'); end if;
  if p_resultado = 'erro_api' then perform public.klingo_medir('horarios_api_erro'); end if;
  if p_resultado = 'limite' then perform public.klingo_medir('horarios_api_limite'); end if;
  if p_resultado = 'erro_gravacao' then perform public.klingo_medir('horarios_api_erro_gravacao'); end if;
  if p_resultado = 'ok_com_horarios' and p_ms is not null then
    perform public.klingo_medir(case when p_ms < 1000 then 'horarios_ms_lt1s' when p_ms < 3000 then 'horarios_ms_lt3s' else 'horarios_ms_ge3s' end);
  end if;
end $function$;

-- Grava as ofertas de uma consulta. Só apaga as ofertas do MESMO tipo (reais x sombra) da conversa, e só quando p_substituir (a 2ª janela de datas soma, não substitui).
create or replace function public.klingo_oferta_gravar_v2(p_conversa uuid, p_procedimento integer, p_plano integer, p_ofertas jsonb, p_sombra boolean default false, p_substituir boolean default true) returns integer
  language plpgsql security definer set search_path to ''
as $function$
declare v_n integer;
begin
  if coalesce(p_substituir, true) then delete from public.klingo_oferta where conversa_id = p_conversa and sombra = coalesce(p_sombra, false); end if;
  insert into public.klingo_oferta (conversa_id, chave, procedimento, plano, data, hora, profissional, profissional_id, unidade, unidade_id, ordem_chegada, expira_em, sombra)
  select p_conversa, left(o ->> 'chave', 120), p_procedimento, p_plano, (o ->> 'data')::date, left(o ->> 'hora', 5), left(o ->> 'profissional', 120), left(o ->> 'profissional_id', 20),
         left(o ->> 'unidade', 120), left(o ->> 'unidade_id', 20), coalesce((o ->> 'ordem_chegada')::boolean, false), now() + interval '30 minutes', coalesce(p_sombra, false)
    from jsonb_array_elements(case when jsonb_typeof(p_ofertas) = 'array' then p_ofertas else '[]'::jsonb end) o
   where (o ->> 'data') ~ '^\d{4}-\d{2}-\d{2}$' and (o ->> 'hora') ~ '^\d{2}:\d{2}' and nullif(o ->> 'chave', '') is not null
  on conflict (conversa_id, chave) do update set sombra = excluded.sombra, expira_em = excluded.expira_em;
  get diagnostics v_n = row_count;
  return v_n;
end $function$;
revoke all on function public.klingo_consulta_registrar(uuid, text, text, integer, integer, text, integer, integer, integer, integer, integer, integer, text),
                       public.klingo_oferta_gravar_v2(uuid, integer, integer, jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function public.klingo_consulta_registrar(uuid, text, text, integer, integer, text, integer, integer, integer, integer, integer, integer, text),
                          public.klingo_oferta_gravar_v2(uuid, integer, integer, jsonb, boolean, boolean) to service_role;

-- Limpeza: acrescenta a retenção de 30 dias de klingo_consulta e da auditoria de config (1 ano) à rotina existente.
create or replace function public.klingo_limpar() returns void
  language sql security definer set search_path to ''
as $function$
  delete from public.klingo_oferta where expira_em < now() - interval '1 day';
  delete from public.klingo_medida where dia < (now() at time zone 'America/Bahia')::date - 90;
  delete from public.klingo_evento where recebido_em < now() - interval '30 days';
  delete from public.klingo_conversa_ident where em < now() - interval '30 days';
  delete from public.klingo_consulta where em < now() - interval '30 days';
  delete from public.config_auditoria where em < now() - interval '1 year';
$function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 6. klingo_pode_marcar: oferta de sombra nunca serve de base; remarcar passa a ter chave própria (herda klingo_api_pos enquanto não for definida)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
do $m$
declare d text := pg_get_functiondef('public.klingo_pode_marcar(uuid)'::regprocedure); n integer;
begin
  n := (length(d) - length(replace(d, 'and expira_em > now() - interval ''20 minutes'';', ''))) / length('and expira_em > now() - interval ''20 minutes'';');
  if n <> 1 then raise exception 'klingo_pode_marcar: trecho da oferta nao encontrado exatamente uma vez (%)', n; end if;
  d := replace(d, 'and expira_em > now() - interval ''20 minutes'';', 'and not sombra and expira_em > now() - interval ''20 minutes'';');
  n := (length(d) - length(replace(d, 'not public.klingo_ativo(p_conversa, ''klingo_api_pos'')', ''))) / length('not public.klingo_ativo(p_conversa, ''klingo_api_pos'')');
  if n <> 1 then raise exception 'klingo_pode_marcar: trecho de remarcar nao encontrado exatamente uma vez (%)', n; end if;
  d := replace(d, 'not public.klingo_ativo(p_conversa, ''klingo_api_pos'')', 'not public.klingo_ativo(p_conversa, ''klingo_api_remarcar'')');
  execute d;
end $m$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 7. Migração das chaves antigas (compatível e auditada)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
select set_config('app.origem', 'migracao:webchat-v2.0', false), set_config('app.justificativa', 'Migração v2.0: modos por capacidade; o mestre klingo_auto não promove mais; nada vira "sim" por esta migração.', false);
insert into public.config (chave, valor)
select k, v from (values
  ('klingo_api_cancelar',   coalesce((select valor from public.config where chave = 'klingo_api_pos' and valor in ('nao', 'teste')), 'nao')),
  ('klingo_api_remarcar',   coalesce((select valor from public.config where chave = 'klingo_api_pos' and valor in ('nao', 'teste')), 'nao')),
  ('klingo_api_consultar',  coalesce((select valor from public.config where chave = 'klingo_api_pos' and valor in ('nao', 'teste')), 'nao')),
  ('klingo_api_resultado',  'nao'),
  ('previsao_modo',         'teste'),
  ('previsao_monitor_modo', 'nao'),
  ('notificacao_modo',      'nao')) t(k, v)
on conflict (chave) do nothing;
update public.config set valor = 'nao' where chave = 'klingo_so_liberados' and valor <> 'nao';   -- sem efeito desde a parte 4; deixa de enganar quem lê a configuração
select set_config('app.origem', '', false), set_config('app.justificativa', '', false);
