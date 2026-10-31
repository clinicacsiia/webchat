-- FLUXOGRAMA: entrada (código CSI-... e detalhes técnicos enviados pela Sentinela do chat) -> validação (formato do código, token da conversa, limite de gravações por minuto, tamanho do detalhe) -> lógica (grava em incidente_chat sem repetir o código, deixa uma nota na conversa, painel consulta por código; textos do assistente trocados só se ainda forem os originais) -> saída (tabela incidente_chat, chat_incidente, painel_incidentes e textos novos em fluxo_texto)
-- Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
--
-- Fase 9: Sentinela do chat (sentinela.js) + mensagens empáticas.
-- Depende da Fase 7 (public.fluxo_texto, public.fluxo_nota, public.papel_atual, public.conversa_segredo). Pode rodar mais de uma vez.
-- Sem este arquivo o chat funciona igual: a Sentinela guarda os incidentes no aparelho e tenta enviar de novo mais tarde.

-- ===== 1. Incidentes do chat =====
create table if not exists public.incidente_chat (
  id bigint generated always as identity primary key,
  codigo text not null unique,
  tipo text not null,
  conversa_id uuid references public.conversas(id) on delete set null,
  passo text,
  versao text,
  detalhe jsonb not null default '{}'::jsonb,
  criado_em timestamptz not null default now()
);
create index if not exists incidente_chat_criado on public.incidente_chat (criado_em desc);
create index if not exists incidente_chat_conversa on public.incidente_chat (conversa_id);
alter table public.incidente_chat enable row level security;
comment on table public.incidente_chat is 'Problemas vistos pela Sentinela do chat. O paciente recebe o código (CSI-AAMMDD-HHMM-TIPO-XXXX); a equipe acha o caso por ele. Sem texto de mensagem nem dado pessoal.';

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'incidente_chat' and policyname = 'incidente_chat_select') then
    create policy incidente_chat_select on public.incidente_chat for select using ((select public.papel_atual()) = any (array['admin','atendente']));
  end if;
end $$;

-- O chat (anon) grava por esta função; ela valida o formato, limita o volume e só liga o caso à conversa se o token for o da própria conversa.
create or replace function public.chat_incidente(p_conversa uuid, p_token text, p_codigo text, p_tipo text, p_detalhe jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_cod text := upper(btrim(coalesce(p_codigo, '')));
  v_tipo text := upper(btrim(coalesce(p_tipo, '')));
  v_det jsonb := coalesce(p_detalhe, '{}'::jsonb);
  v_conv uuid; v_id bigint;
begin
  if v_cod !~ '^CSI-[0-9]{6}-[0-9]{4}-[A-Z]{3}-[A-Z0-9]{4}$' or v_tipo !~ '^[A-Z]{3}$' then
    return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido');
  end if;
  if (select count(*) from public.incidente_chat where criado_em > now() - interval '1 minute') >= 60 then
    return jsonb_build_object('ok', false, 'motivo', 'limite');
  end if;
  if p_conversa is not null then
    select conversa_id into v_conv from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  end if;
  if jsonb_typeof(v_det) <> 'object' then v_det := '{}'::jsonb; end if;
  if pg_column_size(v_det) > 20000 then v_det := jsonb_build_object('truncado', true, 'rotulo', left(coalesce(v_det ->> 'rotulo', ''), 80)); end if;
  insert into public.incidente_chat (codigo, tipo, conversa_id, passo, versao, detalhe)
  values (v_cod, v_tipo, v_conv, left(v_det ->> 'passo', 40), left(v_det ->> 'app', 40), v_det)
  on conflict (codigo) do nothing returning id into v_id;
  -- Deixa uma nota na conversa para o atendente ver que houve um problema técnico (não vale para o diagnóstico pedido pelo menu).
  if v_id is not null and v_conv is not null and v_tipo <> 'DIA' then
    begin
      perform public.fluxo_nota(v_conv, 'Problema técnico no chat do paciente, código ' || v_cod || ' (' || left(coalesce(v_det ->> 'rotulo', v_tipo), 60) || ')');
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('ok', true, 'codigo', v_cod, 'novo', v_id is not null);
end $$;

-- Painel: achar um caso pelo código (parte do código serve) ou ver os mais recentes.
create or replace function public.painel_incidentes(p_codigo text default null, p_dias integer default 7, p_limite integer default 50)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_busca text := nullif(upper(btrim(coalesce(p_codigo, ''))), '');
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  return coalesce((
    select jsonb_agg(x order by x ->> 'criado_em' desc) from (
      select jsonb_build_object('codigo', i.codigo, 'tipo', i.tipo, 'conversa_id', i.conversa_id, 'passo', i.passo, 'versao', i.versao, 'criado_em', i.criado_em,
                                'rotulo', i.detalhe ->> 'rotulo', 'detalhe', i.detalhe) x
      from public.incidente_chat i
      where (v_busca is not null and i.codigo like '%' || v_busca || '%')
         or (v_busca is null and i.criado_em >= now() - make_interval(days => greatest(1, least(coalesce(p_dias, 7), 90))))
      order by i.criado_em desc limit greatest(1, least(coalesce(p_limite, 50), 200))) q), '[]'::jsonb);
end $$;

revoke all on function public.chat_incidente(uuid, text, text, text, jsonb), public.painel_incidentes(text, integer, integer) from public, anon, authenticated;
grant execute on function public.chat_incidente(uuid, text, text, text, jsonb) to anon, authenticated;
grant execute on function public.painel_incidentes(text, integer, integer) to authenticated;

-- ===== 2. Textos do assistente: IA, pessoa acompanhando, previsão e empatia =====
-- Só troca o texto que ainda é o original da Fase 7. Se a equipe já editou algum, a edição dela fica.
do $$
declare r record;
begin
  for r in select * from (values
    ('ola_proprio',
     $t$Olá, {nome}! Sou o assistente da clínica e vou te ajudar a agendar. É só tocar nas opções.$t$,
     $t$Olá, {nome}! Eu sou o assistente virtual da clínica, uma inteligência artificial (IA). Uma pessoa da equipe acompanha esta conversa e pode falar com você a qualquer momento: é só tocar em "Falar com um atendente". Aqui eu monto uma previsão do seu agendamento para o atendimento ser mais rápido; quem confirma é um atendente. Vamos com calma, é só tocar nas opções.$t$),
    ('ola_filho',
     $t$Olá, {nome}! Vamos agendar para {paciente}. É só tocar nas opções.$t$,
     $t$Olá, {nome}! Eu sou o assistente virtual da clínica, uma inteligência artificial (IA), e vou ajudar a organizar o atendimento de {paciente}. Uma pessoa da equipe acompanha esta conversa e pode falar com você a qualquer momento: é só tocar em "Falar com um atendente". Aqui eu monto uma previsão do agendamento; quem confirma é um atendente. É só tocar nas opções.$t$),
    ('confirmar',
     E'Confira se está tudo certo:\n{resumo}',
     E'Confira se está tudo certo:\n{resumo}\n\nAo confirmar, você envia uma PREVISÃO de agendamento. Quem confirma data, horário e valor é um atendente (uma pessoa da equipe).'),
    ('pronto_online',
     $t$Pronto, {nome}! Recebemos tudo. Um atendente vai conferir, marcar no sistema e confirmar a data, o horário e o valor com você em instantes.$t$,
     $t$Pronto, {nome}! Recebemos tudo e montamos a PREVISÃO do seu agendamento. Atenção: ainda não está confirmado. Um atendente (uma pessoa da equipe) vai conferir, marcar no sistema e te enviar aqui neste chat a confirmação de data, horário e valor. A equipe está online e acompanhando. Se quiser falar com ela, é só escrever a qualquer momento.$t$),
    ('pronto_offline',
     $t$Pronto, {nome}! No momento não estamos online, mas registramos a sua solicitação. Assim que possível um atendente vai atender você já sabendo de tudo.$t$,
     $t$Pronto, {nome}! Montamos a PREVISÃO do seu agendamento e ela já está com a equipe. Ainda não está confirmado: no momento não estamos online, mas assim que possível um atendente (uma pessoa) vai conferir tudo e te enviar a confirmação aqui neste chat. Você pode escrever a qualquer momento.$t$),
    ('transferir_online',
     $t$Um atendente vai continuar com você em instantes.$t$,
     $t$Um atendente (uma pessoa da equipe) vai continuar com você em instantes. Pode escrever aqui a qualquer momento.$t$),
    ('transferir_offline',
     $t$No momento não estamos online, mas registramos a sua solicitação. Assim que possível um atendente vai atender você já sabendo de tudo.$t$,
     $t$No momento não estamos online, mas registramos a sua solicitação. Assim que possível um atendente (uma pessoa) vai atender você já sabendo de tudo. Pode escrever aqui a qualquer momento.$t$),
    ('nao_entendi',
     $t$Não entendi, mas vou informar isso ao atendente. Para continuar, toque numa das opções.$t$,
     $t$Desculpe, não consegui entender. Vou avisar um atendente (uma pessoa) para te ajudar. Para continuar por aqui, toque numa das opções.$t$),
    ('erro',
     $t$Tive um problema aqui. Vou chamar um atendente para continuar com você.$t$,
     $t$Tive um problema aqui e peço desculpas. Vou chamar um atendente (uma pessoa) para continuar com você.$t$)
  ) as t(chave, antigo, novo)
  loop
    update public.fluxo_texto set texto = r.novo where chave = r.chave and texto = r.antigo;
  end loop;
end $$;
