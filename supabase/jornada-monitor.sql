-- FLUXOGRAMA: entrada (pg_cron, todo minuto) -> validação (só roda uma cópia por vez; cada etapa isolada: se uma falha, as outras seguem e o erro fica registrado) -> lógica (1. lê o Klingo quando é a hora; 2. sincroniza as conversas do chat; 3. aplica as regras; 4. abre o alerta de quem passou do prazo ou do horário; 5. fecha sozinho o alerta que deixou de valer) -> saída (jornada_sync_estado.vigia_* para o painel mostrar "monitorado há X s")
-- Versão 1.0 — 01/11/2026 / Mudança: monitoramento de 1 em 1 minuto da Jornada do paciente, com alerta de demora
--
-- Aplicado no Supabase como a migração "jornada_10_monitor_1min". Pode ser rodado de novo sem efeito (tudo "if not exists" / "or replace" / "on conflict").
-- Depende de jornada_01 a jornada_09 (o módulo Jornada) e da Edge Function sync-jornada-klingo.
--
-- O que NÃO faz: o Klingo só é LIDO (a API dele não grava). O sistema avisa, cria a tarefa e fecha o aviso quando o problema some;
-- mover o paciente de etapa continua sendo ação da equipe.

alter table public.jornada_sync_estado
  add column if not exists vigia_em timestamptz,
  add column if not exists vigia_resultado jsonb,
  add column if not exists vigia_erro text;

-- Duas regras novas, editáveis na tabela (parametros) ou desligáveis (ativa = false), sem mexer em código.
--  alerta_atraso   : paciente parado numa etapa além do prazo da coluna (sla_min). Só as etapas em que o paciente espera de verdade.
--  alerta_horario  : chegou a hora do exame (mais "minutos") e o paciente ainda não foi atendido.
insert into public.jornada_regra (chave, nome, descricao, ativa, parametros) values
  ('alerta_atraso', 'Avisar quando o paciente demora numa etapa',
   'Cartão parado numa das etapas de "colunas" além do prazo da coluna ganha a tarefa "Passou do prazo", vencida na hora. A tarefa se fecha sozinha quando o cartão sai da etapa. Só vale para cartões de ontem em diante (e para as etapas do chat).',
   true, '{"colunas": ["contato", "orcamento", "autorizacao", "chegou", "em_atendimento"]}'::jsonb),
  ('alerta_horario', 'Avisar quando passa do horário e o paciente não foi atendido',
   'Exame de hoje em "A confirmar" ou "Confirmado" cujo horário passou há mais de "minutos" ganha a tarefa "Passou do horário". Fecha sozinha quando o Klingo registra o atendimento, o cancelamento, a remarcação ou a falta.',
   true, '{"minutos": 15}'::jsonb)
on conflict (chave) do nothing;

create or replace function public.jornada_vigiar()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hoje      date := (now() at time zone 'America/Sao_Paulo')::date;
  p           jsonb;
  v_min       integer;
  v_chat      jsonb;
  v_regras    jsonb;
  v_erros     text[] := '{}';
  n_atraso    integer := 0;
  n_horario   integer := 0;
  n_fechadas  integer := 0;
  v_saida     jsonb;
begin
  -- Se a rodada anterior ainda não terminou, não empilha outra.
  if not pg_try_advisory_xact_lock(hashtext('jornada_vigiar')) then
    return jsonb_build_object('pulou', true);
  end if;

  -- 1) Klingo: a função decide sozinha se já é a hora (1 min no expediente, mais espaçado fora dele).
  begin
    perform public.jornada_klingo_agendar();
  exception when others then
    v_erros := v_erros || ('klingo: ' || left(sqlerrm, 120));
  end;

  -- 2) Conversas do chat viram cartões.
  begin
    v_chat := public.jornada_conversas_sincronizar();
  exception when others then
    v_erros := v_erros || ('chat: ' || left(sqlerrm, 120));
  end;

  -- 3) Regras que já existiam (confirmar presença, remarcar faltou, prioridade por atraso, escala).
  begin
    v_regras := public.jornada_aplicar_regras();
  exception when others then
    v_erros := v_erros || ('regras: ' || left(sqlerrm, 120));
  end;

  -- 4a) Alerta de demora na etapa.
  begin
    if public.jornada_regra_ativa('alerta_atraso') then
      select parametros into p from public.jornada_regra where chave = 'alerta_atraso';
      with novas as (
        insert into public.jornada_tarefa (card_id, titulo, origem, chave, vence_em)
        select c.id, 'Passou do prazo em "' || k.nome || '": resolver e seguir o paciente', 'sistema', 'atraso:' || c.coluna, now()
        from public.jornada_card c
        join public.jornada_coluna k on k.id = c.coluna
        where c.arquivado_em is null
          and k.sla_min is not null
          and now() - c.coluna_desde > make_interval(mins => k.sla_min)
          and (c.data_ref >= v_hoje - 1 or k.etapa = 'antes')
          and c.coluna in (select jsonb_array_elements_text(coalesce(p -> 'colunas', '[]'::jsonb)))
        on conflict (card_id, chave) where chave is not null do nothing
        returning card_id, chave
      )
      insert into public.jornada_evento (card_id, tipo, origem, detalhe)
      select card_id, 'tarefa', 'sistema', jsonb_build_object('acao', 'alerta', 'motivo', 'atraso', 'chave', chave) from novas;
      get diagnostics n_atraso = row_count;
    end if;
  exception when others then
    v_erros := v_erros || ('alerta_atraso: ' || left(sqlerrm, 120));
  end;

  -- 4b) Alerta de horário que passou sem atendimento.
  begin
    if public.jornada_regra_ativa('alerta_horario') then
      select parametros into p from public.jornada_regra where chave = 'alerta_horario';
      v_min := greatest(coalesce((p ->> 'minutos')::integer, 15), 1);
      with novas as (
        insert into public.jornada_tarefa (card_id, titulo, origem, chave, vence_em)
        select c.id, 'Passou do horário e o paciente ainda não foi atendido: localizar', 'sistema', 'horario', now()
        from public.jornada_card c
        where c.arquivado_em is null
          and c.coluna in ('a_confirmar', 'confirmado')
          and c.data_ref = v_hoje
          and exists (select 1 from public.jornada_exame e
                      where e.card_id = c.id and e.status in ('agendado', 'confirmado') and e.agendado_para < now() - make_interval(mins => v_min))
        on conflict (card_id, chave) where chave is not null do nothing
        returning card_id
      )
      insert into public.jornada_evento (card_id, tipo, origem, detalhe)
      select card_id, 'tarefa', 'sistema', jsonb_build_object('acao', 'alerta', 'motivo', 'horario') from novas;
      get diagnostics n_horario = row_count;
    end if;
  exception when others then
    v_erros := v_erros || ('alerta_horario: ' || left(sqlerrm, 120));
  end;

  -- 5) Fecha sozinho o aviso que deixou de valer. A chave ganha "#id" para o mesmo aviso poder voltar a abrir numa próxima demora.
  begin
    with fechadas as (
      update public.jornada_tarefa t
         set feita_em = now(), chave = t.chave || '#' || t.id
        from public.jornada_card c
       where t.card_id = c.id and t.feita_em is null and t.origem = 'sistema'
         and (
           (t.chave like 'atraso:%' and (
              c.arquivado_em is not null
              or c.coluna <> substr(t.chave, 8)
              or not exists (select 1 from public.jornada_coluna k where k.id = c.coluna and k.sla_min is not null and now() - c.coluna_desde > make_interval(mins => k.sla_min))))
           or
           (t.chave = 'horario' and (
              c.arquivado_em is not null
              or c.coluna not in ('a_confirmar', 'confirmado')
              or not exists (select 1 from public.jornada_exame e where e.card_id = c.id and e.status in ('agendado', 'confirmado') and e.agendado_para < now())))
         )
      returning t.card_id, t.titulo
    )
    insert into public.jornada_evento (card_id, tipo, origem, detalhe)
    select card_id, 'tarefa', 'sistema', jsonb_build_object('acao', 'feita', 'titulo', titulo, 'motivo', 'O problema deixou de existir.') from fechadas;
    get diagnostics n_fechadas = row_count;
  exception when others then
    v_erros := v_erros || ('fechar: ' || left(sqlerrm, 120));
  end;

  v_saida := jsonb_build_object('alertas_atraso', n_atraso, 'alertas_horario', n_horario, 'alertas_fechados', n_fechadas,
                                'chat', v_chat, 'regras', v_regras, 'erros', to_jsonb(v_erros));
  update public.jornada_sync_estado
     set vigia_em = now(), vigia_resultado = v_saida, vigia_erro = nullif(array_to_string(v_erros, ' | '), '')
   where id;
  return v_saida;
end;
$$;

-- Só o cron (postgres) e o próprio banco chamam; ninguém de fora.
revoke all on function public.jornada_vigiar() from public, anon, authenticated;

-- Agendamento: a cada minuto. (A leitura do Klingo se espaça sozinha fora do expediente: ver jornada_klingo_proximo.)
-- Os dois nomes já são únicos no pg_cron, então rodar de novo apenas atualiza.
select cron.schedule('jornada-vigia', '* * * * *', $cron$select public.jornada_vigiar()$cron$);
