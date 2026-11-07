-- FLUXOGRAMA: entrada (mensagem nova na conversa; rotina do pg_cron a cada minuto) -> validação (o cronômetro só zera com resposta de PESSOA: autor 'agente' com agente_id; mensagem do assistente virtual não zera) -> lógica (1. corrige o gatilho; 2. horário de trabalho em config; 3. aos 10 min de espera avisa a equipe por push, repetindo a cada 15 min; 4. aos 20 min avisa o paciente no chat, uma vez por espera; 5. cartão do paciente sem relógio) -> saída (conversas.espera_alerta_em / espera_aviso_paciente_em e as mensagens do chat)
-- Versão 1.0 — 07/11/2026 / Mudança: Implementação inicial. Origem: esperas de 154 e 83 min sem alerta, com o chat dizendo "a equipe está online e acompanhando".
--
-- Aplicar em PARTES (o Supabase expira a migração em 60 s); cada bloco "Parte N" é independente e pode rodar de novo (create or replace / if not exists).
-- Depois de aplicar: publicar a Edge Function avisar-equipe (versão 1.1) e o index.html novo.
-- ROLLBACK: voltar mensagem_inserida e chat_acompanhar para as definições de cronometro-resposta.sql e fase7-motor.sql; `select cron.unschedule('espera-vigia');`.

-- ===== Parte 1: colunas, horário de trabalho e textos =====
alter table public.conversas add column if not exists espera_alerta_em timestamptz;           -- último alerta enviado à equipe nesta espera
alter table public.conversas add column if not exists espera_aviso_paciente_em timestamptz;   -- aviso de fila enviado ao paciente nesta espera

-- Horário de trabalho (Brasília): segunda a sexta, 8h às 18h. Dias: 1 = segunda ... 7 = domingo. Feriados não entram.
insert into public.config (chave, valor) values
  ('horario_trabalho', '{"fuso":"America/Sao_Paulo","dias":[1,2,3,4,5],"inicio":"08:00","fim":"18:00"}')
on conflict (chave) do nothing;

insert into public.fluxo_texto (chave, texto, descricao) values
  ('espera_longa_dentro', 'Estamos com muitas conversas, seu pedido segue na fila e já foi sinalizado à equipe. Um atendente responde por aqui assim que possível.',
   'Aviso único ao paciente que passou de 20 minutos sem resposta de uma pessoa, em horário de trabalho.'),
  ('espera_longa_fora', 'No momento não estamos em horário de trabalho, mas o seu pedido está registrado. Assim que a equipe iniciar o atendimento, entraremos em contato com você por aqui.',
   'Aviso único ao paciente que passou de 20 minutos sem resposta de uma pessoa, fora do horário de trabalho.')
on conflict (chave) do nothing;

-- Textos que prometiam presença ("equipe online e acompanhando", "em instantes"). Só troca o que ainda é o texto original: edição da equipe fica.
do $$
declare r record;
begin
  for r in select * from (values
    ('pronto_online',
     $t$Pronto, {nome}! Recebemos tudo e montamos a PREVISÃO do seu agendamento. Atenção: ainda não está confirmado. Um atendente (uma pessoa da equipe) vai conferir, marcar no sistema e te enviar aqui neste chat a confirmação de data, horário e valor. A equipe está online e acompanhando. Se quiser falar com ela, é só escrever a qualquer momento.$t$,
     $t$Pronto, {nome}! Recebemos tudo e montamos a PREVISÃO do seu agendamento. Atenção: ainda não está confirmado. Um atendente (uma pessoa da equipe) vai conferir, marcar no sistema e te enviar aqui neste chat a confirmação de data, horário e valor, assim que possível. Se quiser falar com a equipe, é só escrever a qualquer momento.$t$),
    ('transferir_online',
     $t$Um atendente (uma pessoa da equipe) vai continuar com você em instantes. Pode escrever aqui a qualquer momento.$t$,
     $t$Um atendente (uma pessoa da equipe) vai continuar com você aqui, assim que possível. Pode escrever a qualquer momento.$t$),
    ('ola_proprio',
     $t$Olá, {nome}! Eu sou o assistente virtual da clínica, uma inteligência artificial (IA). Uma pessoa da equipe acompanha esta conversa e pode falar com você a qualquer momento: é só tocar em "Falar com um atendente". Aqui eu monto uma previsão do seu agendamento para o atendimento ser mais rápido; quem confirma é um atendente. Vamos com calma, é só tocar nas opções.$t$,
     $t$Olá, {nome}! Eu sou o assistente virtual da clínica, uma inteligência artificial (IA). Se precisar de uma pessoa, é só tocar em "Falar com um atendente". Aqui eu monto uma previsão do seu agendamento para o atendimento ser mais rápido; quem confirma é um atendente. Vamos com calma, é só tocar nas opções.$t$),
    ('ola_filho',
     $t$Olá, {nome}! Eu sou o assistente virtual da clínica, uma inteligência artificial (IA), e vou ajudar a organizar o atendimento de {paciente}. Uma pessoa da equipe acompanha esta conversa e pode falar com você a qualquer momento: é só tocar em "Falar com um atendente". Aqui eu monto uma previsão do agendamento; quem confirma é um atendente. É só tocar nas opções.$t$,
     $t$Olá, {nome}! Eu sou o assistente virtual da clínica, uma inteligência artificial (IA), e vou ajudar a organizar o atendimento de {paciente}. Se precisar de uma pessoa, é só tocar em "Falar com um atendente". Aqui eu monto uma previsão do agendamento; quem confirma é um atendente. É só tocar nas opções.$t$)
  ) as t(chave, antigo, novo)
  loop
    update public.fluxo_texto set texto = r.novo where chave = r.chave and texto = r.antigo;
  end loop;
end $$;

-- ===== Parte 2: o cronômetro só zera com resposta de uma PESSOA =====
-- Antes: qualquer mensagem com autor 'agente' zerava, inclusive as do assistente virtual (que não têm agente_id).
create or replace function public.mensagem_inserida()
returns trigger language plpgsql security definer set search_path to '' as $$
declare v_token text; v_nome text;
begin
  update public.conversas set
    ultima_mensagem = left(new.texto, 140),
    atualizado_em = now(),
    nao_lidas_agente = case when new.autor = 'cliente' then nao_lidas_agente + 1 else nao_lidas_agente end,
    cliente_aguarda_desde = case
      when new.autor = 'cliente' then coalesce(cliente_aguarda_desde, new.criado_em)
      when new.autor = 'agente' and new.agente_id is not null then null
      else cliente_aguarda_desde end
  where id = new.conversa_id;
  if new.autor = 'cliente' then
    update public.contatos set ultimo_contato_em = now()
    where id = (select contato_id from public.conversas where id = new.conversa_id);
  end if;
  select token into v_token from public.conversa_segredo where conversa_id = new.conversa_id;
  if v_token is not null then
    select nome into v_nome from public.agentes where id = new.agente_id;
    if v_nome is null and new.autor = 'agente' then v_nome := 'Assistente virtual'; end if;
    begin
      perform realtime.send(
        jsonb_build_object('id', new.id, 'autor', new.autor, 'texto', new.texto,
                           'criado_em', new.criado_em, 'agente', v_nome, 'opcoes', new.opcoes),
        'msg', 'conversa:' || v_token, false);
    exception when others then null;
    end;
  end if;
  return new;
end $$;

-- ===== Parte 3: horário de trabalho e a rotina que vigia as esperas =====
create or replace function public.horario_trabalho_agora(p_em timestamptz default now()) returns boolean
language plpgsql stable security definer set search_path to '' as $$
declare c jsonb; l timestamp;
begin
  select valor::jsonb into c from public.config where chave = 'horario_trabalho';
  if c is null then return public.fluxo_equipe_online(); end if;
  l := p_em at time zone coalesce(c ->> 'fuso', 'America/Sao_Paulo');
  return (c -> 'dias') @> to_jsonb(extract(isodow from l)::int)
     and l::time >= (c ->> 'inicio')::time and l::time < (c ->> 'fim')::time;
exception when others then
  return public.fluxo_equipe_online();
end $$;

-- Roda a cada minuto. Duas etapas isoladas: se uma falha, a outra segue.
--   a) 10 min de espera por uma pessoa, em horário de trabalho: UM push à equipe (admins e atendentes) com a contagem; repete a cada 15 min enquanto durar.
--   b) 20 min de espera: UMA mensagem ao paciente (texto de fluxo_texto), no máximo uma vez por espera.
-- "Espera" = conversa aberta, sem o assistente respondendo, com cliente_aguarda_desde preenchido (ver Parte 2).
create or replace function public.espera_vigiar() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare r record; v_url text; v_seg text; v_dentro boolean := public.horario_trabalho_agora(); v_alertadas int := 0; v_avisadas int := 0; v_erro text;
begin
  begin
    if v_dentro then
      with alvo as (
        update public.conversas c set espera_alerta_em = now()
        where c.status <> 'encerrada' and not c.ia_ativa and c.cliente_aguarda_desde is not null
          and c.cliente_aguarda_desde <= now() - interval '10 minutes'
          and (c.espera_alerta_em is null or c.espera_alerta_em < c.cliente_aguarda_desde or c.espera_alerta_em <= now() - interval '15 minutes')
        returning c.id)
      select count(*) into v_alertadas from alvo;
      if v_alertadas > 0 then
        select valor into v_url from public.config where chave = 'equipe_push_url';
        v_seg := public.fila_aviso_segredo();
        if coalesce(v_url, '') <> '' and coalesce(v_seg, '') <> '' then
          perform net.http_post(url := v_url, body := jsonb_build_object('tipo', 'espera', 'quantidade', v_alertadas),
                                headers := jsonb_build_object('Content-Type', 'application/json', 'x-fila-aviso-segredo', v_seg));
        end if;
      end if;
    end if;
  exception when others then
    v_erro := 'alerta: ' || sqlerrm;
  end;
  begin
    for r in
      update public.conversas c set espera_aviso_paciente_em = now()
      where c.status <> 'encerrada' and not c.ia_ativa and c.cliente_aguarda_desde is not null
        and c.cliente_aguarda_desde <= now() - interval '20 minutes'
        and (c.espera_aviso_paciente_em is null or c.espera_aviso_paciente_em < c.cliente_aguarda_desde)
      returning c.id
    loop
      perform public.fluxo_dizer(r.id, public.fluxo_t(case when v_dentro then 'espera_longa_dentro' else 'espera_longa_fora' end, public.fluxo_ctx(r.id)));
      v_avisadas := v_avisadas + 1;
    end loop;
  exception when others then
    v_erro := coalesce(v_erro || '; ', '') || 'aviso: ' || sqlerrm;
  end;
  return jsonb_build_object('alertadas', v_alertadas, 'avisadas', v_avisadas, 'dentro_do_horario', v_dentro, 'erro', v_erro);
end $$;

revoke all on function public.espera_vigiar(), public.horario_trabalho_agora(timestamptz) from public, anon, authenticated;

-- ===== Parte 4: cartão do paciente (sem relógio, sem promessa de "online") =====
-- Devolve só o necessário: se já foi confirmado, quem atende, se está em horário de trabalho e se o aviso de fila já foi dado.
create or replace function public.chat_acompanhar(p_conversa uuid, p_token text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare r jsonb;
begin
  perform public.chat_valida(p_conversa, p_token);
  select jsonb_build_object('conversa', c.status, 'agente', a.nome, 'em_horario', public.horario_trabalho_agora(), 'equipe_online', public.horario_trabalho_agora(),
    'pedido', pa.status, 'tipo', pa.tipo, 'conferencia', pa.conferencia_status,
    'confirmado', coalesce(pa.status = 'agendado' or pa.conferencia_status = 'confirmado', false),
    'espera_longa', coalesce(c.espera_aviso_paciente_em >= c.cliente_aguarda_desde, false),
    'horarios', coalesce((select jsonb_agg(jsonb_build_object('data', e ->> 'data', 'hora', e ->> 'hora', 'unidade', regexp_replace(coalesce(e ->> 'unidade', ''), '^CLÍNICA DE SAÚDE E IMAGEM - ', 'CSI ')) order by (e ->> 'grupo')::int)
                          from jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e), '[]'::jsonb))
    into r
  from public.conversas c left join public.agentes a on a.id = c.agente_id
  left join public.pre_agendamentos pa on pa.conversa_id = c.id
  where c.id = p_conversa;
  return r;
end $$;

-- ===== Parte 5: agendar (a cada minuto). Rodar de novo apenas atualiza o mesmo nome. =====
select cron.schedule('espera-vigia', '* * * * *', $cron$select public.espera_vigiar()$cron$);
