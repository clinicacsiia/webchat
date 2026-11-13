-- FLUXOGRAMA: entrada (rotina a cada 5 minutos olha os pedidos "prontos" que esperam a equipe marcar no Klingo, com horário escolhido) -> validação (modo em config.pedido_horario_modo: desligado | teste (só os celulares de klingo_api_telefones_teste) | ligado; pedido pronto, conversa aberta, horário escolhido)
--   -> lógica (A) SEM HORÁRIO = a data/hora escolhida já passou OU o Klingo mostra o horário ocupado por outra marcação (conferencia_status = 'horario_tomado'):
--        conversa SEM atendente e do motor automático, pedido de um só grupo de horários: o assistente OFERECE o horário livre mais PERTO do que o paciente tinha escolhido (botões "Sim, pode ser" / "Não posso");
--          se o paciente recusar, oferece o PRÓXIMO (em outro dia, se houver); se recusar de novo, pede que ELE escolha data e hora no calendário (passo 'horario'). Aceitou: o horário entra no pedido e ele volta à equipe como "pronto".
--        conversa com atendente (ou sem motor automático, ou com mais de um grupo de horários): só a faixa de aviso para o atendente
--      (B) HORÁRIO AINDA LIVRE, mas o pedido está parado há config.pedido_parado_horas (24): faixa de aviso na conversa para o atendente marcar ou não
--   -> saída (mensagem ao paciente com botões, passo novo 'horario_oferta' no motor, ou faixa conversas.alerta_agenda; contagens em jsonb, sem dado de paciente)
-- Versão 1.1 — 13/11/2026 / Mudança: em vez de cancelar e pedir desculpa, oferece o horário mais próximo, depois o seguinte, e por fim pede que o paciente escolha (pedido do dono, 13/11/2026). Novo passo 'horario_oferta' em fluxo_proximo, fluxo_perguntar e fluxo_aplicar.
-- Versão 1.0 — 13/11/2026: cancelava o pedido, pedia desculpa e encerrava a conversa (substituída pela 1.1).
-- Cuidado: "horario_tomado" também acontece quando a equipe marca com outro nome ou telefone; por isso o modo começa em 'teste' e o assistente só age com a conversa SEM atendente (status 'aguardando').
-- LIGAR PARA TODOS: update public.config set valor = 'ligado' where chave = 'pedido_horario_modo';
-- DESLIGAR (efeito imediato): update public.config set valor = 'desligado' where chave = 'pedido_horario_modo';  ou  select cron.unschedule('pedido-horario-vigia');
-- ROLLBACK: select cron.unschedule('pedido-horario-vigia'); depois refazer fluxo_proximo, fluxo_perguntar, fluxo_aplicar e agenda_conferencia_aplicar a partir de supabase/producao/funcoes/ (copiados SEM esta mudança no retrato de 12/11/2026, git: commit anterior a este arquivo); drop function public.pedido_horario_vigiar(); drop function public.pedido_oferta_texto(jsonb, integer, text);

-- ===== PARTE 1: chaves =====
insert into public.config (chave, valor) values
  ('pedido_horario_modo', 'teste'),
  ('pedido_parado_horas', '24'),
  ('pedido_sem_horario_texto', 'O horário que você escolheu ({original}) não está mais disponível. O mais próximo que temos é {oferta}. Esse horário serve para você?'),
  ('pedido_oferta2_texto', 'Tudo bem! Temos também {oferta}. Esse horário serve para você?'),
  ('pedido_escolha_texto', 'Sem problema! Escolha no calendário a data e a hora que forem melhores para você e deixo o seu pedido pronto para a equipe confirmar.')
on conflict (chave) do nothing;
-- a chave da versão 1.0 tinha outro texto (pedido de desculpas): troca pelo novo
update public.config set valor = 'O horário que você escolheu ({original}) não está mais disponível. O mais próximo que temos é {oferta}. Esse horário serve para você?'
 where chave = 'pedido_sem_horario_texto' and valor like 'Olá! Infelizmente%';

-- ===== PARTE 2: texto da oferta =====
create or replace function public.pedido_oferta_texto(p_slot jsonb, p_n integer, p_original text) returns text
language plpgsql stable security definer set search_path to '' as $$
declare
  v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  v_modelo text := case when p_n <= 1 then coalesce((select valor from public.config where chave = 'pedido_sem_horario_texto'), '')
                        else coalesce((select valor from public.config where chave = 'pedido_oferta2_texto'), '') end;
  v_data date := (p_slot ->> 'data')::date;
  v_oferta text;
begin
  v_oferta := v_dias[extract(dow from v_data)::int + 1] || ', ' || to_char(v_data, 'DD/MM') || ' às ' || left(p_slot ->> 'hora', 5)
              || coalesce(' na unidade ' || initcap(lower(nullif(p_slot ->> 'unidade', ''))), '');
  return replace(replace(v_modelo, '{original}', coalesce(p_original, 'o horário anterior')), '{oferta}', v_oferta);
end $$;
revoke all on function public.pedido_oferta_texto(jsonb, integer, text) from public, anon, authenticated;
grant execute on function public.pedido_oferta_texto(jsonb, integer, text) to service_role;

-- ===== PARTE 3: a rotina =====
create or replace function public.pedido_horario_vigiar() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_modo text := coalesce((select valor from public.config where chave = 'pedido_horario_modo'), 'desligado');
  v_horas integer := coalesce(nullif((select valor from public.config where chave = 'pedido_parado_horas'), '')::integer, 24);
  v_agora timestamp := now() at time zone 'America/Bahia';
  r record; v_lista text[]; v_hor text; v_msg text; v_procs int[]; v_slots jsonb; v_s1 jsonb; v_s2 jsonb; v_pend jsonb;
  v_ofertas integer := 0; v_calendario integer := 0; v_avisos_sem integer := 0; v_avisos_parado integer := 0; v_vistos integer := 0;
begin
  if v_modo not in ('teste', 'ligado') then return jsonb_build_object('modo', 'desligado'); end if;
  if not pg_try_advisory_xact_lock(hashtext('pedido_horario_vigiar')) then return jsonb_build_object('modo', v_modo, 'ocupado', true); end if;
  select coalesce(array_agg(right(t, 8)), '{}') into v_lista
    from regexp_split_to_table(coalesce((select valor from public.config where chave = 'klingo_api_telefones_teste'), ''), '[^0-9]+') t where length(t) >= 8;

  for r in
    select pa.id as pid, pa.conversa_id, pa.conferencia_status, pa.atualizado_em, c.status as cstatus, c.motor, c.alerta_agenda,
           (select min(((e ->> 'data') || ' ' || coalesce(nullif(e ->> 'hora', ''), '00:00'))::timestamp) from jsonb_array_elements(pa.escolha_horario) e) as primeiro,
           (select max(((e ->> 'data') || ' ' || coalesce(nullif(e ->> 'hora', ''), '23:59'))::timestamp) from jsonb_array_elements(pa.escolha_horario) e) as ultimo,
           right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) as fone
      from public.pre_agendamentos pa
      join public.conversas c on c.id = pa.conversa_id
      join public.contatos ct on ct.id = c.contato_id
     where pa.status = 'pronto' and c.status in ('aguardando', 'em_atendimento')
       and jsonb_typeof(pa.escolha_horario) = 'array' and jsonb_array_length(pa.escolha_horario) > 0
  loop
    begin
      if v_modo = 'teste' and not (r.fone = any (v_lista)) then continue; end if;
      v_vistos := v_vistos + 1;
      v_hor := to_char(r.primeiro, 'DD/MM "às" HH24:MI');

      if r.ultimo < v_agora or r.conferencia_status = 'horario_tomado' then
        -- (A) sem horário
        v_procs := public.fluxo_procs(r.conversa_id);
        if r.cstatus = 'aguardando' and r.motor = 'fluxo' and v_procs is not null and jsonb_array_length(public.agenda_grupos(v_procs)) = 1 then
          -- o assistente oferece o horário livre mais perto do que o paciente tinha escolhido; depois o seguinte, em outro dia se houver
          perform set_config('app.conversa', r.conversa_id::text, true);
          select coalesce(jsonb_agg(to_jsonb(x) - 'ord' order by x.ord), '[]'::jsonb) into v_slots from (
            select h.data, h.hora, h.unidade, h.local, h.profissional, h.duracao_min as min, h.chegada,
                   row_number() over (order by abs(h.data - r.primeiro::date), h.data, h.hora) as ord
              from public.agenda_horarios(v_procs, current_date, current_date + 30, null, null, null, '[]'::jsonb) h
             where h.data >= current_date and (h.data + h.hora::time) > r.primeiro) x;
          -- (acima: nunca oferece o próprio horário perdido; se não houver nada depois dele, tenta qualquer horário livre)
          if jsonb_array_length(v_slots) = 0 then
            select coalesce(jsonb_agg(to_jsonb(x) - 'ord' order by x.ord), '[]'::jsonb) into v_slots from (
              select h.data, h.hora, h.unidade, h.local, h.profissional, h.duracao_min as min, h.chegada,
                     row_number() over (order by h.data, h.hora) as ord
                from public.agenda_horarios(v_procs, current_date, current_date + 30, null, null, null, '[]'::jsonb) h
               where not (h.data = r.primeiro::date and h.hora = to_char(r.primeiro, 'HH24:MI'))) x;
          end if;
          -- o segundo horário prefere outro dia
          v_s1 := v_slots -> 0;
          if v_s1 is not null then
            select s into v_s2 from jsonb_array_elements(v_slots) with ordinality t(s, ord) where ord > 1 order by (s ->> 'data' = v_s1 ->> 'data'), ord limit 1;
            v_slots := case when v_s2 is null then jsonb_build_array(v_s1) else jsonb_build_array(v_s1, v_s2) end;
          end if;

          update public.pre_agendamentos set status = 'rascunho', escolha_horario = null, data_desejada = null, hora_desejada = null, etapa = 'data_hora',
                 conferencia_status = null, conferencia_detalhe = null, atualizado_em = now()
           where id = r.pid and status = 'pronto';
          if found then
            update public.conversas set ia_ativa = true, alerta_agenda = null, atualizado_em = now() where id = r.conversa_id and status = 'aguardando';
            if v_s1 is not null then
              v_pend := jsonb_build_object('n', 1, 'original', v_hor, 'slots', v_slots, 'texto', public.pedido_oferta_texto(v_s1, 1, v_hor));
              perform public.fluxo_set(r.conversa_id, jsonb_build_object('oferta_pendente', v_pend, 'confirmado', true, 'sem_horario', false));
              perform public.fluxo_nota(r.conversa_id, 'Horário escolhido (' || v_hor || ') não vale mais: o assistente ofereceu ao paciente o horário mais próximo disponível.');
              perform public.fluxo_perguntar(r.conversa_id, 'horario_oferta', null);
              v_ofertas := v_ofertas + 1;
            else
              perform public.fluxo_set(r.conversa_id, jsonb_build_object('oferta_pendente', null, 'confirmado', false, 'sem_horario', false));
              perform public.fluxo_nota(r.conversa_id, 'Horário escolhido (' || v_hor || ') não vale mais e não há outro livre nos próximos 30 dias: o assistente pediu ao paciente que escolha data e hora.');
              perform public.fluxo_perguntar(r.conversa_id, 'horario', coalesce((select valor from public.config where chave = 'pedido_escolha_texto'), ''));
              v_calendario := v_calendario + 1;
            end if;
          end if;
        else
          -- tem atendente na conversa (ou o pedido não cabe no assistente): ele decide
          v_msg := left('Pedido sem horário: ' || case when r.ultimo < v_agora then 'a data escolhida (' || v_hor || ') já passou.' else 'o horário escolhido (' || v_hor || ') aparece ocupado no Klingo.' end || ' Avisar o paciente e combinar outro, ou cancelar o pedido.', 300);
          if r.alerta_agenda is distinct from v_msg then
            update public.conversas set alerta_agenda = v_msg, atualizado_em = now() where id = r.conversa_id; v_avisos_sem := v_avisos_sem + 1;
          end if;
        end if;
      elsif r.atualizado_em < now() - make_interval(hours => v_horas) then
        -- (B) horário ainda livre, pedido parado: o atendente decide marcar ou não
        v_msg := left('Pedido parado há mais de ' || v_horas || ' h: o horário escolhido (' || v_hor || ') ainda está livre. Marcar ou não?', 300);
        if r.alerta_agenda is null or r.alerta_agenda like 'Pedido parado%' then
          if r.alerta_agenda is distinct from v_msg then
            update public.conversas set alerta_agenda = v_msg, atualizado_em = now() where id = r.conversa_id; v_avisos_parado := v_avisos_parado + 1;
          end if;
        end if;
      end if;
    exception when others then
      raise warning 'pedido_horario_vigiar: % (%)', sqlerrm, r.pid;
    end;
  end loop;
  return jsonb_build_object('modo', v_modo, 'vistos', v_vistos, 'ofertas', v_ofertas, 'pediu_calendario', v_calendario, 'avisos_sem_horario', v_avisos_sem, 'avisos_parado', v_avisos_parado);
end $$;
revoke all on function public.pedido_horario_vigiar() from public, anon, authenticated;
grant execute on function public.pedido_horario_vigiar() to service_role;

-- ===== PARTE 4: a conferência da agenda não pode apagar o aviso "Pedido parado" (já aplicada em 13/11/2026; a linha tem de existir uma vez) =====
do $$ declare v text := pg_get_functiondef('public.agenda_conferencia_aplicar(jsonb)'::regprocedure); n text;
begin
  if position('Pedido parado%' in v) > 0 then return; end if;
  n := replace(v, 'and alerta_agenda is distinct from v_alerta;', 'and alerta_agenda is distinct from v_alerta and not (v_alerta is null and alerta_agenda like ''Pedido parado%'');');
  if n = v then raise exception 'agenda_conferencia_aplicar: ponto de troca não encontrado'; end if;
  execute n;
end $$;

-- ===== PARTE 5: o passo novo 'horario_oferta' no motor (3 funções; cada troca confere que achou o ponto e é aplicada uma vez) =====
-- fluxo_proximo: com uma oferta pendente, a próxima pergunta é sempre a oferta.
do $$ declare v text := pg_get_functiondef('public.fluxo_proximo(uuid)'::regprocedure); n text;
  a text := E'  select count(*) into n_itens from public.pre_agendamento_itens where conversa_id = p_conversa and ativo;';
begin
  if position('horario_oferta' in v) > 0 then return; end if;
  n := replace(v, a, a || E'\n  if jsonb_typeof(d -> ''oferta_pendente'') = ''object'' then return ''horario_oferta''; end if;   -- pedido-sem-horario');
  if n = v then raise exception 'fluxo_proximo: ponto de troca não encontrado'; end if;
  execute n;
end $$;

-- fluxo_perguntar: a pergunta da oferta (texto já pronto em dados.oferta_pendente.texto) com os dois botões.
do $$ declare v text := pg_get_functiondef('public.fluxo_perguntar(uuid,text,text)'::regprocedure); n text;
  a text := E'  when ''horario'' then\n    v_txt := public.fluxo_t(''horario'', ctx);';
begin
  if position('horario_oferta' in v) > 0 then return; end if;
  n := replace(v, a, E'  when ''horario_oferta'' then   -- pedido-sem-horario\n'
    || E'    v_txt := coalesce(d -> ''oferta_pendente'' ->> ''texto'', ''Esse horário serve para você?'');\n'
    || E'    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object(''valor'', ''sim'', ''rotulo'', ''Sim, pode ser esse''),\n'
    || E'                                                            jsonb_build_object(''valor'', ''nao'', ''rotulo'', ''Não posso nesse horário'')));\n' || a);
  if n = v then raise exception 'fluxo_perguntar: ponto de troca não encontrado'; end if;
  execute n;
end $$;

-- fluxo_aplicar: sim = o horário entra no pedido (conferido de novo agora) e o pedido volta à equipe; não = o próximo horário; não de novo = o paciente escolhe no calendário.
do $$ declare v text := pg_get_functiondef('public.fluxo_aplicar(uuid,text,jsonb)'::regprocedure); n text;
  a text := E'  when ''horario'' then\n    if v = ''sem_horario'' then';
begin
  if position('horario_oferta' in v) > 0 then return; end if;
  n := replace(v, a, E'  when ''horario_oferta'' then   -- pedido-sem-horario\n'
    || E'    declare v_p jsonb; v_n int; v_s jsonb; v_livre boolean := false; v_aviso text;\n'
    || E'    begin\n'
    || E'      select dados -> ''oferta_pendente'' into v_p from public.conversa_fluxo where conversa_id = p_conversa;\n'
    || E'      if jsonb_typeof(v_p) is distinct from ''object'' or v not in (''sim'', ''nao'') then return ''{"ok": false}''::jsonb; end if;\n'
    || E'      v_n := coalesce((v_p ->> ''n'')::int, 1); v_s := v_p -> ''slots'' -> (v_n - 1);\n'
    || E'      if v = ''sim'' and v_s is not null then\n'
    || E'        perform set_config(''app.conversa'', p_conversa::text, true);\n'
    || E'        select true into v_livre from public.agenda_horarios(public.fluxo_procs(p_conversa), (v_s ->> ''data'')::date, (v_s ->> ''data'')::date, null, null, null, ''[]''::jsonb) h where h.hora = v_s ->> ''hora'' limit 1;\n'
    || E'        if coalesce(v_livre, false) then\n'
    || E'          update public.pre_agendamentos set escolha_horario = jsonb_build_array(jsonb_build_object(''grupo'', 1, ''data'', v_s ->> ''data'', ''hora'', v_s ->> ''hora'', ''unidade'', v_s ->> ''unidade'', ''profissional'', v_s ->> ''profissional'',\n'
    || E'                                         ''local'', v_s ->> ''local'', ''min'', coalesce((v_s ->> ''min'')::int, 30), ''chegada'', coalesce((v_s ->> ''chegada'')::boolean, false))),\n'
    || E'            data_desejada = (v_s ->> ''data'')::date, hora_desejada = v_s ->> ''hora'', unidade = coalesce(unidade, v_s ->> ''unidade''), etapa = ''confirmacao'', atualizado_em = now()\n'
    || E'           where conversa_id = p_conversa;\n'
    || E'          perform public.fluxo_set(p_conversa, jsonb_build_object(''oferta_pendente'', null, ''sem_horario'', false, ''confirmado'', true));\n'
    || E'          perform public.fluxo_nota(p_conversa, ''Paciente aceitou o horário oferecido pelo assistente: '' || (v_s ->> ''data'') || '' '' || (v_s ->> ''hora'') || ''.'');\n'
    || E'          return jsonb_build_object(''ok'', true, ''aviso'', ''Combinado! Troquei o horário do seu pedido.'');\n'
    || E'        end if;\n'
    || E'        v_aviso := ''Esse horário acabou de ser ocupado.'';\n'
    || E'      end if;\n'
    || E'      v_s := v_p -> ''slots'' -> v_n;   -- índice v_n (0-based) = o próximo da lista\n'
    || E'      if v_s is not null and v_n < 2 then\n'
    || E'        perform public.fluxo_set(p_conversa, jsonb_build_object(''oferta_pendente'', v_p || jsonb_build_object(''n'', v_n + 1, ''texto'', public.pedido_oferta_texto(v_s, v_n + 1, v_p ->> ''original''))));\n'
    || E'        return jsonb_build_object(''ok'', true, ''aviso'', v_aviso);\n'
    || E'      end if;\n'
    || E'      perform public.fluxo_set(p_conversa, jsonb_build_object(''oferta_pendente'', null, ''sem_horario'', false, ''confirmado'', false));\n'
    || E'      update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null, etapa = ''data_hora'' where conversa_id = p_conversa;\n'
    || E'      perform public.fluxo_nota(p_conversa, ''Paciente não pôde nos horários oferecidos: pediu-se que escolha data e hora no calendário.'');\n'
    || E'      return jsonb_build_object(''ok'', true, ''aviso'', coalesce(v_aviso || '' '', '''') || coalesce((select valor from public.config where chave = ''pedido_escolha_texto''), ''''));\n'
    || E'    end;\n' || a);
  if n = v then raise exception 'fluxo_aplicar: ponto de troca não encontrado'; end if;
  execute n;
end $$;

-- ===== PARTE 6: rotina =====
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cron' and p.proname = 'schedule') then
    perform cron.schedule('pedido-horario-vigia', '*/5 * * * *', 'select public.pedido_horario_vigiar()');
  end if;
end $$;
