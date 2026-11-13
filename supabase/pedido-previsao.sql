-- FLUXOGRAMA: entrada (o paciente toca em "Nenhum horário serve para mim" no calendário, ou recusa as duas ofertas de horário do assistente; só para quem estiver no modo de teste/ligado de config.pedido_horario_modo)
--   -> validação (previsao_ativa: modo 'ligado' = todos; 'teste' = só os celulares de klingo_api_telefones_teste; qualquer outro valor = fluxo antigo)
--   -> lógica (o assistente pergunta o TURNO (manhã/tarde/tanto faz) e PARA QUANDO (15 dias, este mês, mês que vem, 2 a 3 meses, mais adiante); procura horário livre nesse filtro e oferece até 2 (botões Sim/Não);
--      sem horário ou recusado: pergunta se o paciente quer ficar na LISTA DE PREVISÃO (texto claro: NÃO confirma o dia do atendimento; se surgir vaga a equipe chama para combinar dia e hora) ou escolher outra data no calendário;
--      quem fica na lista diz com que ANTECEDÊNCIA pode ser chamado (até 24 h / 1 dia / 1 semana / 1 mês), o que serve para classificar quem confirma e quem entra quando alguém faltar)
--   -> saída (tabela pedido_previsao + nota para a equipe + o pedido segue para a equipe como "pronto" SEM horário; a rotina previsao_vigiar, a cada 10 min, procura vaga dentro da previsão e põe uma faixa de aviso na conversa para a ATENDENTE oferecer; nada é marcado sozinho)
-- Versão 1.0 — 13/11/2026 / Mudança: pedido do dono (13/11/2026): paciente diz turno e período em vez de só ver datas; lista de previsão; antecedência; aviso à atendente quando abre vaga.
-- Pré-requisito: pedido-sem-horario.sql (passo horario_oferta).
-- LIGAR PARA TODOS: update public.config set valor = 'ligado' where chave = 'pedido_horario_modo';   DESLIGAR: 'desligado' (volta ao calendário de sempre) e select cron.unschedule('previsao-vigia');
-- ROLLBACK: refazer fluxo_proximo, fluxo_perguntar e fluxo_aplicar a partir do commit anterior (supabase/producao/funcoes/); drop table public.pedido_previsao; drop das funções previsao_* e pedido_slot_texto.

-- ===== PARTE 1: tabela e chaves =====
create table if not exists public.pedido_previsao (
  conversa_id uuid primary key references public.conversas (id) on delete cascade,
  turno text not null check (turno in ('manha', 'tarde', 'qualquer')),
  de date not null,
  ate date not null,
  antecedencia text not null check (antecedencia in ('imediato', '1_dia', '1_semana', '1_mes')),
  status text not null default 'aguardando' check (status in ('aguardando', 'vaga_encontrada', 'atendida', 'cancelada')),
  vaga jsonb,
  vaga_em timestamptz,
  criada_em timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);
comment on table public.pedido_previsao is 'Lista de previsão: paciente sem data disponível que aceitou esperar uma vaga (NÃO é agendamento). Só funções do sistema leem e gravam.';
alter table public.pedido_previsao enable row level security;
revoke all on table public.pedido_previsao from anon, authenticated;

insert into public.config (chave, valor) values
  ('previsao_oferta_texto', 'Encontrei um horário dentro do que você pediu: {oferta}. Esse horário serve para você?'),
  ('previsao_decide_texto', 'Não temos horário disponível dentro do que você pediu. Você pode ficar na LISTA DE PREVISÃO. Atenção: isso NÃO confirma o dia do atendimento. É só uma previsão: se surgir vaga, nossa equipe entra em contato com você para combinar o dia e a hora.'),
  ('previsao_final_texto', 'Anotado! Você ficou na lista de previsão. Lembrando: isso NÃO confirma o dia do atendimento. Se surgir uma vaga dentro do que você pediu, nossa equipe entra em contato para agendar o dia e a hora.')
on conflict (chave) do nothing;

-- ===== PARTE 2: funções de apoio =====
create or replace function public.pedido_slot_texto(p_slot jsonb) returns text
language sql stable set search_path to '' as $$
  select (array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'])[extract(dow from (p_slot ->> 'data')::date)::int + 1]
         || ', ' || to_char((p_slot ->> 'data')::date, 'DD/MM') || ' às ' || left(p_slot ->> 'hora', 5)
         || coalesce(' na unidade ' || initcap(lower(nullif(p_slot ->> 'unidade', ''))), '')
$$;
revoke all on function public.pedido_slot_texto(jsonb) from public, anon, authenticated;
grant execute on function public.pedido_slot_texto(jsonb) to service_role;

create or replace function public.previsao_ativa(p_conversa uuid) returns boolean
language plpgsql stable security definer set search_path to '' as $$
declare v_modo text := coalesce((select valor from public.config where chave = 'pedido_horario_modo'), 'desligado'); v_fone text;
begin
  if v_modo = 'ligado' then return true; end if;
  if v_modo <> 'teste' then return false; end if;
  select right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) into v_fone from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
  return coalesce(length(v_fone) = 8 and exists (select 1 from regexp_split_to_table(coalesce((select valor from public.config where chave = 'klingo_api_telefones_teste'), ''), '[^0-9]+') t where length(t) >= 8 and right(t, 8) = v_fone), false);
end $$;
revoke all on function public.previsao_ativa(uuid) from public, anon, authenticated;
grant execute on function public.previsao_ativa(uuid) to service_role;

-- até 2 horários livres no filtro do paciente (o 2º prefere outro dia)
create or replace function public.previsao_buscar(p_conversa uuid, p_turno text, p_de date, p_ate date, p_antec_min integer) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_procs int[] := public.fluxo_procs(p_conversa); v_todos jsonb; v_s1 jsonb; v_s2 jsonb;
begin
  if v_procs is null or jsonb_array_length(public.agenda_grupos(v_procs)) <> 1 then return '[]'::jsonb; end if;
  perform set_config('app.conversa', p_conversa::text, true);
  select coalesce(jsonb_agg(to_jsonb(x) - 'ord' order by x.ord), '[]'::jsonb) into v_todos from (
    select h.data, h.hora, h.unidade, h.local, h.profissional, h.duracao_min as min, h.chegada, row_number() over (order by h.data, h.hora) as ord
      from public.agenda_horarios(v_procs, p_de, p_ate, null, null, case when p_turno = 'qualquer' then null else p_turno end, '[]'::jsonb, p_antec_min) h limit 60) x;
  v_s1 := v_todos -> 0;
  if v_s1 is null then return '[]'::jsonb; end if;
  select s into v_s2 from jsonb_array_elements(v_todos) with ordinality t(s, ord) where ord > 1 order by (s ->> 'data' = v_s1 ->> 'data'), ord limit 1;
  return case when v_s2 is null then jsonb_build_array(v_s1) else jsonb_build_array(v_s1, v_s2) end;
end $$;
revoke all on function public.previsao_buscar(uuid, text, date, date, integer) from public, anon, authenticated;
grant execute on function public.previsao_buscar(uuid, text, date, date, integer) to service_role;

create or replace function public.previsao_antec_min(p_antecedencia text) returns integer
language sql immutable set search_path to '' as $$
  select case p_antecedencia when '1_dia' then 1440 when '1_semana' then 10080 when '1_mes' then 43200 else 120 end
$$;
revoke all on function public.previsao_antec_min(text) from public, anon, authenticated;
grant execute on function public.previsao_antec_min(text) to service_role;

-- começa (ou volta a) o filtro: p_decidir = true quando as ofertas da previsão já foram recusadas (vai direto à pergunta da lista)
create or replace function public.previsao_iniciar(p_conversa uuid, p_decidir boolean default false, p_aviso text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_prev jsonb;
begin
  select dados -> 'previsao' into v_prev from public.conversa_fluxo where conversa_id = p_conversa;
  perform public.fluxo_set(p_conversa, jsonb_build_object('oferta_pendente', null, 'sem_horario', false, 'confirmado', false,
    'previsao', case when p_decidir and jsonb_typeof(v_prev) = 'object' then v_prev || jsonb_build_object('etapa', 'decide') else jsonb_build_object('etapa', 'turno') end));
  update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null, etapa = 'data_hora' where conversa_id = p_conversa;
  perform public.fluxo_nota(p_conversa, case when p_decidir then 'Paciente recusou os horários oferecidos dentro do filtro dele: perguntou-se se quer ficar na lista de previsão.' else 'Nenhum horário serviu ao paciente: o assistente pergunta turno e período para procurar.' end);
  return jsonb_build_object('ok', true, 'aviso', p_aviso);
end $$;
revoke all on function public.previsao_iniciar(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.previsao_iniciar(uuid, boolean, text) to service_role;

-- a pergunta de cada passo (texto + botões)
create or replace function public.previsao_pergunta(p_conversa uuid, p_passo text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_txt text; v_itens jsonb;
begin
  case p_passo
  when 'previsao_turno' then
    v_txt := 'Vamos encontrar o melhor horário para você. Qual turno você prefere?';
    v_itens := jsonb_build_array(jsonb_build_object('valor', 'manha', 'rotulo', 'Manhã'), jsonb_build_object('valor', 'tarde', 'rotulo', 'Tarde'), jsonb_build_object('valor', 'qualquer', 'rotulo', 'Tanto faz'));
  when 'previsao_periodo' then
    v_txt := 'Para quando você quer o atendimento?';
    v_itens := jsonb_build_array(jsonb_build_object('valor', 'quinze', 'rotulo', 'Nos próximos 15 dias'), jsonb_build_object('valor', 'mes', 'rotulo', 'Ainda neste mês'),
      jsonb_build_object('valor', 'proximo_mes', 'rotulo', 'No mês que vem'), jsonb_build_object('valor', 'tres_meses', 'rotulo', 'Daqui a 2 ou 3 meses'), jsonb_build_object('valor', 'depois', 'rotulo', 'Mais para frente'));
  when 'previsao_decide' then
    v_txt := coalesce((select valor from public.config where chave = 'previsao_decide_texto'), '');
    v_itens := jsonb_build_array(jsonb_build_object('valor', 'lista', 'rotulo', 'Quero ficar na lista de previsão'), jsonb_build_object('valor', 'calendario', 'rotulo', 'Prefiro escolher outra data no calendário'));
  when 'previsao_antecedencia' then
    v_txt := 'Se surgir uma vaga, com quanto tempo de antecedência você consegue ser chamado?';
    v_itens := jsonb_build_array(jsonb_build_object('valor', 'imediato', 'rotulo', 'Posso ir em até 24 horas'), jsonb_build_object('valor', '1_dia', 'rotulo', 'Preciso de 1 dia de antecedência'),
      jsonb_build_object('valor', '1_semana', 'rotulo', 'Preciso de 1 semana de antecedência'), jsonb_build_object('valor', '1_mes', 'rotulo', 'Preciso de 1 mês de antecedência'));
  else v_txt := 'Como podemos continuar?'; v_itens := '[]'::jsonb;
  end case;
  return jsonb_build_object('texto', v_txt, 'opcoes', public.fluxo_escolha(p_passo, v_itens));
end $$;
revoke all on function public.previsao_pergunta(uuid, text) from public, anon, authenticated;
grant execute on function public.previsao_pergunta(uuid, text) to service_role;

-- a resposta de cada passo
create or replace function public.previsao_responder(p_conversa uuid, p_passo text, p_valor text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_prev jsonb; v_hoje date := (now() at time zone 'America/Bahia')::date; v_de date; v_ate date; v_slots jsonb; v_s1 jsonb; v_fim_mes date;
begin
  select coalesce(dados -> 'previsao', '{}'::jsonb) into v_prev from public.conversa_fluxo where conversa_id = p_conversa;
  if jsonb_typeof(v_prev) <> 'object' then v_prev := '{}'::jsonb; end if;
  v_fim_mes := (date_trunc('month', v_hoje) + interval '1 month - 1 day')::date;

  if p_passo = 'previsao_turno' then
    if p_valor not in ('manha', 'tarde', 'qualquer') then return '{"ok": false}'::jsonb; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('previsao', v_prev || jsonb_build_object('turno', p_valor, 'etapa', 'periodo')));
    return '{"ok": true}'::jsonb;

  elsif p_passo = 'previsao_periodo' then
    if p_valor not in ('quinze', 'mes', 'proximo_mes', 'tres_meses', 'depois') then return '{"ok": false}'::jsonb; end if;
    select case p_valor when 'quinze' then v_hoje when 'mes' then v_hoje when 'proximo_mes' then (v_fim_mes + 1) when 'tres_meses' then v_hoje + 45 else v_hoje + 90 end,
           case p_valor when 'quinze' then v_hoje + 15 when 'mes' then v_fim_mes when 'proximo_mes' then (date_trunc('month', v_fim_mes + 1) + interval '1 month - 1 day')::date when 'tres_meses' then v_hoje + 105 else v_hoje + 365 end
      into v_de, v_ate;
    v_prev := v_prev || jsonb_build_object('de', v_de, 'ate', v_ate, 'etapa', 'decide');
    v_slots := public.previsao_buscar(p_conversa, coalesce(v_prev ->> 'turno', 'qualquer'), v_de, v_ate, 120);
    v_s1 := v_slots -> 0;
    if v_s1 is not null then
      perform public.fluxo_set(p_conversa, jsonb_build_object('previsao', v_prev, 'oferta_pendente', jsonb_build_object('n', 1, 'origem', 'previsao', 'original', 'sua preferência', 'slots', v_slots,
        'texto', replace(coalesce((select valor from public.config where chave = 'previsao_oferta_texto'), ''), '{oferta}', public.pedido_slot_texto(v_s1)))));
    else
      perform public.fluxo_set(p_conversa, jsonb_build_object('previsao', v_prev));
    end if;
    return '{"ok": true}'::jsonb;

  elsif p_passo = 'previsao_decide' then
    if p_valor = 'lista' then
      perform public.fluxo_set(p_conversa, jsonb_build_object('previsao', v_prev || jsonb_build_object('etapa', 'antecedencia')));
      return '{"ok": true}'::jsonb;
    elsif p_valor = 'calendario' then
      perform public.fluxo_set(p_conversa, jsonb_build_object('previsao', null, 'oferta_pendente', null, 'sem_horario', false, 'confirmado', false));
      return jsonb_build_object('ok', true, 'aviso', coalesce((select valor from public.config where chave = 'pedido_escolha_texto'), ''));
    end if;
    return '{"ok": false}'::jsonb;

  elsif p_passo = 'previsao_antecedencia' then
    if p_valor not in ('imediato', '1_dia', '1_semana', '1_mes') or v_prev ->> 'turno' is null or v_prev ->> 'de' is null then return '{"ok": false}'::jsonb; end if;
    insert into public.pedido_previsao (conversa_id, turno, de, ate, antecedencia) values (p_conversa, v_prev ->> 'turno', (v_prev ->> 'de')::date, (v_prev ->> 'ate')::date, p_valor)
    on conflict (conversa_id) do update set turno = excluded.turno, de = excluded.de, ate = excluded.ate, antecedencia = excluded.antecedencia, status = 'aguardando', vaga = null, vaga_em = null, atualizada_em = now();
    perform public.fluxo_set(p_conversa, jsonb_build_object('previsao', null, 'oferta_pendente', null, 'sem_horario', true));
    perform public.fluxo_nota(p_conversa, 'PREVISÃO (NÃO É AGENDAMENTO): paciente na lista de espera. Turno: ' || case v_prev ->> 'turno' when 'manha' then 'manhã' when 'tarde' then 'tarde' else 'tanto faz' end
      || '. Período: ' || to_char((v_prev ->> 'de')::date, 'DD/MM/YYYY') || ' a ' || to_char((v_prev ->> 'ate')::date, 'DD/MM/YYYY')
      || '. Pode ser chamado com antecedência de: ' || case p_valor when 'imediato' then 'até 24 horas' when '1_dia' then '1 dia' when '1_semana' then '1 semana' else '1 mês' end || '. Se surgir vaga, a atendente oferece.');
    return jsonb_build_object('ok', true, 'aviso', coalesce((select valor from public.config where chave = 'previsao_final_texto'), ''));
  end if;
  return '{"ok": false}'::jsonb;
end $$;
revoke all on function public.previsao_responder(uuid, text, text) from public, anon, authenticated;
grant execute on function public.previsao_responder(uuid, text, text) to service_role;

-- ===== PARTE 3: ligar ao motor (cada troca confere que achou o ponto; aplicada uma vez) =====
do $$ declare v text := pg_get_functiondef('public.fluxo_proximo(uuid)'::regprocedure); n text;
  a text := E'  if jsonb_typeof(d -> ''oferta_pendente'') = ''object'' then return ''horario_oferta''; end if;   -- pedido-sem-horario';
begin
  if position('previsao_' in v) > 0 then return; end if;
  n := replace(v, a, a || E'\n  if jsonb_typeof(d -> ''previsao'') = ''object'' then return ''previsao_'' || (d -> ''previsao'' ->> ''etapa''); end if;   -- pedido-previsao');
  if n = v then raise exception 'fluxo_proximo: ponto de troca não encontrado'; end if;
  execute n;
end $$;

do $$ declare v text := pg_get_functiondef('public.fluxo_perguntar(uuid,text,text)'::regprocedure); n text;
  a text := E'  when ''horario_oferta'' then   -- pedido-sem-horario';
begin
  if position('previsao_pergunta' in v) > 0 then return; end if;
  n := replace(v, a, E'  when ''previsao_turno'', ''previsao_periodo'', ''previsao_decide'', ''previsao_antecedencia'' then   -- pedido-previsao\n'
    || E'    v_ult := public.previsao_pergunta(p_conversa, p_passo); v_txt := v_ult ->> ''texto''; v_op := v_ult -> ''opcoes'';\n' || a);
  if n = v then raise exception 'fluxo_perguntar: ponto de troca não encontrado'; end if;
  execute n;
end $$;

do $$ declare v text := pg_get_functiondef('public.fluxo_aplicar(uuid,text,jsonb)'::regprocedure); n text;
  a1 text := E'  when ''horario_oferta'' then   -- pedido-sem-horario';
  a2 text := E'    if v = ''sem_horario'' then\n      perform public.fluxo_set(p_conversa, ''{"sem_horario": true}'');';
  a3 text := E'      perform public.fluxo_set(p_conversa, jsonb_build_object(''oferta_pendente'', null, ''sem_horario'', false, ''confirmado'', false));';
  a4 text := E'jsonb_build_object(''oferta_pendente'', null, ''sem_horario'', false, ''confirmado'', true)';
begin
  if position('previsao_responder' in v) > 0 then return; end if;
  n := v;
  -- passos novos
  n := replace(n, a1, E'  when ''previsao_turno'', ''previsao_periodo'', ''previsao_decide'', ''previsao_antecedencia'' then   -- pedido-previsao\n    return public.previsao_responder(p_conversa, p_passo, v);\n' || a1);
  -- "Nenhum horário serve para mim" abre o filtro (turno e período) para quem está no modo da previsão
  n := replace(n, a2, E'    if v = ''sem_horario'' and public.previsao_ativa(p_conversa) then return public.previsao_iniciar(p_conversa, false); end if;   -- pedido-previsao\n' || a2);
  -- recusou as ofertas: filtro (se já veio do filtro, vai direto à pergunta da lista)
  n := replace(n, a3, E'      if public.previsao_ativa(p_conversa) then return public.previsao_iniciar(p_conversa, coalesce(v_p ->> ''origem'', '''') = ''previsao'', v_aviso); end if;   -- pedido-previsao\n' || a3);
  -- aceitou: encerra o filtro
  n := replace(n, a4, 'jsonb_build_object(''oferta_pendente'', null, ''sem_horario'', false, ''confirmado'', true, ''previsao'', null)');
  if n = v or position('previsao_iniciar(p_conversa, false)' in n) = 0 or position('v_p ->> ''origem''' in n) = 0 or position('''previsao'', null)' in n) = 0 then raise exception 'fluxo_aplicar: algum ponto de troca não foi encontrado'; end if;
  execute n;
end $$;

-- ===== PARTE 4: a rotina que procura vaga dentro da previsão e avisa a atendente =====
create or replace function public.previsao_vigiar() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_modo text := coalesce((select valor from public.config where chave = 'pedido_horario_modo'), 'desligado');
  r record; v_slots jsonb; v_s jsonb; v_msg text; v_novas integer := 0; v_perdidas integer := 0; v_fechadas integer := 0; v_vistos integer := 0;
begin
  if v_modo not in ('teste', 'ligado') then return jsonb_build_object('modo', 'desligado'); end if;
  if not pg_try_advisory_xact_lock(hashtext('previsao_vigiar')) then return jsonb_build_object('modo', v_modo, 'ocupado', true); end if;
  -- pedido que virou agendado ou cancelado, ou conversa encerrada: sai da lista
  update public.pedido_previsao p set status = case when pa.status = 'agendado' then 'atendida' else 'cancelada' end, atualizada_em = now()
    from public.pre_agendamentos pa, public.conversas c
   where pa.conversa_id = p.conversa_id and c.id = p.conversa_id and p.status in ('aguardando', 'vaga_encontrada')
     and (pa.status in ('agendado', 'cancelado') or c.status = 'encerrada');
  get diagnostics v_fechadas = row_count;
  for r in
    select p.*, c.alerta_agenda, c.status as cstatus
      from public.pedido_previsao p join public.conversas c on c.id = p.conversa_id join public.pre_agendamentos pa on pa.conversa_id = p.conversa_id
     where p.status in ('aguardando', 'vaga_encontrada') and pa.status = 'pronto' and c.status in ('aguardando', 'em_atendimento')
       and (v_modo = 'ligado' or public.previsao_ativa(p.conversa_id))
  loop
    begin
      v_vistos := v_vistos + 1;
      v_slots := public.previsao_buscar(r.conversa_id, r.turno, greatest(r.de, (now() at time zone 'America/Bahia')::date), r.ate, public.previsao_antec_min(r.antecedencia));
      v_s := v_slots -> 0;
      if v_s is not null then
        v_msg := left('Vaga aberta dentro da previsão do paciente: ' || public.pedido_slot_texto(v_s) || '. Oferecer ao paciente (a previsão NÃO é agendamento).', 300);
        if r.status <> 'vaga_encontrada' or r.vaga is distinct from v_s then
          update public.pedido_previsao set status = 'vaga_encontrada', vaga = v_s, vaga_em = coalesce(vaga_em, now()), atualizada_em = now() where conversa_id = r.conversa_id;
          v_novas := v_novas + 1;
        end if;
        if r.alerta_agenda is null or r.alerta_agenda like 'Vaga aberta%' then
          update public.conversas set alerta_agenda = v_msg, atualizado_em = now() where id = r.conversa_id and alerta_agenda is distinct from v_msg;
        end if;
      elsif r.status = 'vaga_encontrada' then
        update public.pedido_previsao set status = 'aguardando', vaga = null, vaga_em = null, atualizada_em = now() where conversa_id = r.conversa_id;
        update public.conversas set alerta_agenda = null where id = r.conversa_id and alerta_agenda like 'Vaga aberta%';
        v_perdidas := v_perdidas + 1;
      end if;
    exception when others then
      raise warning 'previsao_vigiar: % (%)', sqlerrm, r.conversa_id;
    end;
  end loop;
  return jsonb_build_object('modo', v_modo, 'vistos', v_vistos, 'vagas_novas', v_novas, 'vagas_que_sumiram', v_perdidas, 'encerradas_da_lista', v_fechadas);
end $$;
revoke all on function public.previsao_vigiar() from public, anon, authenticated;
grant execute on function public.previsao_vigiar() to service_role;

-- ===== PARTE 5: rotina =====
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cron' and p.proname = 'schedule') then
    perform cron.schedule('previsao-vigia', '*/10 * * * *', 'select public.previsao_vigiar()');
  end if;
end $$;
