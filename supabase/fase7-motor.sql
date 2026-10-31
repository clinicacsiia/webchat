-- Fase 7: motor de fluxo. O paciente é respondido por regras fixas dentro do banco, na mesma chamada que grava a mensagem
-- (sem n8n e sem IA no caminho). Plano e mapa do processo em docs/plano-fase7-fluxo-sem-ia.md.
-- Liga e desliga por config.motor ('fluxo' | 'ia'); telefones em config.motor_telefones_teste sempre usam o motor.
-- Nenhum comando destrutivo: só tabelas e colunas novas e funções substituídas.

create extension if not exists unaccent with schema extensions;

-- ===== 1. Chaves, colunas e tabelas =====
insert into public.config (chave, valor) values ('motor', 'ia'), ('motor_telefones_teste', '') on conflict (chave) do nothing;

alter table public.conversas add column if not exists motor text not null default 'ia';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'conversas_motor_check') then
    alter table public.conversas add constraint conversas_motor_check check (motor in ('ia', 'fluxo'));
  end if;
end $$;
comment on column public.conversas.motor is 'Quem responde o paciente: ia (fluxo do n8n, antigo) ou fluxo (motor de regras no banco, Fase 7).';
alter table public.agentes add column if not exists visto_em timestamptz;
comment on column public.agentes.visto_em is 'Último sinal do painel aberto (painel_presenca, a cada minuto). Define se a equipe está online.';

create table if not exists public.conversa_fluxo (
  conversa_id uuid primary key references public.conversas(id) on delete cascade,
  passo text,
  tentativas integer not null default 0,
  dados jsonb not null default '{}'::jsonb,
  iniciado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
alter table public.conversa_fluxo enable row level security;
comment on table public.conversa_fluxo is 'Em que passo do roteiro cada conversa está e o que o motor já sabe (motivo, flags dos grupos de dados, notas para o atendente).';

create table if not exists public.fluxo_evento (
  id bigint generated always as identity primary key,
  conversa_id uuid references public.conversas(id) on delete cascade,
  passo text, entrada text, entendido boolean, ms numeric, ms_cliente integer,
  criado_em timestamptz not null default now()
);
create index if not exists fluxo_evento_criado on public.fluxo_evento (criado_em);
alter table public.fluxo_evento enable row level security;
comment on table public.fluxo_evento is 'Uma linha por mensagem tratada pelo motor: passo, tipo de entrada, se entendeu e o tempo (servidor e o que o paciente viu).';

create table if not exists public.fluxo_texto (
  chave text primary key,
  texto text not null,
  descricao text
);
alter table public.fluxo_texto enable row level security;
comment on table public.fluxo_texto is 'Textos do motor, editáveis pela equipe. {nome}, {paciente}, {quem}, {de_quem}, {para_quem} e outros são trocados na hora.';

create table if not exists public.conversa_anexo (
  id bigint generated always as identity primary key,
  conversa_id uuid not null references public.conversas(id) on delete cascade,
  tipo text not null default 'pedido_medico',
  mime text not null,
  dados bytea not null,
  ocr_texto text,
  criado_em timestamptz not null default now()
);
create index if not exists conversa_anexo_conversa on public.conversa_anexo (conversa_id);
alter table public.conversa_anexo enable row level security;
comment on table public.conversa_anexo is 'Foto do pedido médico enviada pelo paciente. Sem policy: o chat grava por chat_anexo_enviar e a equipe lê por painel_anexo.';

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'conversa_fluxo' and policyname = 'conversa_fluxo_select') then
    create policy conversa_fluxo_select on public.conversa_fluxo for select using ((select public.papel_atual()) = any (array['admin','atendente']));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'fluxo_evento' and policyname = 'fluxo_evento_select') then
    create policy fluxo_evento_select on public.fluxo_evento for select using ((select public.papel_atual()) = 'admin');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'fluxo_texto' and policyname = 'fluxo_texto_select') then
    create policy fluxo_texto_select on public.fluxo_texto for select using ((select public.papel_atual()) = any (array['admin','atendente']));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'fluxo_texto' and policyname = 'fluxo_texto_update') then
    create policy fluxo_texto_update on public.fluxo_texto for update using ((select public.papel_atual()) = 'admin') with check ((select public.papel_atual()) = 'admin');
  end if;
end $$;

insert into public.fluxo_texto (chave, texto, descricao) values
 ('ola_proprio', 'Olá, {nome}! Sou o assistente da clínica e vou te ajudar a agendar. É só tocar nas opções.', 'Primeira mensagem (o próprio paciente)'),
 ('ola_filho', 'Olá, {nome}! Vamos agendar para {paciente}. É só tocar nas opções.', 'Primeira mensagem (responsável)'),
 ('identidade', 'Parece que {quem} já tem cadastro na clínica. Para localizar, qual é a data de nascimento{de_quem}?', 'Paciente que volta: pede a data de nascimento'),
 ('identidade_erro', 'Não consegui entender essa data. Escreva no formato dia/mês/ano, por exemplo 25/03/1980.', ''),
 ('atalho', 'Que bom ter {quem} de volta! O que deseja agora?', 'Atalho do paciente que volta'),
 ('atalho_falhou', 'Não consegui copiar o pedido anterior. Vamos escolher de novo, é rapidinho.', ''),
 ('motivo_proprio', 'O que você precisa?', ''),
 ('motivo_filho', 'O que {paciente} precisa?', ''),
 ('exame', 'Escolha o exame. Você pode procurar pelo nome, tirar uma foto do pedido médico ou escolher pelo desenho do corpo.', ''),
 ('consulta', 'Escolha o tipo de consulta{para_quem}.', ''),
 ('medico', 'Tem preferência de médico para {consulta}?', ''),
 ('assunto', 'Sobre o que é?', ''),
 ('assunto_texto', 'Conte em poucas palavras o que você precisa. Um atendente vai ler e continuar com você.', ''),
 ('plano', 'O atendimento será particular ou por convênio?', ''),
 ('plano_outro', 'Anotei o convênio "{plano}". O atendente confere a cobertura.', ''),
 ('horario', 'Agora escolha o dia e o horário que preferir. É uma previsão: o atendente confirma.', ''),
 ('horario_proximo', 'Horário guardado. Falta escolher o horário {grupo} de {total}.', ''),
 ('horario_sem_exame', 'O atendente vai definir o exame exato e combinar o horário com você.', ''),
 ('horario_nenhum', 'Tudo bem, o atendente procura outro horário para você.', ''),
 ('mudou', 'Os dados do cadastro{de_quem} (endereço, telefone, carteirinha) mudaram desde a última vez?', ''),
 ('dados_ident', 'Agora os dados para o cadastro{de_quem}. Primeiro, a identificação:', ''),
 ('dados_contato', 'Agora o telefone para contato:', ''),
 ('dados_endereco', 'Agora o endereço. Digite o CEP que o resto se preenche sozinho:', ''),
 ('dados_carteira', 'Por último, a carteirinha do convênio:', ''),
 ('dados_erro', 'Confira, por favor: {erros}.', ''),
 ('confirmar', E'Confira se está tudo certo:\n{resumo}', ''),
 ('pronto_online', 'Pronto, {nome}! Recebemos tudo. Um atendente vai conferir, marcar no sistema e confirmar a data, o horário e o valor com você em instantes.', ''),
 ('pronto_offline', 'Pronto, {nome}! No momento não estamos online, mas registramos a sua solicitação. Assim que possível um atendente vai atender você já sabendo de tudo.', ''),
 ('transferir_online', 'Um atendente vai continuar com você em instantes.', ''),
 ('transferir_offline', 'No momento não estamos online, mas registramos a sua solicitação. Assim que possível um atendente vai atender você já sabendo de tudo.', ''),
 ('emergencia', 'Isso pode ser uma emergência. Ligue agora para o 192 (SAMU) ou vá ao pronto-socorro mais próximo. Também vou avisar a equipe.', ''),
 ('preco', 'Quem informa o valor é o atendente, depois de conferir o plano e o exame.', ''),
 ('clinico', 'Não consigo dar orientação médica por aqui; a equipe ajuda nisso.', ''),
 ('nao_entendi', 'Não entendi, mas vou informar isso ao atendente. Para continuar, toque numa das opções.', ''),
 ('reaberta', 'Recebemos a sua mensagem. Um atendente vai responder.', ''),
 ('irmao_proximo', 'Quando quiser, toque em "Agendar para {irmao}" aqui embaixo.', ''),
 ('erro', 'Tive um problema aqui. Vou chamar um atendente para continuar com você.', '')
on conflict (chave) do nothing;

-- ===== 2. Utilidades =====
create or replace function public.fluxo_t(p_chave text, p_v jsonb default '{}'::jsonb) returns text
language plpgsql stable security definer set search_path to '' as $$
declare t text; k text; v text;
begin
  select texto into t from public.fluxo_texto where chave = p_chave;
  t := coalesce(t, p_chave);
  for k, v in select key, value from jsonb_each_text(coalesce(p_v, '{}'::jsonb)) loop
    t := replace(t, '{' || k || '}', coalesce(v, ''));
  end loop;
  return t;
end $$;

create or replace function public.fluxo_norm(t text) returns text language sql immutable set search_path to '' as $$
  select btrim(regexp_replace(lower(extensions.unaccent(coalesce(t, ''))), '\s+', ' ', 'g'))
$$;

-- Nome de exame normalizado com as siglas do catálogo (RM, TC, US, RX), dos dois lados da comparação.
create or replace function public.fluxo_norm_exame(t text) returns text language sql stable set search_path to '' as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    coalesce(public.norm_nome(t), ''),
    '\m(RESSONANCIA|RESONANCIA|RESSONANSIA|RNM|RMN)( MAGNETICA)?\M', 'RM', 'g'),
    '\m(TOMOGRAFIA|TOMO)( COMPUTADORIZADA)?\M', 'TC', 'g'),
    '\m(ULTRASSONOGRAFIA|ULTRASONOGRAFIA|ULTRASSOM|ULTRASOM|ULTRA SOM|ECOGRAFIA|USG|ULTRA)\M', 'US', 'g'),
    '\m(RAIO X|RAIOX|RAIO|RADIOGRAFIA|RAIOS X)\M', 'RX', 'g'),
    '\m(DE|DO|DA|DOS|DAS|E|EM|COM|SEM|PARA|P)\M', ' ', 'g')
$$;

create or replace function public.fluxo_cpf_ok(p text) returns boolean language plpgsql immutable set search_path to '' as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g'); s int; r int; i int;
begin
  if length(d) <> 11 or d ~ '^(\d)\1{10}$' then return false; end if;
  s := 0; for i in 1..9 loop s := s + substr(d, i, 1)::int * (11 - i); end loop;
  r := (s * 10) % 11; if r = 10 then r := 0; end if;
  if r <> substr(d, 10, 1)::int then return false; end if;
  s := 0; for i in 1..10 loop s := s + substr(d, i, 1)::int * (12 - i); end loop;
  r := (s * 10) % 11; if r = 10 then r := 0; end if;
  return r = substr(d, 11, 1)::int;
end $$;

-- Data digitada: 25/03/1980, 25-3-80, 25.03.1980, 25031980, 1980-03-25 ou "25 de março de 1980".
create or replace function public.fluxo_ler_data(p text) returns date language plpgsql stable set search_path to '' as $$
declare t text := public.fluxo_norm(p); m text[]; d int; mm int; a int;
  meses text[] := array['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
begin
  if t ~ '^\d{4}-\d{2}-\d{2}$' then return t::date; end if;
  m := regexp_match(t, '(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{2,4})');
  if m is null then m := regexp_match(t, '^(\d{2})(\d{2})(\d{4})$'); end if;
  if m is null then
    m := regexp_match(t, '(\d{1,2}) de ([a-z]+) de (\d{4})');
    if m is not null then
      mm := array_position(meses, m[2]);
      if mm is null then return null; end if;
      m[2] := mm::text;
    end if;
  end if;
  if m is null then return null; end if;
  d := m[1]::int; mm := m[2]::int; a := m[3]::int;
  if a < 100 then a := case when a > extract(year from current_date)::int % 100 then 1900 + a else 2000 + a end; end if;
  if mm not between 1 and 12 or d not between 1 and 31 then return null; end if;
  begin return make_date(a, mm, d); exception when others then return null; end;
end $$;

create or replace function public.fluxo_equipe_online() returns boolean language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.agentes where ativo and papel in ('admin', 'atendente') and visto_em > now() - interval '3 minutes')
$$;

create or replace function public.fluxo_ctx(p_conversa uuid) returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare c record; v_nome text; v_pac text; v_filho boolean;
begin
  select coalesce(nullif(btrim(cv.nome_informado), ''), ct.nome) as nome, cv.paciente_tipo, cv.paciente_nome, cv.irmaos, cv.irmaos_modo
    into c from public.conversas cv join public.contatos ct on ct.id = cv.contato_id where cv.id = p_conversa;
  v_nome := initcap(lower(split_part(btrim(coalesce(c.nome, '')), ' ', 1)));
  v_filho := c.paciente_tipo = 'filho';
  v_pac := initcap(lower(split_part(btrim(coalesce(c.paciente_nome, '')), ' ', 1)));
  if v_filho and v_pac = '' then v_pac := 'seu filho(a)'; end if;
  return jsonb_build_object('nome', v_nome, 'paciente', v_pac, 'filho', v_filho,
    'quem', case when v_filho then v_pac else 'você' end,
    'de_quem', case when v_filho then ' de ' || v_pac else '' end,
    'para_quem', case when v_filho then ' para ' || v_pac else '' end,
    'irmao', coalesce(initcap(lower(split_part(btrim(c.irmaos ->> 0), ' ', 1))), ''));
end $$;

create or replace function public.fluxo_dizer(p_conversa uuid, p_texto text, p_opcoes jsonb default null) returns bigint
language plpgsql security definer set search_path to '' as $$
declare v_id bigint;
begin
  insert into public.mensagens (conversa_id, autor, texto, opcoes)
  values (p_conversa, 'agente', left(coalesce(nullif(btrim(p_texto), ''), '…'), 4000), p_opcoes) returning id into v_id;
  return v_id;
end $$;

create or replace function public.fluxo_escolha(p_passo text, p_itens jsonb, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql immutable set search_path to '' as $$
  select jsonb_build_object('tipo', 'escolha', 'passo', p_passo, 'itens', p_itens, 'multipla', false,
                            'filtro', jsonb_array_length(p_itens) > 7) || coalesce(p_extra, '{}'::jsonb)
$$;

create or replace function public.fluxo_procs(p_conversa uuid) returns integer[] language sql stable security definer set search_path to '' as $$
  select array_agg(i.procedimento_id order by i.id) from public.pre_agendamento_itens i, lateral generate_series(1, i.quantidade) g
  where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null
$$;

-- Médicos que atendem a consulta escolhida, na unidade da conversa (mesma regra de chat_consultas).
create or replace function public.fluxo_medicos(p_conversa uuid) returns text[] language sql stable security definer set search_path to '' as $$
  select x.medicos from public.conversas c
  left join public.unidade_config u on u.chave = c.unidade_inicial
  join public.pre_agendamento_itens i on i.conversa_id = c.id and i.ativo and i.modalidade = 'CONSULTA'
  cross join lateral public.consultas_da_unidade(u.catalogo) x
  where c.id = p_conversa and x.id = i.procedimento_id
  limit 1
$$;

create or replace function public.fluxo_set(p_conversa uuid, p_dados jsonb) returns void language sql security definer set search_path to '' as $$
  update public.conversa_fluxo set dados = dados || p_dados, atualizado_em = now() where conversa_id = p_conversa
$$;

create or replace function public.fluxo_nota(p_conversa uuid, p_nota text) returns void language sql security definer set search_path to '' as $$
  update public.conversa_fluxo set dados = jsonb_set(dados, '{notas}', coalesce(dados -> 'notas', '[]'::jsonb) || to_jsonb(left(p_nota, 300))), atualizado_em = now()
  where conversa_id = p_conversa
$$;

-- Grava no pré-agendamento pela mesma função que a IA usava (conferência de identidade, cadastro do paciente, reaproveitar).
create or replace function public.fluxo_pre(p_conversa uuid, p_dados jsonb, p_pronto boolean default false) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_seg text;
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  return public.ia_pre_agendar(v_seg, p_conversa, p_dados, p_pronto);
end $$;

-- ===== 3. Resumo e transferência para a equipe =====
create or replace function public.fluxo_resumo(p_conversa uuid) returns text language plpgsql stable security definer set search_path to '' as $$
declare pa public.pre_agendamentos; d jsonb; v text[] := '{}'; x text;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  d := coalesce(d, '{}'::jsonb);
  select string_agg(coalesce(public.fluxo_rotulo_item(p_conversa, i.procedimento_id, i.procedimento, i.modalidade), i.modalidade) || case i.lado when 'D' then ' (D)' when 'E' then ' (E)' when 'A' then ' (ambos)' else '' end, ' + ' order by i.id)
    into x from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo;
  if x is not null then v := v || ('Pedido: ' || x); end if;
  if pa.plano is not null then v := v || ('Plano: ' || pa.plano); end if;
  if pa.profissional is not null then v := v || ('Médico: ' || pa.profissional); end if;
  select string_agg(to_char((e ->> 'data')::date, 'DD/MM') || ' ' || (e ->> 'hora') || coalesce(' ' || regexp_replace(e ->> 'unidade', '^CLÍNICA DE SAÚDE E IMAGEM - ', ''), ''), '; ' order by (e ->> 'grupo')::int)
    into x from jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e;
  if x is not null then v := v || ('Horário escolhido (previsão): ' || x); end if;
  if pa.identidade is not null then v := v || ('Cadastro: ' || case pa.identidade when 'conferida' then 'paciente conhecido, data de nascimento conferida'
      when 'divergente' then 'data de nascimento NÃO conferiu' when 'atualizar' then 'conhecido, atualizar dados' when 'aguardando' then 'aguardando conferência' else 'paciente novo' end); end if;
  if d ->> 'assunto' is not null then v := v || ('Assunto: ' || (d ->> 'assunto') || coalesce(' — ' || (d ->> 'assunto_texto'), '')); end if;
  select string_agg(n, ' | ') into x from jsonb_array_elements_text(coalesce(d -> 'notas', '[]'::jsonb)) n;
  if x is not null then v := v || ('Observações: ' || x); end if;
  return array_to_string(v, E'\n');
end $$;

create or replace function public.fluxo_transferir(p_conversa uuid, p_motivo text, p_urgencia text default 'baixa', p_avisar boolean default true) returns void
language plpgsql security definer set search_path to '' as $$
declare v_url text; v_tok text; v_headers jsonb; v_ctx jsonb; v_on boolean := public.fluxo_equipe_online();
begin
  update public.conversas set ia_ativa = false,
    triagem_resumo = left(btrim(coalesce(p_motivo, '') || E'\n' || coalesce(public.fluxo_resumo(p_conversa), '')), 1000),
    triagem_urgencia = case when p_urgencia in ('baixa','media','alta') then p_urgencia else 'baixa' end
  where id = p_conversa;
  update public.conversa_fluxo set passo = case when passo = 'pronto' then 'pronto' else 'humano' end,
    dados = dados || jsonb_build_object('transferido_em', now()), atualizado_em = now() where conversa_id = p_conversa;
  if p_avisar then
    perform public.fluxo_dizer(p_conversa, public.fluxo_t(case when v_on then 'transferir_online' else 'transferir_offline' end, public.fluxo_ctx(p_conversa)),
                               jsonb_build_object('tipo', 'acompanhar'));
  end if;
  -- Aviso à equipe (WhatsApp/e-mail) fica no n8n; aqui só o evento, sem dado de saúde.
  select valor into v_url from public.config where chave = 'n8n_webhook_url';
  if coalesce(v_url, '') <> '' then
    select valor into v_tok from public.config where chave = 'n8n_webhook_token';
    v_headers := '{"Content-Type":"application/json"}'::jsonb || case when coalesce(v_tok, '') <> '' then jsonb_build_object('x-webhook-token', v_tok) else '{}'::jsonb end;
    v_ctx := public.fluxo_ctx(p_conversa);
    begin
      perform net.http_post(url := v_url, headers := v_headers,
        body := jsonb_build_object('evento', 'transferencia', 'conversa_id', p_conversa, 'nome', v_ctx ->> 'nome', 'motivo', split_part(coalesce(p_motivo, ''), E'\n', 1),
                                   'urgencia', p_urgencia, 'equipe_online', v_on));
    exception when others then null;
    end;
  end if;
end $$;

-- ===== 4. Próximo passo (decidido pelo que já está gravado) =====
create or replace function public.fluxo_proximo(p_conversa uuid) returns text language plpgsql security definer set search_path to '' as $$
declare d jsonb; pa public.pre_agendamentos; n_itens int; v_conf jsonb; v_hist jsonb; v_procs int[]; v_med text[];
begin
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  d := coalesce(d, '{}'::jsonb);
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select count(*) into n_itens from public.pre_agendamento_itens where conversa_id = p_conversa and ativo;

  if not coalesce((d ->> 'identidade_feita')::boolean, false) then
    v_conf := public.paciente_conferir(p_conversa);
    if v_conf ->> 'situacao' = 'completo' and v_conf ->> 'dt_nasc_conferida' is null then return 'identidade'; end if;
    perform public.fluxo_set(p_conversa, '{"identidade_feita": true}');
  end if;
  if not coalesce((d ->> 'atalho_feito')::boolean, false) then
    perform public.fluxo_set(p_conversa, '{"atalho_feito": true}');
    if n_itens = 0 then
      v_hist := public.paciente_historico_para_ia(p_conversa);
      if coalesce((v_hist ->> 'liberado')::boolean, false)
         and (jsonb_array_length(coalesce(v_hist -> 'ultimas', '[]'::jsonb)) > 0 or jsonb_typeof(v_hist -> 'pedido_pela_metade') = 'object') then
        return 'atalho';
      end if;
    end if;
  end if;
  if d ->> 'motivo' = 'assunto' then
    return case when d ->> 'assunto' is null then 'assunto' else 'assunto_texto' end;
  end if;
  if n_itens = 0 and d ->> 'motivo' is null then return 'motivo'; end if;
  if n_itens = 0 or d ->> 'refazer' = 'pedido' then
    return case when coalesce(d ->> 'motivo', pa.tipo) = 'consulta' then 'consulta' else 'exame' end;
  end if;
  if pa.tipo = 'consulta' and not coalesce((d ->> 'medico_feito')::boolean, false)
     and not exists (select 1 from public.conversas cv where cv.id = p_conversa and cv.irmao_de is not null and cv.irmaos_modo = 'juntos') then
    v_med := public.fluxo_medicos(p_conversa);
    if coalesce(cardinality(v_med), 0) > 1 then return 'medico'; end if;
    perform public.fluxo_set(p_conversa, '{"medico_feito": true}');
  end if;
  if pa.plano is null then return 'plano'; end if;
  v_procs := public.fluxo_procs(p_conversa);
  if v_procs is not null and not coalesce((d ->> 'sem_horario')::boolean, false)
     and jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) < jsonb_array_length(public.agenda_grupos(v_procs)) then
    return 'horario';
  end if;
  if pa.identidade in ('conferida', 'atualizar') and d ->> 'mudou' is null then return 'mudou'; end if;
  if not coalesce((d ->> 'g_ident')::boolean, false) then return 'dados_ident'; end if;
  if not coalesce((d ->> 'g_contato')::boolean, false) then return 'dados_contato'; end if;
  if not coalesce((d ->> 'g_endereco')::boolean, false) then return 'dados_endereco'; end if;
  if lower(coalesce(pa.plano, '')) <> 'particular' and not coalesce((d ->> 'g_carteira')::boolean, false) then return 'dados_carteira'; end if;
  if not coalesce((d ->> 'confirmado')::boolean, false) then return 'confirmar'; end if;
  return 'pronto';
end $$;

-- ===== 5. Pergunta de cada passo =====
create or replace function public.fluxo_perguntar(p_conversa uuid, p_passo text, p_prefixo text default null) returns void
language plpgsql security definer set search_path to '' as $$
declare
  ctx jsonb := public.fluxo_ctx(p_conversa); c public.conversas; pa public.pre_agendamentos; d jsonb;
  v_txt text; v_op jsonb; v_hist jsonb; v_it jsonb := '[]'::jsonb; v_ult jsonb; v_pend jsonb; v_med text[]; v_nome text; v_tel text; x text; v_dig jsonb;
  v_etapa text;
begin
  select * into c from public.conversas where id = p_conversa;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  d := coalesce(d, '{}'::jsonb); v_dig := coalesce(d -> 'digitado', '{}'::jsonb);

  case p_passo
  when 'identidade' then
    v_txt := public.fluxo_t('identidade', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'pular', 'Prefiro não informar agora',
      'campos', jsonb_build_array(jsonb_build_object('nome', 'dt_nasc', 'rotulo', 'Data de nascimento' || (ctx ->> 'de_quem'), 'tipo', 'data', 'obrigatorio', true)));
  when 'atalho' then
    v_hist := public.paciente_historico_para_ia(p_conversa);
    v_ult := v_hist -> 'ultimas' -> 0; v_pend := v_hist -> 'pedido_pela_metade';
    v_txt := public.fluxo_t('atalho', ctx);
    if v_ult is not null and jsonb_array_length(coalesce(v_ult -> 'exames', '[]'::jsonb)) > 0 then
      select string_agg(coalesce(e ->> 'exame', e ->> 'modalidade') || coalesce(' (' || (e ->> 'lado') || ')', ''), ' + ') into x from jsonb_array_elements(v_ult -> 'exames') e;
      if coalesce((v_ult ->> 'futuro')::boolean, false) then
        v_txt := v_txt || E'\n' || format('Você já tem %s marcado para %s.', x, v_ult ->> 'quando');
      else
        v_it := v_it || jsonb_build_object('valor', 'ultimo', 'rotulo', 'Repetir o último exame', 'desc', x || ' — ' || (v_ult ->> 'quando'));
      end if;
    end if;
    if jsonb_typeof(v_pend) = 'object' and v_pend ->> 'status' <> 'pronto' then
      select string_agg(coalesce(e ->> 'exame', e ->> 'modalidade'), ' + ') into x from jsonb_array_elements(coalesce(v_pend -> 'exames', '[]'::jsonb)) e;
      v_it := v_it || jsonb_build_object('valor', 'pendente', 'rotulo', 'Continuar o pedido que ficou pela metade', 'desc', coalesce(x, ''));
    end if;
    v_it := v_it || jsonb_build_object('valor', 'outro', 'rotulo', 'Fazer outro pedido');
    v_op := public.fluxo_escolha(p_passo, v_it);
  when 'motivo' then
    v_txt := public.fluxo_t(case when (ctx ->> 'filho')::boolean then 'motivo_filho' else 'motivo_proprio' end, ctx);
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'exame', 'rotulo', 'Exame', 'desc', 'Ressonância, tomografia, ultrassom, raio-X, mamografia e outros'),
      jsonb_build_object('valor', 'consulta', 'rotulo', 'Consulta', 'desc', case when (ctx ->> 'filho')::boolean then 'Pediatria e especialidades' else 'Com médico ou especialista' end),
      jsonb_build_object('valor', 'assunto', 'rotulo', 'Outro assunto', 'desc', 'Remarcar, cancelar, resultado de exame, dúvida')));
  when 'exame' then
    v_txt := public.fluxo_t('exame', ctx);
    v_op := jsonb_build_object('tipo', 'busca_exame', 'passo', p_passo, 'termo', d ->> 'termo');
  when 'consulta' then
    v_txt := public.fluxo_t('consulta', ctx);
    v_op := jsonb_build_object('tipo', 'pedido_consulta', 'passo', p_passo);
  when 'medico' then
    v_med := public.fluxo_medicos(p_conversa);
    select coalesce(jsonb_agg(jsonb_build_object('valor', m, 'rotulo', initcap(lower(m))) order by m), '[]'::jsonb) into v_it from unnest(v_med) m;
    select lower(x2.rotulo) into x from public.pre_agendamento_itens i
      cross join lateral public.consultas_da_unidade((select u.catalogo from public.unidade_config u where u.chave = c.unidade_inicial)) x2
      where i.conversa_id = p_conversa and i.ativo and i.modalidade = 'CONSULTA' and x2.id = i.procedimento_id limit 1;
    v_txt := public.fluxo_t('medico', ctx || jsonb_build_object('consulta', coalesce(x, 'a consulta')));
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', '', 'rotulo', 'Tanto faz (qualquer médico)')) || v_it);
  when 'assunto' then
    v_txt := public.fluxo_t('assunto', ctx);
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'Remarcar', 'rotulo', 'Remarcar um horário'), jsonb_build_object('valor', 'Cancelar', 'rotulo', 'Cancelar um horário'),
      jsonb_build_object('valor', 'Resultado de exame', 'rotulo', 'Resultado de exame'), jsonb_build_object('valor', 'Dúvida', 'rotulo', 'Tirar uma dúvida'),
      jsonb_build_object('valor', 'Reclamação', 'rotulo', 'Reclamação ou sugestão'), jsonb_build_object('valor', 'Outro', 'rotulo', 'Outro assunto')));
  when 'assunto_texto' then
    v_txt := public.fluxo_t('assunto_texto', ctx);
    v_op := jsonb_build_object('tipo', 'texto', 'passo', p_passo, 'texto_livre', true, 'placeholder', 'Escreva aqui');
  when 'plano' then
    v_txt := public.fluxo_t('plano', ctx);
    select coalesce(jsonb_agg(jsonb_build_object('valor', o.operadora, 'rotulo', initcap(lower(o.operadora))) order by o.n desc, o.operadora), '[]'::jsonb) into v_it
    from (select operadora, count(*) n from public.catalogo_plano where coalesce(ativo, true) and operadora !~* '^(teste|particular)$' group by operadora) o;
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'Particular', 'rotulo', 'Particular (sem convênio)')) || v_it,
      jsonb_build_object('filtro', true, 'outro', jsonb_build_object('rotulo', 'Meu convênio não está na lista', 'placeholder', 'Nome do convênio')));
  when 'horario' then
    v_txt := public.fluxo_t('horario', ctx);
    if jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) > 0 then
      v_txt := public.fluxo_t('horario_proximo', jsonb_build_object('grupo', jsonb_array_length(pa.escolha_horario) + 1,
                                                                    'total', jsonb_array_length(public.agenda_grupos(public.fluxo_procs(p_conversa)))));
    end if;
    v_op := jsonb_build_object('tipo', 'calendario', 'passo', p_passo, 'grupo', jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) + 1,
      'acoes', jsonb_build_array(jsonb_build_object('valor', 'sem_horario', 'rotulo', 'Nenhum horário serve para mim')));
  when 'mudou' then
    v_txt := public.fluxo_t('mudou', ctx);
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'igual', 'rotulo', 'Não, continuam os mesmos'),
                                                            jsonb_build_object('valor', 'mudou', 'rotulo', 'Sim, algo mudou')));
  when 'dados_ident' then
    v_nome := coalesce(v_dig ->> 'nome', case when (ctx ->> 'filho')::boolean then c.paciente_nome else c.nome_informado end);
    v_txt := public.fluxo_t('dados_ident', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'nome', 'rotulo', 'Nome completo' || (ctx ->> 'de_quem'), 'tipo', 'texto', 'obrigatorio', true, 'valor', v_nome),
      jsonb_build_object('nome', 'sexo', 'rotulo', 'Sexo', 'tipo', 'sexo', 'obrigatorio', true, 'valor', v_dig ->> 'sexo'),
      jsonb_build_object('nome', 'dt_nasc', 'rotulo', 'Data de nascimento', 'tipo', 'data', 'obrigatorio', true, 'valor', v_dig ->> 'dt_nasc'),
      jsonb_build_object('nome', 'mae', 'rotulo', 'Nome da mãe', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'mae'),
      jsonb_build_object('nome', 'cpf', 'rotulo', case when (ctx ->> 'filho')::boolean then 'CPF da criança (ou do responsável, se ela não tiver)' else 'CPF' end,
                         'tipo', 'cpf', 'obrigatorio', false, 'valor', v_dig ->> 'cpf'),
      jsonb_build_object('nome', 'rg', 'rotulo', 'RG', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'rg')));
  when 'dados_contato' then
    select ct.telefone into v_tel from public.contatos ct where ct.id = c.contato_id;
    v_txt := public.fluxo_t('dados_contato', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'celular', 'rotulo', 'Celular (WhatsApp)', 'tipo', 'tel', 'obrigatorio', true, 'valor', coalesce(v_dig ->> 'celular', v_tel)),
      jsonb_build_object('nome', 'telefone', 'rotulo', 'Outro telefone', 'tipo', 'tel', 'obrigatorio', false, 'valor', v_dig ->> 'telefone')));
  when 'dados_endereco' then
    v_txt := public.fluxo_t('dados_endereco', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'pular', 'Não sei agora (o atendente completa)', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'cep', 'rotulo', 'CEP', 'tipo', 'cep', 'obrigatorio', false, 'valor', v_dig ->> 'cep'),
      jsonb_build_object('nome', 'endereco', 'rotulo', 'Rua', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'endereco'),
      jsonb_build_object('nome', 'numero', 'rotulo', 'Número', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'numero'),
      jsonb_build_object('nome', 'complemento', 'rotulo', 'Complemento', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'complemento'),
      jsonb_build_object('nome', 'bairro', 'rotulo', 'Bairro', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'bairro'),
      jsonb_build_object('nome', 'cidade', 'rotulo', 'Cidade', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'cidade'),
      jsonb_build_object('nome', 'uf', 'rotulo', 'UF', 'tipo', 'uf', 'obrigatorio', false, 'valor', v_dig ->> 'uf')));
  when 'dados_carteira' then
    v_txt := public.fluxo_t('dados_carteira', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'pular', 'Não estou com a carteirinha agora', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'matricula', 'rotulo', 'Número da carteirinha (' || coalesce(initcap(lower(pa.plano)), 'convênio') || ')', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'matricula'),
      jsonb_build_object('nome', 'validade', 'rotulo', 'Validade', 'tipo', 'data', 'obrigatorio', false, 'valor', v_dig ->> 'validade')));
  when 'confirmar' then
    v_txt := public.fluxo_t('confirmar', ctx || jsonb_build_object('resumo', public.fluxo_leitura(p_conversa)));
    v_it := jsonb_build_array(jsonb_build_object('valor', 'ok', 'rotulo', 'Está tudo certo'),
      jsonb_build_object('valor', 'pedido', 'rotulo', case when pa.tipo = 'consulta' then 'Corrigir a consulta' else 'Corrigir o exame' end),
      jsonb_build_object('valor', 'plano', 'rotulo', 'Corrigir o plano'));
    if jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) > 0 then v_it := v_it || jsonb_build_object('valor', 'horario', 'rotulo', 'Corrigir o horário'); end if;
    v_it := v_it || jsonb_build_object('valor', 'dados', 'rotulo', 'Corrigir os dados do cadastro');
    v_op := public.fluxo_escolha(p_passo, v_it);
  else
    return;
  end case;

  if p_prefixo is not null and btrim(p_prefixo) <> '' then v_txt := btrim(p_prefixo) || E'\n\n' || v_txt; end if;
  perform public.fluxo_dizer(p_conversa, v_txt, v_op);
  update public.conversa_fluxo set tentativas = case when passo is distinct from p_passo then 0 else tentativas end, passo = p_passo, atualizado_em = now()
  where conversa_id = p_conversa;
  v_etapa := case when p_passo in ('motivo','exame','consulta','atalho','medico') then 'pedido' when p_passo = 'plano' then 'plano' when p_passo = 'horario' then 'data_hora'
                  when p_passo in ('mudou','dados_ident','dados_contato','dados_endereco','dados_carteira','identidade') then 'dados' when p_passo = 'confirmar' then 'confirmacao' end;
  if v_etapa is not null then update public.pre_agendamentos set etapa = v_etapa where conversa_id = p_conversa and status = 'rascunho'; end if;
end $$;

-- Nome do item para o paciente: a consulta aparece como no cadastro da unidade ("Consulta de Pediatria"), o exame pelo nome.
create or replace function public.fluxo_rotulo_item(p_conversa uuid, p_proc integer, p_nome text, p_mod text) returns text
language sql stable security definer set search_path to '' as $$
  select coalesce(
    case when p_mod = 'CONSULTA' then (select x.rotulo from public.conversas c
                                        cross join lateral public.consultas_da_unidade((select u.catalogo from public.unidade_config u where u.chave = c.unidade_inicial)) x
                                        where c.id = p_conversa and x.id = p_proc limit 1) end,
    initcap(lower(p_nome)), p_mod)
$$;

-- Leitura de volta (passo confirmar). Do paciente, só o que foi digitado nesta conversa: o cadastro guardado nunca é mostrado.
create or replace function public.fluxo_leitura(p_conversa uuid) returns text language plpgsql stable security definer set search_path to '' as $$
declare pa public.pre_agendamentos; c public.conversas; d jsonb; p jsonb; v text[] := '{}'; x text; v_dias text[] := array['dom','seg','ter','qua','qui','sex','sáb'];
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select * into c from public.conversas where id = p_conversa;
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  p := coalesce(d -> 'digitado', '{}'::jsonb);
  select string_agg('• ' || coalesce(public.fluxo_rotulo_item(p_conversa, i.procedimento_id, i.procedimento, i.modalidade), 'o atendente define o exame')
                    || case i.lado when 'D' then ' — lado direito' when 'E' then ' — lado esquerdo' when 'A' then ' — os dois lados' else '' end, E'\n' order by i.id)
    into x from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo;
  if x is not null then v := v || (case when pa.tipo = 'consulta' then 'Consulta:' else 'Exames:' end || E'\n' || x); end if;
  if pa.profissional is not null then v := v || ('Médico: ' || initcap(lower(pa.profissional))); end if;
  v := v || ('Plano: ' || coalesce(initcap(lower(pa.plano)), '—'));
  select string_agg(v_dias[extract(dow from (e ->> 'data')::date)::int + 1] || ' ' || to_char((e ->> 'data')::date, 'DD/MM') || ' às ' || (e ->> 'hora')
                    || coalesce(' — ' || regexp_replace(e ->> 'unidade', '^CLÍNICA DE SAÚDE E IMAGEM - ', 'CSI '), ''), E'\n' order by (e ->> 'grupo')::int)
    into x from jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e;
  v := v || ('Horário (previsão): ' || coalesce(x, 'o atendente combina com você'));
  v := v || ('Paciente: ' || coalesce(p ->> 'nome', case when c.paciente_tipo = 'filho' then c.paciente_nome else c.nome_informado end, '—')
             || coalesce(', nascimento ' || (p ->> 'dt_nasc'), ''));
  if d ->> 'mudou' = 'igual' then v := v || 'Cadastro: os mesmos dados da última vez'::text; end if;
  if p ->> 'cpf' is not null then v := v || ('CPF: ' || (p ->> 'cpf')); end if;
  if p ->> 'mae' is not null then v := v || ('Mãe: ' || (p ->> 'mae')); end if;
  if p ->> 'celular' is not null then v := v || ('Celular: ' || (p ->> 'celular')); end if;
  if p ->> 'endereco' is not null or p ->> 'cep' is not null then
    v := v || ('Endereço: ' || concat_ws(', ', p ->> 'endereco', p ->> 'numero', p ->> 'complemento', p ->> 'bairro', p ->> 'cidade', upper(p ->> 'uf'), p ->> 'cep'));
  end if;
  if p ->> 'matricula' is not null then v := v || ('Carteirinha: ' || (p ->> 'matricula') || coalesce(' (validade ' || (p ->> 'validade') || ')', '')); end if;
  return array_to_string(v, E'\n');
end $$;

-- ===== 6. Aplicar uma resposta estruturada (botão ou formulário) =====
create or replace function public.fluxo_aplicar(p_conversa uuid, p_passo text, p_valor jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v text := case when jsonb_typeof(p_valor) = 'string' then p_valor #>> '{}' else null end;
  o jsonb := case when jsonb_typeof(p_valor) = 'object' then p_valor else '{}'::jsonb end;
  c public.conversas; pa public.pre_agendamentos; ctx jsonb := public.fluxo_ctx(p_conversa);
  v_dt date; v_pac jsonb := '{}'::jsonb; v_err text[] := '{}'; v_ok boolean; v_med text[]; k text; x text; v_uni text;
begin
  select * into c from public.conversas where id = p_conversa;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  case p_passo
  when 'identidade' then
    if coalesce((o ->> 'pular')::boolean, false) then perform public.fluxo_set(p_conversa, '{"identidade_feita": true}'); return '{"ok": true}'; end if;
    v_dt := public.fluxo_ler_data(o ->> 'dt_nasc');
    if v_dt is null or v_dt > current_date or v_dt < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', public.fluxo_t('identidade_erro')); end if;
    perform public.fluxo_pre(p_conversa, jsonb_build_object('paciente', jsonb_build_object('dt_nasc', v_dt::text)));
    perform public.fluxo_set(p_conversa, jsonb_build_object('identidade_feita', true, 'digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb) || jsonb_build_object('dt_nasc', to_char(v_dt, 'DD/MM/YYYY'))));
  when 'atalho' then
    if v in ('ultimo', 'pendente') then
      v_ok := public.pre_reaproveitar(p_conversa, v);
      if v_ok then perform public.fluxo_set(p_conversa, '{"motivo": "exame"}');
      else return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('atalho_falhou')); end if;
    elsif v is distinct from 'outro' then return '{"ok": false}';
    end if;
  when 'motivo' then
    if v not in ('exame', 'consulta', 'assunto') then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('motivo', v));
    if v = 'consulta' then
      -- Consulta de criança é na Desenvoar (pediatria); de adulto, na CSI. Exames: todas as unidades, o calendário mostra onde.
      select u.chave into v_uni from public.unidade_config u
       where u.ativo and u.fluxo = case when (ctx ->> 'filho')::boolean then 'pediatria' else 'exame_consulta' end order by u.ordem limit 1;
      update public.conversas set unidade_inicial = v_uni where id = p_conversa;
    elsif v = 'exame' then
      update public.conversas set unidade_inicial = null where id = p_conversa;
    end if;
  when 'medico' then
    v_med := public.fluxo_medicos(p_conversa);
    if coalesce(v, '') <> '' and not (v = any(coalesce(v_med, '{}'))) then return '{"ok": false}'; end if;
    update public.conversas set medico_preferido = nullif(v, '') where id = p_conversa;
    if coalesce(v, '') <> '' then perform public.fluxo_pre(p_conversa, jsonb_build_object('profissional', v)); end if;
    perform public.fluxo_set(p_conversa, '{"medico_feito": true}');
  when 'assunto' then
    if coalesce(v, '') = '' then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('assunto', left(v, 60)));
  when 'assunto_texto' then
    x := btrim(coalesce(v, o ->> 'texto', ''));
    if x = '' then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_texto', left(x, 500)));
    return '{"ok": true, "transferir": true}';
  when 'plano' then
    x := btrim(coalesce(v, o ->> 'outro', ''));
    if x = '' then return '{"ok": false}'; end if;
    perform public.fluxo_pre(p_conversa, jsonb_build_object('plano', left(x, 120), 'etapa', 'plano'));
    if o ->> 'outro' is not null then
      perform public.fluxo_nota(p_conversa, 'Convênio digitado pelo paciente (fora da lista): ' || x);
      perform public.fluxo_set(p_conversa, '{"confirmado": false}');
      return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('plano_outro', jsonb_build_object('plano', left(x, 120))));
    end if;
  when 'horario' then
    if v = 'sem_horario' then
      perform public.fluxo_set(p_conversa, '{"sem_horario": true}');
      perform public.fluxo_nota(p_conversa, 'Nenhum horário do calendário serviu: procurar outro com o paciente');
      return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('horario_nenhum'));
    end if;
    return '{"ok": false}';
  when 'mudou' then
    if v = 'igual' then perform public.fluxo_set(p_conversa, '{"mudou": "igual", "g_ident": true, "g_contato": true, "g_endereco": true}');
    elsif v = 'mudou' then perform public.fluxo_set(p_conversa, '{"mudou": "mudou"}');
    else return '{"ok": false}'; end if;
  when 'dados_ident', 'dados_contato', 'dados_endereco', 'dados_carteira' then
    if coalesce((o ->> 'pular')::boolean, false) and p_passo in ('dados_endereco', 'dados_carteira') then
      perform public.fluxo_set(p_conversa, jsonb_build_object(case p_passo when 'dados_endereco' then 'g_endereco' else 'g_carteira' end, true));
      perform public.fluxo_nota(p_conversa, case p_passo when 'dados_endereco' then 'Endereço não informado' else 'Carteirinha não informada' end);
      return '{"ok": true}';
    end if;
    foreach k in array case p_passo
        when 'dados_ident' then array['nome','sexo','dt_nasc','mae','cpf','rg']
        when 'dados_contato' then array['celular','telefone']
        when 'dados_endereco' then array['cep','endereco','numero','complemento','bairro','cidade','uf']
        else array['matricula','validade'] end loop
      x := nullif(btrim(coalesce(o ->> k, '')), '');
      if x is null then continue; end if;
      if k in ('dt_nasc', 'validade') then
        v_dt := public.fluxo_ler_data(x);
        if v_dt is null or (k = 'dt_nasc' and (v_dt > current_date or v_dt < date '1900-01-01')) then
          v_err := array_append(v_err, case k when 'dt_nasc' then 'a data de nascimento' else 'a validade' end); continue;
        end if;
        x := v_dt::text;
      elsif k = 'cpf' then
        if not public.fluxo_cpf_ok(x) then v_err := array_append(v_err, 'o CPF (os números não conferem)'::text); continue; end if;
      elsif k in ('celular', 'telefone') then
        x := regexp_replace(x, '\D', '', 'g');
        if length(x) not in (10, 11) then v_err := array_append(v_err, case k when 'celular' then 'o celular (DDD + número)' else 'o outro telefone' end); continue; end if;
      elsif k = 'cep' then
        x := regexp_replace(x, '\D', '', 'g');
        if length(x) <> 8 then v_err := array_append(v_err, 'o CEP (8 números)'::text); continue; end if;
      elsif k = 'sexo' then
        x := upper(left(x, 1));
        if x not in ('M', 'F') then v_err := array_append(v_err, 'o sexo'::text); continue; end if;
      elsif k = 'uf' then
        x := upper(left(x, 2));
      elsif k = 'nome' and length(x) < 5 then
        v_err := array_append(v_err, 'o nome completo'::text); continue;
      end if;
      v_pac := v_pac || jsonb_build_object(k, left(x, 200));
    end loop;
    if p_passo = 'dados_ident' then
      if v_pac ->> 'nome' is null and not ('o nome completo' = any(v_err)) then v_err := array_append(v_err, 'o nome completo'::text); end if;
      if v_pac ->> 'sexo' is null and not ('o sexo' = any(v_err)) then v_err := array_append(v_err, 'o sexo'::text); end if;
      if v_pac ->> 'dt_nasc' is null and not ('a data de nascimento' = any(v_err)) then v_err := array_append(v_err, 'a data de nascimento'::text); end if;
    elsif p_passo = 'dados_contato' and v_pac ->> 'celular' is null and not ('o celular (DDD + número)' = any(v_err)) then
      v_err := array_append(v_err, 'o celular (DDD + número)'::text);
    end if;
    if cardinality(v_err) > 0 then
      return jsonb_build_object('ok', false, 'erro', public.fluxo_t('dados_erro', jsonb_build_object('erros', array_to_string(v_err, ', '))));
    end if;
    if v_pac <> '{}'::jsonb then perform public.fluxo_pre(p_conversa, jsonb_build_object('paciente', v_pac, 'etapa', 'dados')); end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object(case p_passo when 'dados_ident' then 'g_ident' when 'dados_contato' then 'g_contato'
                                                             when 'dados_endereco' then 'g_endereco' else 'g_carteira' end, true,
      'digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb) || (o - 'pular')));
  when 'confirmar' then
    if v = 'ok' then perform public.fluxo_set(p_conversa, '{"confirmado": true}');
    elsif v = 'pedido' then perform public.fluxo_set(p_conversa, '{"refazer": "pedido", "confirmado": false}');
    elsif v = 'plano' then update public.pre_agendamentos set plano = null where conversa_id = p_conversa; perform public.fluxo_set(p_conversa, '{"confirmado": false}');
    elsif v = 'horario' then
      update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null where conversa_id = p_conversa;
      perform public.fluxo_set(p_conversa, '{"confirmado": false, "sem_horario": false}');
    elsif v = 'dados' then perform public.fluxo_set(p_conversa, '{"confirmado": false, "mudou": "mudou", "g_ident": false, "g_contato": false, "g_endereco": false, "g_carteira": false}');
    else return '{"ok": false}'; end if;
  else
    return '{"ok": false}';
  end case;
  return '{"ok": true}';
end $$;

-- ===== 7. Texto digitado: o que dá para entender sem IA =====
create or replace function public.fluxo_ler_texto(p_conversa uuid, p_passo text, p_texto text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare t text := public.fluxo_norm(p_texto); v_dt date; x text; v_med text[];
  sim boolean := t ~ '^(sim|s|isso|isso mesmo|pode|ok|okay|claro|correto|certo|confirmo|esta certo|ta certo|tudo certo|exato|positivo|uhum|aham)\M';
  nao boolean := t ~ '^(nao|n|negativo|errado|nada disso)\M';
begin
  case p_passo
  when 'identidade' then
    v_dt := public.fluxo_ler_data(p_texto);
    if v_dt is not null then return jsonb_build_object('dt_nasc', v_dt::text); end if;
  when 'motivo' then
    if t ~ '(exame|resson|reson|tomograf|ultras|ultrason|raio|\mrx\M|\mrm\M|\mtc\M|\musg?\M|mamograf|densitom|eletro|\mecg\M|\meeg\M|doppler|ecocard)' then return '"exame"'; end if;
    if t ~ '(consulta|medic|doutor|\mdra?\M|pediatr|cardiolog|ginecolog|ortoped|neuro|endocrin|gastro|urolog|nutri|puericult)' then return '"consulta"'; end if;
    if t ~ '(remarc|cancel|desmarc|resultado|laudo|duvida|reclama)' then return '"assunto"'; end if;
  when 'atalho' then
    if t ~ '(repetir|mesmo|ultimo)' then return '"ultimo"'; end if;
    if t ~ '(continuar|metade|pendente)' then return '"pendente"'; end if;
    if t ~ '(outro|novo|nova|diferente)' then return '"outro"'; end if;
  when 'assunto' then
    if t ~ '(remarc|mudar (o )?(dia|horario))' then return '"Remarcar"'; end if;
    if t ~ '(cancel|desmarc)' then return '"Cancelar"'; end if;
    if t ~ '(resultado|laudo)' then return '"Resultado de exame"'; end if;
    if t ~ '(reclama|sugest)' then return '"Reclamação"'; end if;
    if t ~ '(duvida|pergunta)' then return '"Dúvida"'; end if;
  when 'assunto_texto' then
    return jsonb_build_object('texto', left(btrim(p_texto), 500));
  when 'plano' then
    if t ~ '(particular|sem (plano|convenio)|nao tenho (plano|convenio))' then return '"Particular"'; end if;
    -- Operadora com mais palavras no texto; palavras genéricas (saúde, plano...) sozinhas não bastam.
    select q.operadora into x from (
      select o.operadora,
             count(*) filter (where t ~ ('\m' || w || '\M')) as acertos,
             count(*) filter (where t ~ ('\m' || w || '\M') and w !~ '^(saude|plano|planos|hospital|seguros|seguro|operadora|central|nacional|assistencia|vida|sa)$') as fortes
      from (select distinct operadora from public.catalogo_plano where coalesce(ativo, true) and operadora !~* '^(teste|particular)$') o
      cross join lateral unnest(string_to_array(regexp_replace(public.fluxo_norm(o.operadora), '[^a-z0-9 ]', ' ', 'g'), ' ')) w
      where length(w) >= 3
      group by o.operadora) q
    where q.fortes > 0 order by q.acertos desc, length(q.operadora) limit 1;
    if x is not null then return to_jsonb(x); end if;
  when 'medico' then
    if t ~ '(tanto faz|qualquer|sem preferencia|nao tenho preferencia|nenhum)' then return '""'; end if;
    v_med := public.fluxo_medicos(p_conversa);
    select m into x from unnest(v_med) m where public.fluxo_norm(m) ~ ('\m' || split_part(t, ' ', 1)) and length(split_part(t, ' ', 1)) >= 3 limit 1;
    if x is not null then return to_jsonb(x); end if;
  when 'mudou' then
    if t ~ '(continua|mesmo|igual|nao mudou|nada mudou)' or nao then return '"igual"'; end if;
    if t ~ '(mudou|mudei|mudaram|novo|nova)' or sim then return '"mudou"'; end if;
  when 'confirmar' then
    if sim then return '"ok"'; end if;
  when 'horario' then
    if t ~ '(nenhum|nao (serve|da|consigo)|outro horario|outra data)' then return '"sem_horario"'; end if;
  else
    null;
  end case;
  return null;
end $$;

-- ===== 8. Fim do roteiro: pedido pronto para a equipe =====
create or replace function public.fluxo_finalizar(p_conversa uuid) returns void language plpgsql security definer set search_path to '' as $$
declare ctx jsonb := public.fluxo_ctx(p_conversa); v_on boolean := public.fluxo_equipe_online(); v_txt text; c public.conversas;
begin
  select * into c from public.conversas where id = p_conversa;
  perform public.fluxo_pre(p_conversa, '{"etapa": "pronto"}'::jsonb, true);
  update public.conversa_fluxo set passo = 'pronto', dados = dados || jsonb_build_object('enviado_em', now()), atualizado_em = now() where conversa_id = p_conversa;
  v_txt := public.fluxo_t(case when v_on then 'pronto_online' else 'pronto_offline' end, ctx);
  if jsonb_array_length(coalesce(c.irmaos, '[]'::jsonb)) > 0 then v_txt := v_txt || E'\n\n' || public.fluxo_t('irmao_proximo', ctx); end if;
  perform public.fluxo_dizer(p_conversa, v_txt, jsonb_build_object('tipo', 'acompanhar'));
  perform public.fluxo_transferir(p_conversa, 'Pré-agendamento pronto (confirmado pelo paciente).', 'baixa', false);
end $$;

-- ===== 9. O motor: uma mensagem do paciente entra, a resposta sai =====
create or replace function public.fluxo_avancar(p_conversa uuid, p_entrada jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path to '' as $$
declare
  c public.conversas; f public.conversa_fluxo; v_t0 timestamptz := clock_timestamp();
  v_passo text; v_valor jsonb := p_entrada -> 'valor'; v_texto text := btrim(coalesce(p_entrada ->> 'texto', ''));
  v_norm text; v_res jsonb; v_prox text; v_prefixo text; v_tipo text := 'texto'; v_entendeu boolean := true; ctx jsonb;
begin
  select * into c from public.conversas where id = p_conversa for update;
  if not found or c.motor <> 'fluxo' or not (c.ia_ativa and c.status = 'aguardando') then return; end if;
  insert into public.conversa_fluxo (conversa_id) values (p_conversa) on conflict (conversa_id) do nothing;
  select * into f from public.conversa_fluxo where conversa_id = p_conversa for update;
  v_passo := f.passo;
  ctx := public.fluxo_ctx(p_conversa);

  if v_passo is null then
    v_prefixo := public.fluxo_t(case when (ctx ->> 'filho')::boolean then 'ola_filho' else 'ola_proprio' end, ctx);
    v_tipo := 'inicio';
  elsif v_passo in ('pronto', 'humano') then
    -- Conversa reaberta pelo paciente depois de ir para a equipe: quem responde é a equipe.
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('reaberta', ctx), jsonb_build_object('tipo', 'nova'));
    perform public.fluxo_transferir(p_conversa, 'Paciente voltou a escrever depois do atendimento.', 'baixa', false);
    insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'reaberta', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
    return;
  elsif p_entrada ->> 'acao' = 'atendente' then
    perform public.fluxo_transferir(p_conversa, 'Paciente pediu para falar com um atendente.', 'media', true);
    insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'atendente', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
    return;
  elsif p_entrada ->> 'evento' = 'anexo' then
    return;   -- foto do pedido: fica para o atendente; quem segue o roteiro é a busca do exame
  elsif v_valor is not null then
    v_tipo := 'botao';
    if p_entrada ->> 'passo' is distinct from v_passo then return; end if;
  elsif v_texto ~ '^(Pedido de exames:|Pedido de consulta:)' then
    v_tipo := 'componente';
    perform public.fluxo_set(p_conversa, jsonb_build_object('motivo', case when v_texto like 'Pedido de consulta:%' then 'consulta' else 'exame' end,
                                                            'confirmado', false, 'refazer', null, 'medico_feito', false));
    update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null
     where conversa_id = p_conversa and v_texto like 'Pedido de exames:%' and escolha_horario is not null and status = 'rascunho';
  elsif v_texto ~ '^(Horário \d+ de \d+: )?Escolhi ' then
    v_tipo := 'componente';
    perform public.fluxo_set(p_conversa, '{"confirmado": false}');
  elsif v_texto like 'Agora vamos agendar para %' then
    v_tipo := 'componente';
  else
    -- Texto digitado: interceptadores, depois a leitura do passo.
    v_norm := public.fluxo_norm(v_texto);
    if v_norm ~ '(dor (muito )?(forte |intensa )?no peito|aperto no peito|falta de ar|nao consigo respirar|dificuldade (para|pra) respirar|desmai|sangramento (intenso|forte|muito)|sangrando muito|\mavc\M|derrame|boca torta|convuls|reacao alergica|anafila|garganta fechando|quero morrer|me matar|suicid|me machucar|tirar (a )?minha vida|febre (alta|muito alta)|desidrat|sangue nas fezes|sangue no vomito|vomitando sangue|inconsciente|nao acorda|engasgad|nao (esta|ta) respirando)' then
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('emergencia', ctx));
      perform public.fluxo_transferir(p_conversa, 'URGENTE: possível emergência descrita pelo paciente: "' || left(v_texto, 200) || '"', 'alta', true);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'emergencia', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    end if;
    if v_norm ~ '(\matendente\M|\mhumano\M|recepcionista|secretaria|falar com (alguem|uma pessoa|pessoa|a clinica|voces)|pessoa de verdade|\mpessoa real\M)' then
      perform public.fluxo_transferir(p_conversa, 'Paciente pediu para falar com um atendente.', 'media', true);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'atendente', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    end if;
    if v_passo is distinct from 'assunto_texto' then
      if v_norm ~ '(quanto custa|quanto (e|fica|sai)|qual (o )?valor|\mvalor\M|\mpreco|\mcusta\M|orcamento)' then
        v_prefixo := public.fluxo_t('preco', ctx); v_prox := v_passo;
      elsif v_norm ~ '(diagnostic|remedio|medicament|posso tomar|o que (pode ser|eu tenho|ele tem|ela tem)|e grave|tratamento|dosagem|\mdose\M)' then
        v_prefixo := public.fluxo_t('clinico', ctx); v_prox := v_passo;
      end if;
    end if;
    if v_prox is null then
      v_valor := public.fluxo_ler_texto(p_conversa, v_passo, v_texto);
      if v_valor is null and v_passo = 'exame' then
        perform public.fluxo_set(p_conversa, jsonb_build_object('termo', left(v_texto, 80)));
        v_prefixo := 'Veja se o seu exame está nesta lista:'; v_prox := v_passo;
      elsif v_valor is null then
        v_entendeu := false;
        perform public.fluxo_nota(p_conversa, 'Paciente escreveu (não entendido no passo ' || coalesce(v_passo, '-') || '): ' || left(v_texto, 200));
        update public.conversa_fluxo set tentativas = tentativas + 1 where conversa_id = p_conversa;
        v_prefixo := public.fluxo_t('nao_entendi', ctx); v_prox := v_passo;
      end if;
    end if;
  end if;

  if v_valor is not null and v_prox is null then
    v_res := public.fluxo_aplicar(p_conversa, v_passo, v_valor);
    if not coalesce((v_res ->> 'ok')::boolean, false) then
      v_entendeu := false;
      v_prefixo := coalesce(v_res ->> 'erro', public.fluxo_t('nao_entendi', ctx)); v_prox := v_passo;
    elsif coalesce((v_res ->> 'transferir')::boolean, false) then
      perform public.fluxo_transferir(p_conversa, 'Outro assunto: ' || coalesce((select dados ->> 'assunto' from public.conversa_fluxo where conversa_id = p_conversa), ''), 'baixa', true);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, v_tipo, true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    else
      v_prefixo := v_res ->> 'aviso';
    end if;
  end if;

  if v_prox is null then v_prox := public.fluxo_proximo(p_conversa); end if;
  if v_prox = 'pronto' then
    perform public.fluxo_finalizar(p_conversa);
  elsif v_prox = 'horario' and v_tipo = 'componente' and v_passo = 'horario' then
    -- Mais de um horário: o calendário continua aberto no celular; a mensagem só serve para quem fechou a janela.
    perform public.fluxo_perguntar(p_conversa, v_prox, null);
  else
    perform public.fluxo_perguntar(p_conversa, v_prox, v_prefixo);
  end if;
  insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente)
  values (p_conversa, coalesce(v_passo, 'inicio'), v_tipo, v_entendeu, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
end $$;

-- ===== 10. Gatilhos =====
-- Toda mensagem do paciente numa conversa do motor passa por aqui, inclusive as que o mapa do corpo, a consulta e o calendário gravam.
create or replace function public.fluxo_mensagem_trg() returns trigger language plpgsql security definer set search_path to '' as $$
declare v_ent jsonb; v_motor text;
begin
  if new.autor <> 'cliente' then return new; end if;
  select motor into v_motor from public.conversas where id = new.conversa_id;
  if v_motor is distinct from 'fluxo' then return new; end if;
  begin v_ent := nullif(current_setting('fluxo.entrada', true), '')::jsonb; exception when others then v_ent := null; end;
  v_ent := coalesce(v_ent, '{}'::jsonb) || jsonb_build_object('texto', new.texto, 'mensagem_id', new.id);
  begin
    perform public.fluxo_avancar(new.conversa_id, v_ent);
  exception when others then
    insert into public.fluxo_evento (conversa_id, passo, entrada, entendido) values (new.conversa_id, 'erro', left(sqlstate || ' ' || sqlerrm, 300), false);
    begin
      perform public.fluxo_dizer(new.conversa_id, public.fluxo_t('erro'));
      perform public.fluxo_transferir(new.conversa_id, 'ATENÇÃO: erro técnico no atendimento automático; conferir a conversa.', 'media', false);
    exception when others then null;
    end;
  end;
  return new;
end $$;
create or replace trigger mensagens_motor_fluxo after insert on public.mensagens for each row execute function public.fluxo_mensagem_trg();

-- Conversa nova: decide o motor (config.motor ou telefone de teste); irmão herda o motor da conversa de origem.
create or replace function public.conversas_motor_trg() returns trigger language plpgsql security definer set search_path to '' as $$
declare v_tel text; v_lista text;
begin
  if new.irmao_de is not null then
    select motor into new.motor from public.conversas where id = new.irmao_de;
    new.motor := coalesce(new.motor, 'ia');
    return new;
  end if;
  if coalesce((select valor from public.config where chave = 'motor'), 'ia') = 'fluxo' then new.motor := 'fluxo'; return new; end if;
  select telefone into v_tel from public.contatos where id = new.contato_id;
  select valor into v_lista from public.config where chave = 'motor_telefones_teste';
  if v_tel is not null and v_tel = any(string_to_array(regexp_replace(coalesce(v_lista, ''), '[^0-9,]', '', 'g'), ',')) then new.motor := 'fluxo'; end if;
  return new;
end $$;
create or replace trigger conversas_motor before insert on public.conversas for each row execute function public.conversas_motor_trg();

-- ===== 11. Funções do chat =====
create or replace function public.chat_responder(p_conversa uuid, p_token text, p_passo text, p_valor jsonb, p_texto text default null, p_ms integer default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_id bigint; c public.conversas; v_passo text; v_txt text; o jsonb; k text; x text; v_partes text[] := '{}';
  rotulos jsonb := '{"nome":"Nome","sexo":"Sexo","dt_nasc":"Nascimento","mae":"Mãe","cpf":"CPF","rg":"RG","celular":"Celular","telefone":"Telefone","cep":"CEP","endereco":"Rua","numero":"Nº","complemento":"Compl.","bairro":"Bairro","cidade":"Cidade","uf":"UF","matricula":"Carteirinha","validade":"Validade"}';
begin
  perform public.chat_valida(p_conversa, p_token);
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  select * into c from public.conversas where id = p_conversa;
  select passo into v_passo from public.conversa_fluxo where conversa_id = p_conversa;
  if p_valor ->> 'acao' = 'atendente' then
    v_txt := 'Quero falar com um atendente.';
  else
    if c.motor <> 'fluxo' or not (c.ia_ativa and c.status = 'aguardando') or p_passo is distinct from v_passo then
      raise exception 'Essa pergunta já foi respondida. Veja a última mensagem.' using errcode = '22023';
    end if;
    o := case when jsonb_typeof(p_valor) = 'object' then p_valor else null end;
    if o is not null and p_passo in ('identidade', 'dados_ident', 'dados_contato', 'dados_endereco', 'dados_carteira') then
      -- Texto montado aqui: o CPF não fica escrito por inteiro na conversa.
      if coalesce((o ->> 'pular')::boolean, false) then v_txt := 'Prefiro deixar para depois.';
      else
        for k, x in select e.key, e.value from jsonb_each_text(o) e
                    order by array_position(array['nome','sexo','dt_nasc','mae','cpf','rg','celular','telefone','cep','endereco','numero','complemento','bairro','cidade','uf','matricula','validade'], e.key) loop
          if nullif(btrim(x), '') is null or k = 'pular' then continue; end if;
          if k = 'cpf' then x := '***.***.' || right(regexp_replace(x, '\D', '', 'g'), 5); end if;
          if k = 'sexo' then x := case upper(left(x, 1)) when 'F' then 'Feminino' when 'M' then 'Masculino' else x end; end if;
          v_partes := v_partes || (coalesce(rotulos ->> k, k) || ': ' || left(btrim(x), 120));
        end loop;
        v_txt := coalesce(nullif(array_to_string(v_partes, E'\n'), ''), 'Enviado.');
      end if;
    else
      v_txt := coalesce(nullif(left(btrim(coalesce(p_texto, '')), 1000), ''),
                        left(coalesce(case when jsonb_typeof(p_valor) = 'string' then p_valor #>> '{}' end, p_valor ->> 'outro', 'Enviado.'), 1000));
    end if;
  end if;
  perform set_config('fluxo.entrada', jsonb_build_object('passo', p_passo, 'valor', case when p_valor ->> 'acao' = 'atendente' then null else p_valor end,
                                                         'acao', p_valor ->> 'acao', 'ms', p_ms)::text, true);
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_id;
  perform set_config('fluxo.entrada', '', true);
  return jsonb_build_object('id', v_id, 'respostas', public.chat_respostas(p_conversa, v_id - 1));
end $$;

-- A mensagem do paciente e o que veio depois dela (a resposta do motor, na mesma chamada).
create or replace function public.chat_respostas(p_conversa uuid, p_apos bigint) returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'autor', m.autor, 'texto', m.texto, 'opcoes', m.opcoes, 'criado_em', m.criado_em,
                                               'agente', coalesce(ag.nome, case when m.autor = 'agente' then 'Assistente virtual' end)) order by m.id), '[]'::jsonb)
  from public.mensagens m left join public.agentes ag on ag.id = m.agente_id
  where m.conversa_id = p_conversa and m.id > p_apos
$$;

create or replace function public.chat_enviar(p_conversa uuid, p_token text, p_texto text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_txt text; v_id bigint;
begin
  v_txt := btrim(coalesce(p_texto, ''));
  if v_txt = '' or char_length(v_txt) > 4000 then raise exception 'Mensagem inválida.' using errcode = '22023'; end if;
  perform 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  update public.conversas set
    status = case when status = 'encerrada' then 'aguardando' else status end,
    agente_id = case when status = 'encerrada' then null else agente_id end
  where id = p_conversa;
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_id;
  return jsonb_build_object('id', v_id, 'respostas', public.chat_respostas(p_conversa, v_id - 1));
end $$;

create or replace function public.chat_listar(p_conversa uuid, p_token text, p_apos bigint default 0)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_status text; v_agente text; v_motor boolean; v_passo text;
begin
  select c.status, a.nome, (c.motor = 'fluxo' and c.ia_ativa and c.status = 'aguardando'), f.passo into v_status, v_agente, v_motor, v_passo
  from public.conversas c
  join public.conversa_segredo s on s.conversa_id = c.id
  left join public.agentes a on a.id = c.agente_id
  left join public.conversa_fluxo f on f.conversa_id = c.id
  where c.id = p_conversa and s.token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  return jsonb_build_object('status', v_status, 'agente', v_agente, 'motor_ativo', coalesce(v_motor, false), 'passo', v_passo,
    'mensagens', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'autor', m.autor, 'texto', m.texto, 'opcoes', m.opcoes, 'criado_em', m.criado_em,
                                          'agente', coalesce(ag.nome, case when m.autor = 'agente' then 'Assistente virtual' end)) order by m.id)
      from (select * from public.mensagens where conversa_id = p_conversa and id > coalesce(p_apos, 0) order by id limit 200) m
      left join public.agentes ag on ag.id = m.agente_id), '[]'::jsonb));
end $$;

-- Exames que o paciente pode escolher (com agenda vigente), com o nome já normalizado. Atualizada todo dia às 03:40 (Brasília), depois da cópia do Klingo.
create materialized view if not exists public.fluxo_exames as
  select p.id, p.nome, p.modalidade, coalesce(p.demanda_90d, 0) as demanda, public.fluxo_norm_exame(p.nome) as chave,
         regexp_replace(public.norm_nome(p.nome), 'NAO INCLUI.*$', '') as chave_reg
  from public.catalogo_procedimento p
  where p.ativo and p.modalidade <> 'CONSULTA'
    and public.norm_nome(p.nome) !~ 'ACRESCENTAR|\mPCTE\M|PACOTE|\mCONTRASTE\M|RECONSTRUCAO|PLANEJAMENTO|PUNCAO|BIOPSIA|DRENAGEM|AMNIOCENTESE|RADIOCIRURGIA|SEDACAO|ADICIONAL|BISNAGA'
    and exists (select 1 from public.catalogo_agenda a where a.procedimento_id = p.id and a.vig_fim >= current_date and a.profissional !~* 'teste');
create unique index if not exists fluxo_exames_id on public.fluxo_exames (id);
revoke all on public.fluxo_exames from anon, authenticated;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and not exists (select 1 from cron.job where jobname = 'fluxo-exames') then
    perform cron.schedule('fluxo-exames', '40 6 * * *', 'refresh materialized view concurrently public.fluxo_exames');
  end if;
end $$;

-- Busca de exame por nome ou pelo texto lido da foto do pedido (OCR). Primeiro pelo nome; depois por tipo de exame + parte do corpo
-- (a mesma regra do mapa do corpo: "rm joelho" acha "RM ARTICULAR").
create or replace function public.chat_exames_buscar(p_conversa uuid, p_token text, p_termo text, p_ocr boolean default false)
returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_linhas text[]; l text; t text; v_mods text[]; v_regs text[]; v_lado text; r jsonb := '[]'::jsonb; v_parte jsonb; v_tok text[]; v_b int[]; n int := 0;
begin
  perform public.chat_valida(p_conversa, p_token);
  v_linhas := case when p_ocr then (select array_agg(x) from (select btrim(x) x from regexp_split_to_table(left(coalesce(p_termo, ''), 4000), '[\n;]+') x) q where length(x) >= 4)
                   else array[left(coalesce(p_termo, ''), 120)] end;
  foreach l in array coalesce(v_linhas, array['']) loop
    exit when n >= 12;
    t := public.fluxo_norm_exame(l);
    v_mods := array_remove(array[case when t ~ '\mRM\M' then 'RM' end, case when t ~ '\mTC\M' then 'TC' end, case when t ~ '\mUS\M|DOPPLER' then 'US' end,
                                 case when t ~ '\mRX\M' then 'RX' end, case when t ~ 'MAMOGRAF' then 'MAMO' end, case when t ~ 'DENSITOMETR' then 'DENSITO' end], null);
    select array_agg(g.codigo order by g.ordem) into v_regs from public.catalogo_regiao g
     where t <> '' and t ~ ('(' || split_part(g.padrao, '|^(?!', 1) || ')');
    v_lado := case when t ~ '\mBILATERA|\mAMBOS\M|\mDOIS LADOS' then 'A' when t ~ '\mDIREIT' then 'D' when t ~ '\mESQUERD' then 'E' end;
    v_tok := array(select w from unnest(string_to_array(t, ' ')) w where length(w) >= 2 and w !~ '^\d+$'
                   and w !~ '^(DIREITO|DIREITA|ESQUERDO|ESQUERDA|BILATERAL|AMBOS|LADO|LADOS|DOIS|EXAME|EXAMES|SOLICITO|SOLICITACAO|PEDIDO|FAVOR|REALIZAR|FAZER|QUERO|PRECISO|UM|UMA)$');
    select coalesce(array_agg(x.id), '{}') into v_b from public.fluxo_exames x
     where cardinality(v_tok) > 0 and (cardinality(v_mods) = 0 or x.modalidade = any(v_mods))
       and coalesce((select bool_and(x.chave ~ ('\m' || w)) from unnest(v_tok) w where w !~ '^(RM|TC|US|RX)$' or cardinality(v_mods) = 0), false);
    with cand as (
      select x.id, x.nome, x.modalidade, null::text as regiao, x.demanda, 0 as fonte from public.fluxo_exames x where x.id = any(v_b)
      union all
      select x.id, x.nome, x.modalidade, g.codigo, x.demanda, 1
      from public.fluxo_exames x join public.catalogo_regiao g on g.codigo = any(v_regs) and x.chave_reg ~ g.padrao
      where cardinality(v_regs) > 0 and (cardinality(v_mods) > 0 or cardinality(v_b) = 0)
        and x.modalidade = any(case when cardinality(v_mods) > 0 then v_mods else array['RM','TC','US','RX'] end)
      union all
      select x.id, x.nome, x.modalidade, null, x.demanda, 3 from public.fluxo_exames x
      where not p_ocr and cardinality(v_tok) = 0 and coalesce(cardinality(v_regs), 0) = 0 and x.modalidade <> 'OUTRO' and x.demanda > 0
    ), um as (
      select distinct on (c.id) c.* from cand c order by c.id, c.fonte
    ), lim as (
      select u.*, row_number() over (order by u.fonte, u.demanda desc, u.nome) as ord from um u
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'modalidade', x.modalidade, 'regiao', reg.codigo, 'regiao_nome', reg.nome,
             'tem_lado', coalesce(reg.tem_lado, false), 'bilateral', x.nome ~* 'BILATERAL', 'lado', v_lado, 'linha', case when p_ocr then left(l, 120) end,
             'sugerido', p_ocr and x.ord = 1) order by x.ord), '[]'::jsonb) into v_parte
    from lim x
    left join lateral (select g.codigo, g.nome, g.tem_lado from public.catalogo_regiao g
                       where g.codigo = x.regiao or (x.regiao is null and regexp_replace(public.norm_nome(x.nome), 'NAO INCLUI.*$', '') ~ g.padrao)
                       order by (g.codigo = x.regiao) desc, g.ordem limit 1) reg on true
    where x.ord <= case when p_ocr then 3 else 24 end;
    r := r || v_parte; n := n + 1;
  end loop;
  return r;
end $$;

-- Grava o pedido escolhido na busca (qualquer tipo de exame com agenda). Item sem exame no cadastro: fica o nome digitado.
create or replace function public.chat_exames_salvar(p_conversa uuid, p_token text, p_itens jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare it jsonb; p record; reg record; v_lado text; v_qtd int; v_linhas text[] := '{}'; v_nomes text[] := '{}'; v_n int := 0; v_msg bigint; v_txt text; v_livre text;
begin
  perform public.chat_valida(p_conversa, p_token);
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 or jsonb_array_length(p_itens) > 12 then
    raise exception 'Pedido inválido.' using errcode = '22023';
  end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  if exists (select 1 from public.pre_agendamentos where conversa_id = p_conversa and status in ('agendado','cancelado','pronto')) then
    raise exception 'Este pedido já foi enviado. Inicie um novo atendimento.' using errcode = '22023';
  end if;
  update public.pre_agendamento_itens set ativo = false where conversa_id = p_conversa and ativo;
  for it in select * from jsonb_array_elements(p_itens) loop
    v_livre := nullif(left(btrim(coalesce(it ->> 'texto', '')), 160), '');
    if nullif(it ->> 'procedimento_id', '') is null then
      if v_livre is null then raise exception 'Escolha o exame.' using errcode = '22023'; end if;
      insert into public.pre_agendamento_itens (conversa_id, modalidade, lado, procedimento_id, procedimento, quantidade)
      values (p_conversa, 'OUTRO', 'N', null, v_livre, 1);
      v_linhas := v_linhas || ('• ' || v_livre || ' (o atendente confere o exame)'); v_nomes := v_nomes || v_livre; v_n := v_n + 1;
      continue;
    end if;
    select pr.id, pr.nome, pr.modalidade into p from public.catalogo_procedimento pr
     where pr.id = (it ->> 'procedimento_id')::int and pr.ativo and pr.modalidade <> 'CONSULTA'
       and exists (select 1 from public.catalogo_agenda a where a.procedimento_id = pr.id and a.vig_fim >= current_date and a.profissional !~* 'teste');
    if p.id is null then raise exception 'Exame não encontrado no cadastro.' using errcode = '22023'; end if;
    select g.codigo, g.nome, g.tem_lado into reg from public.catalogo_regiao g
     where g.codigo = it ->> 'regiao' or regexp_replace(public.norm_nome(p.nome), 'NAO INCLUI.*$', '') ~ g.padrao
     order by (g.codigo = coalesce(it ->> 'regiao', '')) desc, g.ordem limit 1;
    v_lado := upper(coalesce(nullif(it ->> 'lado', ''), 'N'));
    if p.nome ~* 'BILATERAL' then v_lado := case when coalesce(reg.tem_lado, false) then 'A' else 'N' end;
    elsif coalesce(reg.tem_lado, false) then
      if v_lado not in ('D','E','A') then raise exception 'Informe o lado (direito, esquerdo ou os dois) de: %.', initcap(lower(p.nome)) using errcode = '22023'; end if;
    else v_lado := 'N';
    end if;
    v_qtd := case when v_lado = 'A' and p.nome !~* 'BILATERAL' then 2 else 1 end;
    insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
    values (p_conversa, p.modalidade, reg.codigo, reg.nome, v_lado, p.id, p.nome, v_qtd);
    v_n := v_n + 1;
    v_linhas := v_linhas || ('• ' || initcap(lower(p.nome)) || case v_lado when 'D' then ' — lado direito' when 'E' then ' — lado esquerdo' when 'A' then ' — os dois lados' else '' end
                             || case when v_qtd > 1 then ' (2 unidades)' else '' end);
    v_nomes := v_nomes || p.nome;
  end loop;
  insert into public.pre_agendamentos as pa (conversa_id, tipo, procedimento, etapa, paciente, status)
  values (p_conversa, 'exame', left(array_to_string(v_nomes, ' + '), 160), 'plano', '{}'::jsonb, 'rascunho')
  on conflict (conversa_id) do update set tipo = 'exame', procedimento = excluded.procedimento, escolha_horario = null, data_desejada = null, hora_desejada = null,
    etapa = case when pa.etapa is null or pa.etapa = 'pedido' then 'plano' else pa.etapa end, atualizado_em = now()
  where pa.status = 'rascunho';
  v_txt := left('Pedido de exames:' || E'\n' || array_to_string(v_linhas, E'\n'), 3900);
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_msg;
  return jsonb_build_object('ok', true, 'itens', v_n, 'mensagem_id', v_msg, 'respostas', public.chat_respostas(p_conversa, v_msg - 1));
end $$;

-- Foto do pedido médico (já reduzida no celular). Fica para o atendente; o texto lido (OCR) vai junto.
create or replace function public.chat_anexo_enviar(p_conversa uuid, p_token text, p_mime text, p_base64 text, p_ocr text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_bin bytea; v_id bigint; v_msg bigint;
begin
  perform public.chat_valida(p_conversa, p_token);
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp') then raise exception 'Envie uma foto (JPG ou PNG).' using errcode = '22023'; end if;
  if length(coalesce(p_base64, '')) > 2000000 then raise exception 'A foto é grande demais. Tente de novo.' using errcode = '22023'; end if;
  if (select count(*) from public.conversa_anexo where conversa_id = p_conversa) >= 6 then raise exception 'Limite de fotos desta conversa atingido.' using errcode = '54000'; end if;
  begin v_bin := decode(regexp_replace(p_base64, '^data:[^,]*,', ''), 'base64'); exception when others then raise exception 'Foto inválida.' using errcode = '22023'; end;
  insert into public.conversa_anexo (conversa_id, mime, dados, ocr_texto) values (p_conversa, p_mime, v_bin, left(p_ocr, 4000)) returning id into v_id;
  perform set_config('fluxo.entrada', '{"evento":"anexo"}', true);
  insert into public.mensagens (conversa_id, autor, texto, opcoes) values (p_conversa, 'cliente', 'Foto do pedido médico enviada.', jsonb_build_object('tipo', 'anexo', 'id', v_id))
  returning id into v_msg;
  perform set_config('fluxo.entrada', '', true);
  return jsonb_build_object('ok', true, 'id', v_id, 'mensagem_id', v_msg);
end $$;

-- Acompanhamento ao vivo no chat: enviado há quanto tempo, se já foi confirmado e se a equipe está online.
create or replace function public.chat_acompanhar(p_conversa uuid, p_token text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare r jsonb;
begin
  perform public.chat_valida(p_conversa, p_token);
  select jsonb_build_object('agora', now(), 'conversa', c.status, 'agente', a.nome, 'equipe_online', public.fluxo_equipe_online(),
    'pedido', pa.status, 'tipo', pa.tipo, 'conferencia', pa.conferencia_status,
    'enviado_em', coalesce((f.dados ->> 'enviado_em')::timestamptz, (f.dados ->> 'transferido_em')::timestamptz),
    'confirmado', coalesce(pa.status = 'agendado' or pa.conferencia_status = 'confirmado', false),
    'horarios', coalesce((select jsonb_agg(jsonb_build_object('data', e ->> 'data', 'hora', e ->> 'hora', 'unidade', regexp_replace(coalesce(e ->> 'unidade', ''), '^CLÍNICA DE SAÚDE E IMAGEM - ', 'CSI ')) order by (e ->> 'grupo')::int)
                          from jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e), '[]'::jsonb))
    into r
  from public.conversas c left join public.agentes a on a.id = c.agente_id
  left join public.pre_agendamentos pa on pa.conversa_id = c.id
  left join public.conversa_fluxo f on f.conversa_id = c.id
  where c.id = p_conversa;
  return r;
end $$;

-- ===== 12. Painel =====
create or replace function public.painel_presenca() returns void language sql security definer set search_path to '' as $$
  update public.agentes set visto_em = now() where id = (select auth.uid()) and ativo
$$;

create or replace function public.painel_anexo(p_id bigint) returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare r jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select jsonb_build_object('mime', mime, 'base64', encode(dados, 'base64'), 'ocr', ocr_texto, 'criado_em', criado_em) into r from public.conversa_anexo where id = p_id;
  return r;
end $$;

-- Relatório do motor (aba Fluxo): onde as conversas param, tempo de resposta e o que não foi entendido.
create or replace function public.fluxo_relatorio(p_dias integer default 7) returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare v_ini timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_dias, 7), 90))); r jsonb;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select jsonb_build_object(
    'conversas', (select count(*) from public.conversas c where c.motor = 'fluxo' and c.criado_em >= v_ini),
    'passos', coalesce((select jsonb_agg(jsonb_build_object('passo', coalesce(f.passo, 'inicio'), 'conversas', f.n) order by f.n desc)
                        from (select f.passo, count(*) n from public.conversa_fluxo f join public.conversas c on c.id = f.conversa_id where c.criado_em >= v_ini group by f.passo) f), '[]'::jsonb),
    'ms_servidor_p50', (select round(percentile_cont(0.5) within group (order by ms)::numeric, 1) from public.fluxo_evento where criado_em >= v_ini and ms is not null),
    'ms_servidor_p95', (select round(percentile_cont(0.95) within group (order by ms)::numeric, 1) from public.fluxo_evento where criado_em >= v_ini and ms is not null),
    'ms_paciente_p50', (select percentile_cont(0.5) within group (order by ms_cliente) from public.fluxo_evento where criado_em >= v_ini and ms_cliente is not null),
    'ms_paciente_p95', (select percentile_cont(0.95) within group (order by ms_cliente) from public.fluxo_evento where criado_em >= v_ini and ms_cliente is not null),
    'nao_entendidos', (select count(*) from public.fluxo_evento where criado_em >= v_ini and not entendido),
    'erros', (select count(*) from public.fluxo_evento where criado_em >= v_ini and passo = 'erro'),
    'notas', coalesce((select jsonb_agg(x order by x ->> 'quando' desc) from (
        select jsonb_build_object('conversa_id', f.conversa_id, 'nota', n, 'quando', f.atualizado_em) x
        from public.conversa_fluxo f cross join lateral jsonb_array_elements_text(coalesce(f.dados -> 'notas', '[]'::jsonb)) n
        where f.atualizado_em >= v_ini order by f.atualizado_em desc limit 60) q), '[]'::jsonb))
  into r;
  return r;
end $$;

-- ===== 13. A IA antiga não fala em conversa do motor =====
create or replace function public.avisar_n8n_mensagem() returns trigger language plpgsql security definer set search_path to '' as $$
declare v_url text; v_ok boolean; v_tok text; v_headers jsonb;
begin
  if new.autor <> 'cliente' then return new; end if;
  select (c.ia_ativa and c.status = 'aguardando' and c.motor = 'ia') into v_ok from public.conversas c where c.id = new.conversa_id;
  if not coalesce(v_ok, false) then return new; end if;
  if coalesce((select valor from public.config where chave = 'ia_ativa'), 'sim') <> 'sim' then return new; end if;
  select valor into v_url from public.config where chave = 'n8n_webhook_url';
  if coalesce(v_url, '') = '' then return new; end if;
  select valor into v_tok from public.config where chave = 'n8n_webhook_token';
  v_headers := '{"Content-Type":"application/json"}'::jsonb;
  if coalesce(v_tok, '') <> '' then v_headers := v_headers || jsonb_build_object('x-webhook-token', v_tok); end if;
  begin
    perform net.http_post(url := v_url,
      body := jsonb_build_object('evento', 'mensagem_cliente', 'conversa_id', new.conversa_id, 'mensagem_id', new.id, 'texto', new.texto),
      headers := v_headers);
  exception when others then null;
  end;
  return new;
end $$;

create or replace function public.ia_responder_v2(p_segredo text, p_conversa uuid, p_texto text, p_resumo text default null, p_urgencia text default null, p_transferir boolean default false, p_opcoes jsonb default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_seg text; v_ok boolean; v_op jsonb;
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if v_seg is null or p_segredo is distinct from v_seg then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select (ia_ativa and status = 'aguardando' and motor = 'ia') into v_ok from public.conversas where id = p_conversa for update;
  if not coalesce(v_ok, false) then return jsonb_build_object('enviada', false); end if;
  if p_opcoes is not null and jsonb_typeof(p_opcoes) = 'string' then begin p_opcoes := (p_opcoes #>> '{}')::jsonb; exception when others then p_opcoes := null; end; end if;
  v_op := case when p_opcoes is not null and jsonb_typeof(p_opcoes) = 'object' and p_opcoes ->> 'tipo' in ('lista','pedido_exames','calendario')
                    and length(p_opcoes::text) <= 6000 then p_opcoes else null end;
  if btrim(coalesce(p_texto, '')) <> '' then
    insert into public.mensagens (conversa_id, autor, texto, opcoes) values (p_conversa, 'agente', left(btrim(p_texto), 4000), v_op);
  end if;
  update public.conversas set
    triagem_resumo = coalesce(nullif(left(btrim(coalesce(p_resumo, '')), 1000), ''), triagem_resumo),
    triagem_urgencia = coalesce(case when p_urgencia in ('baixa','media','alta') then p_urgencia end, triagem_urgencia),
    ia_ativa = case when p_transferir then false else ia_ativa end
  where id = p_conversa;
  return jsonb_build_object('enviada', true);
end $$;

create or replace function public.ia_responder(p_segredo text, p_conversa uuid, p_texto text, p_resumo text default null, p_urgencia text default null, p_transferir boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_seg text; v_ok boolean;
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if v_seg is null or p_segredo is distinct from v_seg then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select (ia_ativa and status = 'aguardando' and motor = 'ia') into v_ok from public.conversas where id = p_conversa for update;
  if not coalesce(v_ok, false) then return jsonb_build_object('enviada', false); end if;
  if btrim(coalesce(p_texto, '')) <> '' then insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'agente', left(btrim(p_texto), 4000)); end if;
  update public.conversas set
    triagem_resumo = coalesce(nullif(left(btrim(coalesce(p_resumo, '')), 1000), ''), triagem_resumo),
    triagem_urgencia = coalesce(case when p_urgencia in ('baixa','media','alta') then p_urgencia end, triagem_urgencia),
    ia_ativa = case when p_transferir then false else ia_ativa end
  where id = p_conversa;
  return jsonb_build_object('enviada', true);
end $$;

-- ===== 14. Início da conversa: com o motor, a primeira pergunta sai na mesma chamada =====
create or replace function public.chat_iniciar(p_nome text, p_telefone text, p_email text default null, p_mensagem text default null, p_aceite boolean default false,
  p_origem text default null, p_unidade text default null, p_medico text default null, p_paciente_tipo text default 'proprio', p_paciente_nome text default null,
  p_irmaos jsonb default null, p_irmaos_modo text default null)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_tel text; v_contato uuid; v_conv uuid; v_token text; v_url text;
  v_nome text; v_msg text; v_recentes int; v_uni text; v_med text; v_tipo text; v_pnome text; v_irm jsonb := '[]'::jsonb; v_modo text; v_motor text;
begin
  v_tipo := coalesce(nullif(btrim(p_paciente_tipo), ''), 'proprio');
  if v_tipo not in ('proprio', 'filho') then raise exception 'Tipo de paciente inválido.' using errcode = '22023'; end if;
  v_pnome := case when v_tipo = 'filho' then nullif(left(btrim(coalesce(p_paciente_nome, '')), 120), '') end;
  if p_irmaos is not null then
    if jsonb_typeof(p_irmaos) <> 'array' then raise exception 'Lista de filhos inválida.' using errcode = '22023'; end if;
    select coalesce(jsonb_agg(t.n), '[]'::jsonb) into v_irm
    from (select left(btrim(x), 120) as n from jsonb_array_elements_text(p_irmaos) x where btrim(x) <> '' limit 5) t;
  end if;
  if jsonb_array_length(v_irm) > 0 then
    if v_tipo <> 'filho' then raise exception 'Outros filhos só valem quando o atendimento é para um filho(a).' using errcode = '22023'; end if;
    v_modo := coalesce(nullif(btrim(coalesce(p_irmaos_modo, '')), ''), 'um_de_cada_vez');
    if v_modo not in ('um_de_cada_vez', 'juntos') then raise exception 'Modo de agendamento inválido.' using errcode = '22023'; end if;
  end if;
  if not coalesce(p_aceite, false) then raise exception 'Aceite a política de privacidade para continuar.' using errcode = '22023'; end if;
  v_nome := btrim(coalesce(p_nome, ''));
  if char_length(v_nome) < 2 then raise exception 'Informe seu nome.' using errcode = '22023'; end if;
  v_tel := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  if char_length(v_tel) in (12, 13) and left(v_tel, 2) = '55' then v_tel := substr(v_tel, 3); end if;
  if char_length(v_tel) not in (10, 11) then raise exception 'Informe um telefone válido com DDD.' using errcode = '22023'; end if;
  if btrim(coalesce(p_email, '')) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Informe um e-mail válido.' using errcode = '22023'; end if;
  v_msg := btrim(coalesce(p_mensagem, ''));
  if char_length(v_msg) > 4000 then raise exception 'Mensagem muito longa.' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_unidade, '')), '') is not null then
    select u.chave into v_uni from public.unidade_config u where u.chave = btrim(p_unidade) and u.ativo;
    if v_uni is null then raise exception 'Unidade inválida.' using errcode = '22023'; end if;
  end if;
  if nullif(btrim(coalesce(p_medico, '')), '') is not null then
    if v_uni is null then raise exception 'Escolha a unidade para indicar o médico.' using errcode = '22023'; end if;
    select m.nome into v_med from public.unidade_medicos(v_uni) m where m.nome = btrim(p_medico);
    if v_med is null then raise exception 'Médico não encontrado nesta unidade.' using errcode = '22023'; end if;
  end if;
  select c.id into v_contato from public.contatos c where c.telefone = v_tel;
  if v_contato is not null then
    select count(*) into v_recentes from public.conversas where contato_id = v_contato and criado_em > now() - interval '1 hour';
    if v_recentes >= 5 then raise exception 'Muitas tentativas. Tente novamente em alguns minutos.' using errcode = '54000'; end if;
  end if;
  insert into public.contatos (nome, telefone, email, origem, aceitou_lgpd_em)
  values (left(v_nome, 120), v_tel, nullif(left(btrim(coalesce(p_email, '')), 200), ''), nullif(left(btrim(coalesce(p_origem, '')), 100), ''), now())
  on conflict (telefone) do update set ultimo_contato_em = now(), email = coalesce(public.contatos.email, excluded.email),
    aceitou_lgpd_em = coalesce(public.contatos.aceitou_lgpd_em, now())
  returning id into v_contato;
  insert into public.conversas (contato_id, nome_informado, email_informado, unidade_inicial, medico_preferido, paciente_tipo, paciente_nome, irmaos, irmaos_modo)
  values (v_contato, left(v_nome, 120), nullif(left(btrim(coalesce(p_email, '')), 200), ''), v_uni, v_med, v_tipo, v_pnome, v_irm, v_modo)
  returning id, motor into v_conv, v_motor;
  insert into public.conversa_segredo (conversa_id) values (v_conv) returning token into v_token;
  if v_msg = '' and v_tipo = 'filho' and v_pnome is not null and v_motor = 'ia' then v_msg := 'Olá! Quero agendar para ' || v_pnome || '.'; end if;
  if v_msg <> '' then
    insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'cliente', v_msg);
  elsif v_motor = 'fluxo' then
    perform public.fluxo_avancar(v_conv, '{}'::jsonb);
  end if;
  select valor into v_url from public.config where chave = 'n8n_webhook_url';
  if coalesce(v_url, '') <> '' then
    begin
      perform net.http_post(url := v_url,
        body := jsonb_build_object('evento', 'nova_conversa', 'conversa_id', v_conv, 'nome', v_nome, 'telefone', v_tel, 'email', nullif(btrim(coalesce(p_email, '')), ''),
                                   'mensagem', v_msg, 'origem', p_origem, 'criado_em', now(), 'motor', v_motor),
        headers := '{"Content-Type":"application/json"}'::jsonb);
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('conversa_id', v_conv, 'token', v_token, 'motor', v_motor, 'respostas', public.chat_respostas(v_conv, 0));
end $function$;

-- ===== 15. Permissões =====
revoke all on function public.fluxo_t(text, jsonb), public.fluxo_ctx(uuid), public.fluxo_dizer(uuid, text, jsonb), public.fluxo_procs(uuid), public.fluxo_medicos(uuid),
  public.fluxo_set(uuid, jsonb), public.fluxo_nota(uuid, text), public.fluxo_pre(uuid, jsonb, boolean), public.fluxo_resumo(uuid),
  public.fluxo_transferir(uuid, text, text, boolean), public.fluxo_proximo(uuid), public.fluxo_perguntar(uuid, text, text), public.fluxo_leitura(uuid),
  public.fluxo_aplicar(uuid, text, jsonb), public.fluxo_rotulo_item(uuid, integer, text, text), public.fluxo_ler_texto(uuid, text, text), public.fluxo_finalizar(uuid), public.fluxo_avancar(uuid, jsonb),
  public.fluxo_equipe_online(), public.chat_respostas(uuid, bigint), public.fluxo_mensagem_trg(), public.conversas_motor_trg() from public, anon, authenticated;
grant execute on function public.chat_responder(uuid, text, text, jsonb, text, integer), public.chat_exames_buscar(uuid, text, text, boolean),
  public.chat_exames_salvar(uuid, text, jsonb), public.chat_anexo_enviar(uuid, text, text, text, text), public.chat_acompanhar(uuid, text),
  public.chat_enviar(uuid, text, text), public.chat_listar(uuid, text, bigint),
  public.chat_iniciar(text, text, text, text, boolean, text, text, text, text, text, jsonb, text) to anon, authenticated;
revoke all on function public.painel_presenca(), public.painel_anexo(bigint), public.fluxo_relatorio(integer) from public, anon;
grant execute on function public.painel_presenca(), public.painel_anexo(bigint), public.fluxo_relatorio(integer) to authenticated;
