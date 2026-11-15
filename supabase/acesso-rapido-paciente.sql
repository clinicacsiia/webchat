-- FLUXOGRAMA: entrada (página pública acesso/index.html chamando funções app_* com a chave pública; o aparelho guarda só um código de aparelho, nunca o PIN) -> validação (interruptor config.app_acesso_modo; código do aparelho conferido pelo hash; PIN conferido no servidor com bloqueio crescente; celular, nome, nascimento e filhos validados no servidor) -> lógica (cadastro único: titular + filhos + números de confiança; marcação gera uma solicitação por pessoa escolhida; número de confiança só enxerga depois de digitar o código que o titular lhe passou) -> saída (tabelas app_* fechadas ao público; funções app_* para o paciente; painel_app_* só para a equipe)
-- Versão 1.0 — 14/11/2026 / Mudança: Implementação inicial (liga o "acesso rápido do paciente" — celular + PIN de 4 dígitos — ao Supabase)
--
-- POR QUE: a primeira versão do acesso rápido guardava tudo só no celular (localStorage). O número de confiança não via nada no celular dele,
-- a clínica não via as solicitações e trocar de aparelho apagava o cadastro. Agora o banco é a fonte: o aparelho guarda só um código de aparelho.
--
-- DECISÕES DE SEGURANÇA (a página é pública e guarda nome e nascimento de crianças):
--   1. Todas as tabelas app_* têm RLS ligada e NENHUMA regra de acesso, e o público não tem permissão de tabela. Só as funções abaixo leem e gravam.
--   2. O PIN (4 dígitos = 10 mil combinações) é conferido NO SERVIDOR com bcrypt. 5 erros bloqueiam 1 minuto; a cada novos 5 erros seguidos o bloqueio
--      cresce (15 minutos, depois 1 hora). Só um acerto zera. Isso vale para entrar, desbloquear, trocar o PIN e "esqueci o PIN".
--   3. O aparelho recebe um código aleatório; o banco guarda só o hash (sha256). O PIN destrava o aparelho por 30 minutos, renovados a cada uso.
--      Depois disso toda função devolve 'bloqueado' e a página pede o PIN. Sem uso por 90 dias o aparelho precisa entrar de novo (celular + PIN).
--   4. O celular NÃO é confirmado por SMS (ainda não existe esse envio). Por isso o número de confiança não ganha acesso só por ser o mesmo
--      celular: o titular recebe um CÓDIGO de 6 dígitos por contato e precisa passá-lo à pessoa (WhatsApp, voz). A pessoa digita o código no app dela.
--      Sem esse código, quem cadastrar antes o celular de outra pessoa não enxerga os filhos de ninguém. 5 códigos errados invalidam o código.
--   5. "Esqueci o PIN" confere celular + nome + nascimento (como pedido). Isso é conhecimento que familiares e vazamentos têm: por isso conta nas
--      mesmas tentativas do PIN, derruba os outros aparelhos e grava o evento (sem dado pessoal) em app_evento. Recomendação: trocar por código SMS.
--   6. A equipe lê as solicitações por painel_app_solicitacoes (admin e atendente). A ligação com o cadastro da clínica (public.pacientes) é só uma
--      SUGESTÃO (paciente_sugerido_id: mesmo celular + nascimento + nome); nunca vincula sozinha, como em contas_paciente.
--
-- ATIVAÇÃO: nasce DESLIGADO. Para ligar (e para desligar de novo na hora, sem publicar nada):
--     update public.config set valor = 'sim' where chave = 'app_acesso_modo';   -- 'nao' desliga
--
-- ROLLBACK (nada de outras tabelas é alterado; só a chave de config é inserida):
--   drop function if exists public.painel_app_solicitacao_status(uuid, text), public.painel_app_solicitacoes(text), public.app_sair(text),
--     public.app_pin_esqueci(text, text, text, text, text), public.app_pin_trocar(text, text, text), public.app_selecao_salvar(text, jsonb),
--     public.app_marcacao_cancelar(text, uuid), public.app_marcar(text, jsonb, text, text, text, text), public.app_confianca_aceitar(text, text),
--     public.app_confianca_novo_codigo(text, uuid), public.app_confianca_remover(text, uuid), public.app_confianca_salvar(text, text, text, text),
--     public.app_filho_remover(text, uuid), public.app_filho_salvar(text, text, text), public.app_perfil(text), public.app_desbloquear(text, text),
--     public.app_login(text, text, text), public.app_cadastrar(text, text, text, text, jsonb, jsonb, text);
--   drop function if exists public.app_perfil_json(uuid), public.app_aparelho_validar(text, boolean), public.app_aparelho_abrir(uuid, text), public.app_acerto(uuid),
--     public.app_falha(uuid), public.app_trava(uuid), public.app_evento_gravar(uuid, text), public.app_confianca_gerar_codigo(), public.app_idade(date), public.app_hoje(),
--     public.app_data(text), public.app_nome_ok(text), public.app_norm(text), public.app_modo();
--   drop table if exists public.app_evento, public.app_marcacao, public.app_contato_confianca, public.app_filho, public.app_aparelho, public.app_paciente;
--   delete from public.config where chave in ('app_acesso_modo', 'app_cadastros_max_hora');
-- Pode ser aplicado mais de uma vez. Os "drop" acima são do ROLLBACK (não rodam aqui).

-- ============================================================== PARTE 1: interruptor e tabelas
insert into public.config (chave, valor) values ('app_acesso_modo', 'nao'), ('app_cadastros_max_hora', '100') on conflict (chave) do nothing;

create table if not exists public.app_paciente (
  id uuid primary key default gen_random_uuid(),
  telefone text not null unique check (telefone ~ '^[1-9]{2}9[0-9]{8}$'),
  nome text not null check (length(btrim(nome)) between 5 and 120),
  nascimento date not null check (nascimento >= date '1900-01-01'),
  pin_hash text not null,
  pin_falhas integer not null default 0,
  pin_bloqueado_ate timestamptz,
  ultima_selecao jsonb not null default '["eu"]'::jsonb,
  paciente_sugerido_id uuid references public.pacientes (id) on delete set null,
  telefone_verificado_em timestamptz,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  ultimo_acesso_em timestamptz
);
comment on table public.app_paciente is 'Titular do acesso rápido (celular + PIN). telefone = login (só dígitos, DDD + 9). pin_hash = bcrypt; pin_falhas conta erros seguidos (bloqueio crescente). paciente_sugerido_id é só uma sugestão para a equipe conferir. telefone_verificado_em fica vazio enquanto não houver código por SMS. Sem acesso direto: só as funções app_* e painel_app_*.';
create index if not exists app_paciente_sugerido on public.app_paciente (paciente_sugerido_id) where paciente_sugerido_id is not null;

create table if not exists public.app_aparelho (
  id uuid primary key default gen_random_uuid(),
  paciente_id uuid not null references public.app_paciente (id) on delete cascade,
  token_hash text not null unique,
  aparelho text,
  criado_em timestamptz not null default now(),
  ultimo_uso_em timestamptz not null default now(),
  desbloqueada_ate timestamptz
);
comment on table public.app_aparelho is 'Aparelhos que entraram no acesso rápido. Guarda só o sha256 do código do aparelho. desbloqueada_ate = até quando o PIN digitado vale (renova a cada uso). No máximo 5 por titular.';
create index if not exists app_aparelho_paciente on public.app_aparelho (paciente_id, ultimo_uso_em);

create table if not exists public.app_filho (
  id uuid primary key default gen_random_uuid(),
  responsavel_id uuid not null references public.app_paciente (id) on delete cascade,
  nome text not null check (length(btrim(nome)) between 5 and 120),
  nascimento date not null check (nascimento >= date '1900-01-01'),
  criado_em timestamptz not null default now(),
  removido_em timestamptz
);
comment on table public.app_filho is 'Filhos do titular. Remover só marca removido_em (as solicitações antigas continuam legíveis para a equipe). A qualquer momento o titular pode cadastrar outro.';
create index if not exists app_filho_responsavel on public.app_filho (responsavel_id) where removido_em is null;

create table if not exists public.app_contato_confianca (
  id uuid primary key default gen_random_uuid(),
  responsavel_id uuid not null references public.app_paciente (id) on delete cascade,
  nome text not null check (length(btrim(nome)) between 2 and 120),
  telefone text not null check (telefone ~ '^[1-9]{2}9[0-9]{8}$'),
  relacao text not null check (relacao in ('Cônjuge', 'Pai/Mãe', 'Avó/Avô', 'Irmão(ã)', 'Outro')),
  codigo text not null check (codigo ~ '^[0-9]{6}$'),
  codigo_falhas integer not null default 0,
  vinculado_a uuid references public.app_paciente (id) on delete set null,
  vinculado_em timestamptz,
  criado_em timestamptz not null default now(),
  removido_em timestamptz
);
comment on table public.app_contato_confianca is 'Número de confiança do titular. Só enxerga filhos e solicitações depois de digitar o codigo (6 dígitos que o titular passou) no app do próprio celular: vinculado_a é a conta dessa pessoa. 5 códigos errados invalidam o código (o titular gera outro).';
create unique index if not exists app_contato_unico on public.app_contato_confianca (responsavel_id, telefone) where removido_em is null;
create index if not exists app_contato_telefone on public.app_contato_confianca (telefone) where removido_em is null;
create index if not exists app_contato_vinculado on public.app_contato_confianca (vinculado_a) where removido_em is null and vinculado_a is not null;

create table if not exists public.app_marcacao (
  id uuid primary key default gen_random_uuid(),
  grupo uuid not null,
  responsavel_id uuid not null references public.app_paciente (id) on delete cascade,
  filho_id uuid references public.app_filho (id) on delete set null,
  pessoa_nome text not null,
  pessoa_nascimento date not null,
  exame text not null check (length(btrim(exame)) between 1 and 80),
  data_preferida date not null,
  turno text not null check (turno in ('Qualquer horário', 'Manhã', 'Tarde')),
  obs text check (obs is null or length(obs) <= 500),
  status text not null default 'solicitada' check (status in ('solicitada', 'confirmada', 'cancelada', 'concluida')),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
comment on table public.app_marcacao is 'Solicitação de marcação (NÃO é agendamento: a equipe confirma). Uma linha por pessoa; as do mesmo pedido "Todos juntos" dividem o grupo. filho_id vazio = o próprio titular. Nome e nascimento ficam copiados para a equipe ler mesmo se o filho for removido.';
create index if not exists app_marcacao_responsavel on public.app_marcacao (responsavel_id, status);
create index if not exists app_marcacao_grupo on public.app_marcacao (grupo);
create index if not exists app_marcacao_filho on public.app_marcacao (filho_id) where filho_id is not null;
create index if not exists app_marcacao_abertas on public.app_marcacao (criado_em) where status = 'solicitada';

create table if not exists public.app_evento (
  id bigint generated always as identity primary key,
  paciente_id uuid references public.app_paciente (id) on delete set null,
  tipo text not null,
  criado_em timestamptz not null default now()
);
comment on table public.app_evento is 'Registro sem dado pessoal: cadastro, entrada em aparelho novo, PIN trocado ou redefinido, bloqueio, número de confiança vinculado. Serve para a equipe investigar abuso.';
create index if not exists app_evento_recente on public.app_evento (criado_em desc);

do $$ declare t text; begin
  foreach t in array array['app_paciente', 'app_aparelho', 'app_filho', 'app_contato_confianca', 'app_marcacao', 'app_evento'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence public.app_evento_id_seq from anon, authenticated;

-- ============================================================== PARTE 2: ajudantes internos (ninguém do público executa)
create or replace function public.app_modo() returns boolean language sql stable security definer set search_path to '' as $$
  select coalesce((select valor from public.config where chave = 'app_acesso_modo'), 'nao') = 'sim' $$;

create or replace function public.app_norm(t text) returns text language sql stable set search_path to '' as $$
  select lower(extensions.unaccent(btrim(regexp_replace(coalesce(t, ''), '\s+', ' ', 'g')))) $$;

-- Nome completo: letras, espaço, ponto, apóstrofo e hífen; ao menos duas palavras com 2 letras ou mais.
create or replace function public.app_nome_ok(t text) returns boolean language sql immutable set search_path to '' as $$
  select length(btrim(coalesce(t, ''))) between 5 and 120
     and btrim(t) ~ '^[A-Za-zÀ-ÿ''. -]+$'
     and (select count(*) from regexp_split_to_table(btrim(t), '\s+') as w where length(w) >= 2) >= 2 $$;

-- 'AAAA-MM-DD' -> date, ou nulo se não for uma data de verdade.
create or replace function public.app_data(t text) returns date language plpgsql immutable set search_path to '' as $$
begin
  if t is null or t !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  return t::date;
exception when others then return null;
end $$;

create or replace function public.app_hoje() returns date language sql stable set search_path to '' as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;
create or replace function public.app_idade(d date) returns integer language sql stable set search_path to '' as $$ select extract(year from age(public.app_hoje(), d))::int $$;

-- Código de 6 dígitos do número de confiança (aleatório do banco, não previsível).
create or replace function public.app_confianca_gerar_codigo() returns text language sql volatile set search_path to '' as $$
  select lpad((('x' || substr(md5(gen_random_uuid()::text), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0') $$;

create or replace function public.app_evento_gravar(p_pac uuid, p_tipo text) returns void language sql security definer set search_path to '' as $$
  insert into public.app_evento (paciente_id, tipo) values (p_pac, p_tipo) $$;

create or replace function public.app_bloqueado_json(p_seg integer) returns jsonb language sql immutable set search_path to '' as $$
  select jsonb_build_object('ok', false, 'erro', 'bloqueado', 'segundos', p_seg,
    'mensagem', 'Muitas tentativas. Aguarde ' || case when p_seg <= 60 then '1 minuto' else ceil(p_seg / 60.0)::int || ' minutos' end || '.') $$;

-- Segundos que faltam do bloqueio por tentativas (0 = livre). Quem chama já trancou a linha do titular (for update).
create or replace function public.app_trava(p_id uuid) returns integer language sql security definer set search_path to '' as $$
  select coalesce((select ceil(extract(epoch from (a.pin_bloqueado_ate - now())))::int from public.app_paciente a where a.id = p_id and a.pin_bloqueado_ate > now()), 0) $$;

-- Registra UM erro de PIN (ou de dados do "esqueci"). A cada 5 erros seguidos bloqueia: 1 min, depois 15 min, depois 1 hora. Só app_acerto zera.
create or replace function public.app_falha(p_id uuid) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_falhas integer; v_seg integer;
begin
  update public.app_paciente set pin_falhas = pin_falhas + 1 where id = p_id returning pin_falhas into v_falhas;
  if v_falhas is null then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'PIN incorreto.'); end if;
  if v_falhas % 5 = 0 then
    v_seg := case when v_falhas <= 5 then 60 when v_falhas <= 10 then 900 else 3600 end;
    update public.app_paciente set pin_bloqueado_ate = now() + make_interval(secs => v_seg) where id = p_id;
    perform public.app_evento_gravar(p_id, 'bloqueio');
    return public.app_bloqueado_json(v_seg);
  end if;
  return jsonb_build_object('ok', false, 'erro', 'pin', 'restantes', 5 - (v_falhas % 5),
    'mensagem', case when 5 - (v_falhas % 5) = 1 then 'PIN incorreto. Resta 1 tentativa.' else 'PIN incorreto. Restam ' || (5 - (v_falhas % 5)) || ' tentativas.' end);
end $$;

create or replace function public.app_acerto(p_id uuid) returns void language sql security definer set search_path to '' as $$
  update public.app_paciente set pin_falhas = 0, pin_bloqueado_ate = null where id = p_id and (pin_falhas <> 0 or pin_bloqueado_ate is not null) $$;

-- Abre um aparelho novo: devolve o código (só aqui ele existe em texto; o banco guarda o hash). No máximo 5 aparelhos por titular.
create or replace function public.app_aparelho_abrir(p_pac uuid, p_aparelho text) returns text language plpgsql security definer set search_path to '' as $$
declare v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  insert into public.app_aparelho (paciente_id, token_hash, aparelho, desbloqueada_ate)
  values (p_pac, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), left(nullif(btrim(coalesce(p_aparelho, '')), ''), 120), now() + interval '30 minutes');
  delete from public.app_aparelho where id in (select id from public.app_aparelho where paciente_id = p_pac order by ultimo_uso_em desc offset 5);
  update public.app_paciente set ultimo_acesso_em = now() where id = p_pac;
  return v_token;
end $$;

-- Confere o código do aparelho. p_exige = o PIN precisa ter sido digitado nos últimos 30 minutos (renovados a cada uso).
-- erros: indisponivel (interruptor desligado) | sessao (aparelho desconhecido ou parado há 90 dias) | bloqueado (falta digitar o PIN)
create or replace function public.app_aparelho_validar(p_token text, p_exige boolean default true, out o_pac uuid, out o_aparelho uuid, out o_erro text)
language plpgsql security definer set search_path to '' as $$
declare a public.app_aparelho%rowtype;
begin
  if not public.app_modo() then o_erro := 'indisponivel'; return; end if;
  select * into a from public.app_aparelho where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
  if not found or a.ultimo_uso_em < now() - interval '90 days' then o_erro := 'sessao'; return; end if;
  if p_exige and (a.desbloqueada_ate is null or a.desbloqueada_ate < now()) then o_erro := 'bloqueado'; return; end if;
  update public.app_aparelho set ultimo_uso_em = now(),
    desbloqueada_ate = case when p_exige then now() + interval '30 minutes' else desbloqueada_ate end where id = a.id;
  o_pac := a.paciente_id; o_aparelho := a.id;
end $$;

create or replace function public.app_erro_json(p_erro text) returns jsonb language sql immutable set search_path to '' as $$
  select jsonb_build_object('ok', false, 'erro', p_erro, 'mensagem', case p_erro
    when 'indisponivel' then 'O acesso rápido ainda não está disponível. Fale com a clínica.'
    when 'sessao' then 'Entre de novo com seu celular e PIN.'
    when 'bloqueado' then 'Digite seu PIN para continuar.'
    else 'Não foi possível concluir.' end) $$;

-- Solicitações de um titular (sem as canceladas), das mais novas para as mais antigas.
create or replace function public.app_marcacoes_json(p_pac uuid) returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'grupo', m.grupo, 'pessoa_id', coalesce(m.filho_id::text, 'eu'), 'pessoa_nome', m.pessoa_nome,
    'pessoa_nascimento', m.pessoa_nascimento, 'exame', m.exame, 'data', m.data_preferida, 'turno', m.turno, 'obs', m.obs, 'status', m.status, 'criado_em', m.criado_em)
    order by m.criado_em desc, m.id), '[]'::jsonb)
  from (select * from public.app_marcacao where responsavel_id = p_pac and status <> 'cancelada' order by criado_em desc limit 100) m $$;

-- Tudo o que a página precisa mostrar. 'codigo' só aparece enquanto o número de confiança ainda não digitou o código.
create or replace function public.app_perfil_json(p_pac uuid) returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'nome', a.nome, 'nascimento', a.nascimento, 'telefone', a.telefone, 'selecao', a.ultima_selecao,
    'filhos', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nome', f.nome, 'nascimento', f.nascimento) order by f.criado_em, f.id)
                        from public.app_filho f where f.responsavel_id = a.id and f.removido_em is null), '[]'::jsonb),
    'confiaveis', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'telefone', c.telefone, 'relacao', c.relacao,
                              'vinculado', c.vinculado_em is not null, 'codigo', case when c.vinculado_em is null then c.codigo end,
                              'codigo_invalido', c.vinculado_em is null and c.codigo_falhas >= 5) order by c.criado_em, c.id)
                            from public.app_contato_confianca c where c.responsavel_id = a.id and c.removido_em is null), '[]'::jsonb),
    'marcacoes', public.app_marcacoes_json(a.id),
    'confiam_em_mim', coalesce((select jsonb_agg(jsonb_build_object('contato_id', c.id, 'titular_nome', t.nome,
                              'filhos', coalesce((select jsonb_agg(jsonb_build_object('nome', f.nome, 'nascimento', f.nascimento) order by f.criado_em, f.id)
                                                  from public.app_filho f where f.responsavel_id = t.id and f.removido_em is null), '[]'::jsonb),
                              'marcacoes', public.app_marcacoes_json(t.id)) order by c.vinculado_em, c.id)
                            from public.app_contato_confianca c join public.app_paciente t on t.id = c.responsavel_id
                            where c.vinculado_a = a.id and c.removido_em is null and c.vinculado_em is not null), '[]'::jsonb))
  from public.app_paciente a where a.id = p_pac $$;

-- ============================================================== PARTE 3: cadastro, entrada, desbloqueio e PIN
-- Primeiro acesso. Devolve o código do aparelho (a página guarda só ele) e o perfil. Erros esperados voltam como {ok:false, erro, mensagem}.
create or replace function public.app_cadastrar(p_telefone text, p_nome text, p_nascimento text, p_pin text,
  p_filhos jsonb default '[]'::jsonb, p_confianca jsonb default null, p_aparelho text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_nasc date := public.app_data(p_nascimento);
  v_filhos jsonb := coalesce(p_filhos, '[]'::jsonb);
  v_f jsonb; v_fd date; v_id uuid; v_sug uuid; v_max integer; v_ctel text; v_token text;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if v_tel !~ '^[1-9]{2}9[0-9]{8}$' then return jsonb_build_object('ok', false, 'erro', 'celular', 'mensagem', 'Celular inválido. Use DDD + 9 dígitos.'); end if;
  if not public.app_nome_ok(v_nome) then return jsonb_build_object('ok', false, 'erro', 'nome', 'mensagem', 'Digite nome e sobrenome completos.'); end if;
  if v_nasc is null or v_nasc > public.app_hoje() or v_nasc < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'nascimento', 'mensagem', 'Data de nascimento inválida.'); end if;
  if public.app_idade(v_nasc) < 18 then return jsonb_build_object('ok', false, 'erro', 'menor', 'mensagem', 'O cadastro principal precisa ser de um maior de 18 anos.'); end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'O PIN precisa ter 4 números.'); end if;
  if jsonb_typeof(v_filhos) <> 'array' or jsonb_array_length(v_filhos) > 10 then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Lista de filhos inválida (no máximo 10).'); end if;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_fd := public.app_data(v_f ->> 'nascimento');
    if jsonb_typeof(v_f) <> 'object' or not public.app_nome_ok(v_f ->> 'nome') then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Informe nome e sobrenome do filho(a).'); end if;
    if v_fd is null or v_fd > public.app_hoje() or v_fd < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Data de nascimento do filho(a) inválida.'); end if;
  end loop;
  if p_confianca is not null and p_confianca <> 'null'::jsonb then
    v_ctel := regexp_replace(coalesce(p_confianca ->> 'telefone', ''), '\D', '', 'g');
    if jsonb_typeof(p_confianca) <> 'object' or length(btrim(coalesce(p_confianca ->> 'nome', ''))) < 2 or v_ctel !~ '^[1-9]{2}9[0-9]{8}$'
       or coalesce(p_confianca ->> 'relacao', '') not in ('Cônjuge', 'Pai/Mãe', 'Avó/Avô', 'Irmão(ã)', 'Outro') then
      return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Dados do número de confiança inválidos.');
    end if;
    if v_ctel = v_tel then return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Use um número diferente do seu.'); end if;
  end if;
  -- Freio contra criação em massa de contas.
  select case when valor ~ '^[0-9]+$' then valor::int end into v_max from public.config where chave = 'app_cadastros_max_hora';
  if (select count(*) from public.app_paciente where criado_em > now() - interval '1 hour') >= coalesce(v_max, 100) then
    return jsonb_build_object('ok', false, 'erro', 'limite', 'mensagem', 'Muitos cadastros agora. Tente de novo em alguns minutos.');
  end if;
  if exists (select 1 from public.app_paciente where telefone = v_tel) then
    return jsonb_build_object('ok', false, 'erro', 'telefone_cadastrado', 'mensagem', 'Este celular já tem cadastro. Entre com o seu PIN.');
  end if;
  -- Sugestão (nunca vínculo) de quem já é paciente da clínica: mesmo celular + nascimento + nome, e uma única pessoa. Nunca derruba o cadastro.
  begin
    select (array_agg(p.id))[1] into v_sug from public.pacientes p
     where p.dt_nasc = v_nasc and p.telefones && array[v_tel, '55' || v_tel] and public.app_norm(p.nome) = public.app_norm(v_nome) having count(*) = 1;
  exception when others then v_sug := null;
  end;
  begin
    insert into public.app_paciente (telefone, nome, nascimento, pin_hash, paciente_sugerido_id)
    values (v_tel, v_nome, v_nasc, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)), v_sug) returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'erro', 'telefone_cadastrado', 'mensagem', 'Este celular já tem cadastro. Entre com o seu PIN.');
  end;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    insert into public.app_filho (responsavel_id, nome, nascimento, criado_em)   -- clock_timestamp: a ordem digitada é a ordem mostrada
    values (v_id, btrim(regexp_replace(v_f ->> 'nome', '\s+', ' ', 'g')), public.app_data(v_f ->> 'nascimento'), clock_timestamp());
  end loop;
  if v_ctel is not null then
    insert into public.app_contato_confianca (responsavel_id, nome, telefone, relacao, codigo)
    values (v_id, btrim(p_confianca ->> 'nome'), v_ctel, p_confianca ->> 'relacao', public.app_confianca_gerar_codigo());
  end if;
  v_token := public.app_aparelho_abrir(v_id, p_aparelho);
  perform public.app_evento_gravar(v_id, 'cadastro');
  return jsonb_build_object('ok', true, 'token', v_token, 'perfil', public.app_perfil_json(v_id));
end $$;

-- Aparelho novo de quem já tem cadastro (trocou de celular, limpou o navegador): celular + PIN.
create or replace function public.app_login(p_telefone text, p_pin text, p_aparelho text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); a public.app_paciente%rowtype; v_seg integer; r jsonb; v_token text;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  select * into a from public.app_paciente where telefone = v_tel for update;
  if not found then
    perform extensions.crypt(coalesce(p_pin, ''), extensions.gen_salt('bf', 8));   -- gasta o mesmo tempo: não revela se o celular existe
    return jsonb_build_object('ok', false, 'erro', 'login', 'mensagem', 'Celular ou PIN incorretos.');
  end if;
  v_seg := public.app_trava(a.id);
  if v_seg > 0 then return public.app_bloqueado_json(v_seg); end if;
  if coalesce(p_pin, '') ~ '^[0-9]{4}$' and a.pin_hash = extensions.crypt(p_pin, a.pin_hash) then
    perform public.app_acerto(a.id);
    v_token := public.app_aparelho_abrir(a.id, p_aparelho);
    perform public.app_evento_gravar(a.id, 'login_aparelho_novo');
    return jsonb_build_object('ok', true, 'token', v_token, 'perfil', public.app_perfil_json(a.id));
  end if;
  r := public.app_falha(a.id);
  if r ->> 'erro' = 'bloqueado' then return r; end if;
  return jsonb_build_object('ok', false, 'erro', 'login', 'mensagem', 'Celular ou PIN incorretos.');
end $$;

-- Tela do PIN no aparelho de sempre: confere o PIN e libera o aparelho por 30 minutos.
create or replace function public.app_desbloquear(p_token text, p_pin text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record; a public.app_paciente%rowtype; v_seg integer;
begin
  select * into s from public.app_aparelho_validar(p_token, false);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select * into a from public.app_paciente where id = s.o_pac for update;
  v_seg := public.app_trava(a.id);
  if v_seg > 0 then return public.app_bloqueado_json(v_seg); end if;
  if coalesce(p_pin, '') ~ '^[0-9]{4}$' and a.pin_hash = extensions.crypt(p_pin, a.pin_hash) then
    perform public.app_acerto(a.id);
    update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes' where id = s.o_aparelho;
    update public.app_paciente set ultimo_acesso_em = now() where id = a.id;
    return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(a.id));
  end if;
  return public.app_falha(a.id);
end $$;

create or replace function public.app_perfil(p_token text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare s record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $$;

create or replace function public.app_pin_trocar(p_token text, p_atual text, p_novo text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record; a public.app_paciente%rowtype; v_seg integer;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if coalesce(p_novo, '') !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'O PIN precisa ter 4 números.'); end if;
  select * into a from public.app_paciente where id = s.o_pac for update;
  v_seg := public.app_trava(a.id);
  if v_seg > 0 then return public.app_bloqueado_json(v_seg); end if;
  if coalesce(p_atual, '') ~ '^[0-9]{4}$' and a.pin_hash = extensions.crypt(p_atual, a.pin_hash) then
    update public.app_paciente set pin_hash = extensions.crypt(p_novo, extensions.gen_salt('bf', 8)), atualizado_em = now() where id = a.id;
    perform public.app_acerto(a.id);
    perform public.app_evento_gravar(a.id, 'pin_trocado');
    return jsonb_build_object('ok', true);
  end if;
  return public.app_falha(a.id);
end $$;

-- "Esqueci o PIN": celular + nome + nascimento. Conta como erro de PIN, derruba os outros aparelhos e deixa registro.
create or replace function public.app_pin_esqueci(p_telefone text, p_nome text, p_nascimento text, p_pin_novo text, p_aparelho text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); a public.app_paciente%rowtype; v_seg integer; r jsonb; v_token text;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if coalesce(p_pin_novo, '') !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'O PIN precisa ter 4 números.'); end if;
  select * into a from public.app_paciente where telefone = v_tel for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'dados', 'mensagem', 'Os dados não conferem com o cadastro.'); end if;
  v_seg := public.app_trava(a.id);
  if v_seg > 0 then return public.app_bloqueado_json(v_seg); end if;
  if public.app_norm(p_nome) = public.app_norm(a.nome) and public.app_data(p_nascimento) = a.nascimento then
    update public.app_paciente set pin_hash = extensions.crypt(p_pin_novo, extensions.gen_salt('bf', 8)), atualizado_em = now() where id = a.id;
    perform public.app_acerto(a.id);
    delete from public.app_aparelho where paciente_id = a.id;
    v_token := public.app_aparelho_abrir(a.id, p_aparelho);
    perform public.app_evento_gravar(a.id, 'pin_redefinido');
    return jsonb_build_object('ok', true, 'token', v_token, 'perfil', public.app_perfil_json(a.id));
  end if;
  r := public.app_falha(a.id);
  if r ->> 'erro' = 'bloqueado' then return r; end if;
  return jsonb_build_object('ok', false, 'erro', 'dados', 'restantes', r -> 'restantes', 'mensagem', 'Os dados não conferem com o cadastro.');
end $$;

create or replace function public.app_sair(p_token text) returns jsonb language sql security definer set search_path to '' as $$
  with apagado as (delete from public.app_aparelho where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') returning 1)
  select jsonb_build_object('ok', true) $$;

-- ============================================================== PARTE 4: filhos, números de confiança, marcações, equipe e permissões
-- Adicionar filho: a qualquer momento (até 10). O mesmo nome + nascimento duas vezes (toque duplo) não cria outro.
create or replace function public.app_filho_salvar(p_token text, p_nome text, p_nascimento text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record; v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')); v_nasc date := public.app_data(p_nascimento);
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if not public.app_nome_ok(v_nome) then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Informe nome e sobrenome do filho(a).'); end if;
  if v_nasc is null or v_nasc > public.app_hoje() or v_nasc < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Data de nascimento inválida.'); end if;
  if not exists (select 1 from public.app_filho where responsavel_id = s.o_pac and removido_em is null and nascimento = v_nasc and public.app_norm(nome) = public.app_norm(v_nome)) then
    if (select count(*) from public.app_filho where responsavel_id = s.o_pac and removido_em is null) >= 10 then
      return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Limite de 10 filhos. Fale com a clínica para cadastrar mais.');
    end if;
    insert into public.app_filho (responsavel_id, nome, nascimento) values (s.o_pac, v_nome, v_nasc);
  end if;
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $$;

create or replace function public.app_filho_remover(p_token text, p_id uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  update public.app_filho set removido_em = now() where id = p_id and responsavel_id = s.o_pac and removido_em is null;
  if found then
    update public.app_marcacao set status = 'cancelada', atualizado_em = now() where filho_id = p_id and responsavel_id = s.o_pac and status = 'solicitada';
  end if;
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $$;

-- Número de confiança (até 5). Devolve no perfil o código de 6 dígitos que o titular passa à pessoa.
create or replace function public.app_confianca_salvar(p_token text, p_nome text, p_telefone text, p_relacao text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record; v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')); v_meu text;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select telefone into v_meu from public.app_paciente where id = s.o_pac;
  if length(v_nome) < 2 or length(v_nome) > 120 then return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Informe o nome do contato.'); end if;
  if v_tel !~ '^[1-9]{2}9[0-9]{8}$' then return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Celular inválido. Use DDD + 9 dígitos.'); end if;
  if v_tel = v_meu then return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Use um número diferente do seu.'); end if;
  if coalesce(p_relacao, '') not in ('Cônjuge', 'Pai/Mãe', 'Avó/Avô', 'Irmão(ã)', 'Outro') then return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Escolha a relação.'); end if;
  if exists (select 1 from public.app_contato_confianca where responsavel_id = s.o_pac and telefone = v_tel and removido_em is null) then
    update public.app_contato_confianca set nome = v_nome, relacao = p_relacao where responsavel_id = s.o_pac and telefone = v_tel and removido_em is null;
  else
    if (select count(*) from public.app_contato_confianca where responsavel_id = s.o_pac and removido_em is null) >= 5 then
      return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Limite de 5 números de confiança.');
    end if;
    insert into public.app_contato_confianca (responsavel_id, nome, telefone, relacao, codigo) values (s.o_pac, v_nome, v_tel, p_relacao, public.app_confianca_gerar_codigo());
  end if;
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $$;

create or replace function public.app_confianca_remover(p_token text, p_id uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  update public.app_contato_confianca set removido_em = now() where id = p_id and responsavel_id = s.o_pac and removido_em is null;
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $$;

-- Código novo (o antigo deixa de valer). Só enquanto a pessoa ainda não digitou o código.
create or replace function public.app_confianca_novo_codigo(p_token text, p_id uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  update public.app_contato_confianca set codigo = public.app_confianca_gerar_codigo(), codigo_falhas = 0
   where id = p_id and responsavel_id = s.o_pac and removido_em is null and vinculado_em is null;
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $$;

-- Quem foi cadastrado como número de confiança digita o código que recebeu. Só vale para o contato cadastrado COM O CELULAR DESTA CONTA.
create or replace function public.app_confianca_aceitar(p_token text, p_codigo text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record; v_cod text := regexp_replace(coalesce(p_codigo, ''), '\D', '', 'g'); v_meu text; v_cid uuid;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select telefone into v_meu from public.app_paciente where id = s.o_pac;
  if v_cod ~ '^[0-9]{6}$' then
    select c.id into v_cid from public.app_contato_confianca c
     where c.telefone = v_meu and c.removido_em is null and c.vinculado_em is null and c.codigo_falhas < 5 and c.codigo = v_cod
     order by c.criado_em limit 1 for update;
  end if;
  if v_cid is not null then
    update public.app_contato_confianca set vinculado_a = s.o_pac, vinculado_em = now() where id = v_cid;
    perform public.app_evento_gravar(s.o_pac, 'confianca_vinculada');
    return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
  end if;
  update public.app_contato_confianca set codigo_falhas = codigo_falhas + 1 where telefone = v_meu and removido_em is null and vinculado_em is null;
  return jsonb_build_object('ok', false, 'erro', 'codigo', 'mensagem', 'Código inválido ou vencido. Peça um novo a quem cadastrou o seu número.');
end $$;

create or replace function public.app_selecao_salvar(p_token text, p_selecao jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if jsonb_typeof(coalesce(p_selecao, 'null'::jsonb)) <> 'array' or jsonb_array_length(p_selecao) not between 1 and 11
     or exists (select 1 from jsonb_array_elements(p_selecao) e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^(eu|[0-9a-f-]{36})$') then
    return jsonb_build_object('ok', false, 'erro', 'selecao', 'mensagem', 'Seleção inválida.');
  end if;
  update public.app_paciente set ultima_selecao = p_selecao where id = s.o_pac;
  return jsonb_build_object('ok', true);
end $$;

-- Nova marcação: UMA solicitação por pessoa escolhida ('eu' e/ou ids de filhos), todas no mesmo grupo. Não agenda: a equipe confirma.
create or replace function public.app_marcar(p_token text, p_pessoas jsonb, p_exame text, p_data text, p_turno text, p_obs text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record; a public.app_paciente%rowtype; v_data date := public.app_data(p_data); v_grupo uuid := gen_random_uuid(); v_obs text := nullif(btrim(coalesce(p_obs, '')), '');
        v_exame text := btrim(coalesce(p_exame, '')); e text; f public.app_filho%rowtype; v_vistos text[] := '{}';
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if jsonb_typeof(coalesce(p_pessoas, 'null'::jsonb)) <> 'array' or jsonb_array_length(p_pessoas) not between 1 and 11 then
    return jsonb_build_object('ok', false, 'erro', 'pessoas', 'mensagem', 'Escolha para quem é a marcação.');
  end if;
  if length(v_exame) not between 1 and 80 then return jsonb_build_object('ok', false, 'erro', 'exame', 'mensagem', 'Escolha o exame ou a consulta.'); end if;
  if v_data is null or v_data < public.app_hoje() or v_data > public.app_hoje() + 730 then return jsonb_build_object('ok', false, 'erro', 'data', 'mensagem', 'Escolha uma data a partir de hoje.'); end if;
  if coalesce(p_turno, '') not in ('Qualquer horário', 'Manhã', 'Tarde') then return jsonb_build_object('ok', false, 'erro', 'turno', 'mensagem', 'Escolha o turno.'); end if;
  if v_obs is not null and length(v_obs) > 500 then return jsonb_build_object('ok', false, 'erro', 'obs', 'mensagem', 'A observação pode ter até 500 letras.'); end if;
  select * into a from public.app_paciente where id = s.o_pac;
  if (select count(distinct grupo) from public.app_marcacao where responsavel_id = a.id and status = 'solicitada') >= 30 then
    return jsonb_build_object('ok', false, 'erro', 'limite', 'mensagem', 'Você já tem 30 solicitações aguardando. Cancele alguma ou fale com a clínica.');
  end if;
  for e in select jsonb_array_elements_text(p_pessoas) loop
    if e = any (v_vistos) then continue; end if;
    v_vistos := v_vistos || e;
    if e = 'eu' then
      insert into public.app_marcacao (grupo, responsavel_id, filho_id, pessoa_nome, pessoa_nascimento, exame, data_preferida, turno, obs)
      values (v_grupo, a.id, null, a.nome, a.nascimento, v_exame, v_data, p_turno, v_obs);
    elsif e ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into f from public.app_filho where id = e::uuid and responsavel_id = a.id and removido_em is null;
      if not found then raise exception 'pessoa_invalida' using errcode = 'P0001'; end if;
      insert into public.app_marcacao (grupo, responsavel_id, filho_id, pessoa_nome, pessoa_nascimento, exame, data_preferida, turno, obs)
      values (v_grupo, a.id, f.id, f.nome, f.nascimento, v_exame, v_data, p_turno, v_obs);
    else
      raise exception 'pessoa_invalida' using errcode = 'P0001';
    end if;
  end loop;
  update public.app_paciente set ultima_selecao = p_pessoas where id = a.id;
  return jsonb_build_object('ok', true, 'grupo', v_grupo, 'perfil', public.app_perfil_json(a.id));
exception when sqlstate 'P0001' then
  if sqlerrm = 'pessoa_invalida' then return jsonb_build_object('ok', false, 'erro', 'pessoas', 'mensagem', 'Pessoa não encontrada no seu cadastro.'); end if;
  raise;
end $$;

create or replace function public.app_marcacao_cancelar(p_token text, p_grupo uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  update public.app_marcacao set status = 'cancelada', atualizado_em = now() where grupo = p_grupo and responsavel_id = s.o_pac and status = 'solicitada';
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $$;

-- ---- Equipe (administrador e atendente): ver e atender as solicitações. Sem tela ainda; usar pelo SQL ou pelo painel quando existir o botão.
create or replace function public.painel_app_solicitacoes(p_status text default 'solicitada') returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê as solicitações.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(g order by g ->> 'criado_em') from (
    select jsonb_build_object('grupo', m.grupo, 'criado_em', min(m.criado_em), 'responsavel', p.nome, 'celular', p.telefone,
      'cadastro_sugerido', p.paciente_sugerido_id is not null,
      'pessoas', jsonb_agg(jsonb_build_object('nome', m.pessoa_nome, 'nascimento', m.pessoa_nascimento, 'filho', m.filho_id is not null) order by m.pessoa_nome),
      'exame', m.exame, 'data_preferida', m.data_preferida, 'turno', m.turno, 'obs', m.obs, 'status', m.status) as g
    from public.app_marcacao m join public.app_paciente p on p.id = m.responsavel_id
    where m.status = coalesce(nullif(p_status, ''), 'solicitada')
    group by m.grupo, p.id, m.exame, m.data_preferida, m.turno, m.obs, m.status limit 500) x), '[]'::jsonb);
end $$;

create or replace function public.painel_app_solicitacao_status(p_grupo uuid, p_status text) returns integer
language plpgsql security definer set search_path to '' as $$
declare n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe atende as solicitações.' using errcode = '42501'; end if;
  if coalesce(p_status, '') not in ('solicitada', 'confirmada', 'concluida', 'cancelada') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
  update public.app_marcacao set status = p_status, atualizado_em = now() where grupo = p_grupo;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---- Permissões: tudo fechado; só as funções do paciente para a chave pública, as da equipe para quem está logado.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as assinatura from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'app\_%' or p.proname like 'painel\_app\_%') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.assinatura);
  end loop;
end $$;
grant execute on function
  public.app_cadastrar(text, text, text, text, jsonb, jsonb, text), public.app_login(text, text, text), public.app_desbloquear(text, text), public.app_perfil(text),
  public.app_pin_trocar(text, text, text), public.app_pin_esqueci(text, text, text, text, text), public.app_sair(text),
  public.app_filho_salvar(text, text, text), public.app_filho_remover(text, uuid),
  public.app_confianca_salvar(text, text, text, text), public.app_confianca_remover(text, uuid), public.app_confianca_novo_codigo(text, uuid), public.app_confianca_aceitar(text, text),
  public.app_selecao_salvar(text, jsonb), public.app_marcar(text, jsonb, text, text, text, text), public.app_marcacao_cancelar(text, uuid)
  to anon, authenticated;
grant execute on function public.painel_app_solicitacoes(text), public.painel_app_solicitacao_status(uuid, text) to authenticated;

-- As funções da conta antiga (supabase/acesso-rapido-conta-antiga.sql) perdem a permissão no bloco acima; devolve se já existirem.
do $$ begin
  if to_regprocedure('public.app_conta_antiga_resumo()') is not null then
    grant execute on function public.app_conta_antiga_resumo(), public.app_conta_antiga_herdar(text, text, text, text, text) to authenticated;
  end if;
end $$;

-- As funções de pendências (supabase/acesso-rapido-pendencias.sql) também perdem a permissão no bloco acima; devolve se já existirem.
do $$ begin
  if to_regprocedure('public.app_pendencias(text)') is not null then
    grant execute on function public.app_pendencias(text), public.app_pendencia_responder(text, text, text, text) to anon, authenticated;
    grant execute on function public.painel_app_revisoes(), public.painel_app_revisao_resolver(uuid) to authenticated;
  end if;
end $$;

-- As funções de filhos (supabase/acesso-rapido-filhos.sql) também perdem a permissão no bloco acima; devolve se já existirem.
do $$ begin
  if to_regprocedure('public.app_filho_adicionar(text, text, text, boolean)') is not null then
    grant execute on function public.app_filho_adicionar(text, text, text, boolean) to anon, authenticated;
    grant execute on function public.app_conta_antiga_filhos(), public.app_conta_antiga_migrar(text, text, text, text, jsonb, text) to authenticated;
  end if;
end $$;
