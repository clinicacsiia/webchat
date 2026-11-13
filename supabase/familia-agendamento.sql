-- FLUXOGRAMA: entrada (a Edge Function klingo-agendamento, com a chave de serviço, chama as funções abaixo; NINGUÉM mais chega às tabelas: RLS ligada e sem política) -> validação (aparelho vivo e não desligado,
--   limite de aparelhos por pessoa, convite de 15 min e uso único, espera de 24 h só quando já existe outro celular com acesso e ninguém respondeu o aviso) -> lógica (pessoa = quem é atendido; aparelho = um celular lembrado;
--   vínculo = o aparelho acompanha aquela pessoa, como "próprio" ou "responsável", nível 1 = marca e acompanha, nível 2 = também abre laudo; fila lenta de leituras do Klingo; linha do tempo da marcação)
--   -> saída (jsonb enxuto; nenhuma função devolve CPF, nascimento ou nome completo: esses dados só existem CIFRADOS em familia_pessoa.dados_cifrados e só a Edge Function tem a chave)
-- Versão 1.0 — 13/11/2026 / Mudança: primeira versão (plano em docs/plano-jornada-familia.md): família, aparelhos lembrados, convite, aviso de acesso, acompanhamento tipo "rastreio", cache e fila lenta da agenda, popularidade por médico.
-- Aplicar em PARTES (a ferramenta de migração expira em 60 s): cada bloco "-- PARTE n" é independente do seguinte e pode rodar de novo (create ... if not exists / create or replace).
-- Voltar atrás: ao fim do arquivo. Nada aqui apaga ou altera tabela que já existe.

-- ============================================================================================================================ PARTE 1: tabelas
create table if not exists public.familia_pessoa (
  id uuid primary key default gen_random_uuid(),
  chave text not null unique,                       -- hash(cpf usado no login | nascimento | nome normalizado): impede duplicar a mesma pessoa
  par_hash text,                                    -- hash(cpf | nascimento): acha a pessoa quando o outro responsável entra pelos dados (gêmeos dividem este valor, por isso não é único)
  primeiro_nome text not null check (char_length(primeiro_nome) between 1 and 40),
  dados_cifrados text not null,                     -- AES-GCM (feito na Edge Function): {cpf, nascimento, nome}; o banco nunca vê o texto
  cpf_de text not null default 'proprio' check (cpf_de in ('proprio', 'responsavel')),   -- criança sem CPF usa o do responsável
  klingo_id text,
  plano_id integer, plano_nome text,
  criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now()
);
create table if not exists public.familia_aparelho (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,                  -- hash do código guardado no celular; o código em si nunca fica aqui
  apelido text check (apelido is null or char_length(apelido) <= 40),
  criado_em timestamptz not null default now(), ultimo_uso timestamptz not null default now(),
  desligado_em timestamptz, desligado_por text
);
create table if not exists public.familia_vinculo (
  aparelho_id uuid not null references public.familia_aparelho (id) on delete cascade,
  pessoa_id uuid not null references public.familia_pessoa (id) on delete cascade,
  papel text not null check (papel in ('proprio', 'responsavel')),
  nivel smallint not null default 1 check (nivel in (1, 2)),
  porta text not null check (porta in ('cpf', 'balcao', 'convite', 'dados')),
  liberado_em timestamptz,                          -- nível 2 só vale quando liberado_em <= agora
  criado_em timestamptz not null default now(),
  primary key (aparelho_id, pessoa_id),
  constraint familia_vinculo_nivel2_ck check (nivel = 1 or liberado_em is not null)
);
create index if not exists familia_pessoa_par_idx on public.familia_pessoa (par_hash);
create index if not exists familia_vinculo_pessoa_idx on public.familia_vinculo (pessoa_id);
create table if not exists public.familia_convite (
  codigo_hash text primary key,
  aparelho_id uuid not null references public.familia_aparelho (id) on delete cascade,
  pessoa_ids uuid[] not null check (cardinality(pessoa_ids) between 1 and 10),
  expira_em timestamptz not null, usado_em timestamptz, usado_por uuid
);
create table if not exists public.familia_aviso (                    -- "Alguém quer acompanhar a Ana. Foi você?"
  id bigint generated always as identity primary key,
  pessoa_id uuid not null references public.familia_pessoa (id) on delete cascade,
  aparelho_pedinte uuid not null references public.familia_aparelho (id) on delete cascade,
  criado_em timestamptz not null default now(),
  resposta text check (resposta in ('liberar', 'bloquear')), respondido_em timestamptz, respondido_por uuid
);
create table if not exists public.familia_marcacao (                 -- uma linha por marcação feita pela página (a "encomenda" que se acompanha)
  voucher_id text primary key,
  pessoa_id uuid not null references public.familia_pessoa (id) on delete cascade,
  grupo_id uuid,                                    -- marcações feitas juntas (pai/mãe com dois filhos)
  procedimento text, profissional text, unidade text, data date, hora text,
  status text not null default 'agendado' check (status in ('agendado', 'confirmado', 'chegou', 'atendido', 'laudo_pronto', 'cancelado', 'remarcado', 'faltou')),
  laudo_pronto_em timestamptz,
  criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now()
);
create index if not exists familia_marcacao_pessoa_idx on public.familia_marcacao (pessoa_id, data);
create table if not exists public.familia_evento (                   -- a linha do tempo ("rastreio")
  id bigint generated always as identity primary key,
  voucher_id text not null references public.familia_marcacao (voucher_id) on delete cascade,
  tipo text not null, criado_em timestamptz not null default now()
);
create index if not exists familia_evento_voucher_idx on public.familia_evento (voucher_id, id);
create table if not exists public.agenda_cache (
  chave text primary key, dados jsonb not null, buscado_em timestamptz not null default now(), valido_ate timestamptz not null
);
create table if not exists public.agenda_fila (                      -- leituras lentas do Klingo: quem está com a página aberta passa na frente
  id bigint generated always as identity primary key,
  chave text not null unique, params jsonb not null,
  prioridade integer not null default 5 check (prioridade between 1 and 9),   -- 1 = agora (pessoa esperando), 9 = pré-carga
  estado text not null default 'espera' check (estado in ('espera', 'rodando', 'feito', 'erro')),
  tentativas integer not null default 0, proximo_em timestamptz not null default now(), ultimo_erro text,
  criado_em timestamptz not null default now(), concluido_em timestamptz
);
create index if not exists agenda_fila_vez_idx on public.agenda_fila (estado, prioridade, proximo_em);
alter table public.familia_pessoa enable row level security;   alter table public.familia_aparelho enable row level security;
alter table public.familia_vinculo enable row level security;  alter table public.familia_convite enable row level security;
alter table public.familia_aviso enable row level security;    alter table public.familia_marcacao enable row level security;
alter table public.familia_evento enable row level security;   alter table public.agenda_cache enable row level security;
alter table public.agenda_fila enable row level security;
revoke all on public.familia_pessoa, public.familia_aparelho, public.familia_vinculo, public.familia_convite, public.familia_aviso, public.familia_marcacao, public.familia_evento, public.agenda_cache, public.agenda_fila from anon, authenticated;
insert into public.config (chave, valor) values ('familia_max_aparelhos', '3'), ('familia_espera_horas', '24'), ('familia_dorme_meses', '12') on conflict (chave) do nothing;

-- ============================================================================================================================ PARTE 2: aparelho e vínculo
create or replace function public.familia_cfg(p_chave text, p_padrao integer) returns integer language sql stable security definer set search_path to '' as $$
  select coalesce((select nullif(valor, '')::integer from public.config where chave = p_chave and valor ~ '^[0-9]{1,4}$'), p_padrao) $$;

create or replace function public.familia_aparelho_criar(p_token_hash text, p_apelido text default null) returns uuid language plpgsql security definer set search_path to '' as $$
declare v uuid;
begin
  if p_token_hash is null or length(p_token_hash) < 32 then raise exception 'token_hash_invalido'; end if;
  insert into public.familia_aparelho (token_hash, apelido) values (p_token_hash, nullif(left(btrim(coalesce(p_apelido, '')), 40), '')) returning id into v;
  return v;
end $$;

-- Lê o aparelho pelo código (hash) e devolve as pessoas que ele acompanha. Aparelho desligado ou parado há mais de N meses não volta: vira "ligar de novo".
create or replace function public.familia_aparelho_ler(p_token_hash text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare a public.familia_aparelho; v_meses integer := public.familia_cfg('familia_dorme_meses', 12);
begin
  select * into a from public.familia_aparelho where token_hash = p_token_hash;
  if not found or a.desligado_em is not null then return jsonb_build_object('ok', false, 'motivo', 'desconhecido'); end if;
  if a.ultimo_uso < now() - make_interval(months => v_meses) then return jsonb_build_object('ok', false, 'motivo', 'dormindo'); end if;
  update public.familia_aparelho set ultimo_uso = now() where id = a.id;
  return jsonb_build_object('ok', true, 'aparelho', a.id, 'apelido', a.apelido, 'pessoas', coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'nome', p.primeiro_nome, 'papel', v.papel, 'porta', v.porta,
        'nivel', case when v.nivel = 2 and v.liberado_em <= now() then 2 else 1 end,
        'espera_ate', case when v.nivel = 2 and v.liberado_em > now() then v.liberado_em end,
        'plano_id', p.plano_id, 'plano', p.plano_nome) order by (v.papel = 'proprio') desc, v.criado_em)
    from public.familia_vinculo v join public.familia_pessoa p on p.id = v.pessoa_id where v.aparelho_id = a.id), '[]'::jsonb));
end $$;

-- Liga o aparelho a uma pessoa. O limite (padrão 3, o "máximo entre aspas") conta aparelhos DESLIGADOS FORA; a recepção muda em config.familia_max_aparelhos.
-- Nunca rebaixa um nível já conquistado. Nível 2 exige p_liberado_em (agora, ou daqui a 24 h na porta "dados").
create or replace function public.familia_vincular(p_aparelho uuid, p_pessoa uuid, p_papel text, p_porta text, p_nivel integer default 1, p_liberado_em timestamptz default null) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_max integer := public.familia_cfg('familia_max_aparelhos', 3); v_n integer; v_ja public.familia_vinculo;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_pessoa::text, 17));
  if not exists (select 1 from public.familia_aparelho where id = p_aparelho and desligado_em is null) then return jsonb_build_object('ok', false, 'motivo', 'aparelho_desligado'); end if;
  select * into v_ja from public.familia_vinculo where aparelho_id = p_aparelho and pessoa_id = p_pessoa;
  if not found then
    select count(*) into v_n from public.familia_vinculo v join public.familia_aparelho a on a.id = v.aparelho_id where v.pessoa_id = p_pessoa and a.desligado_em is null;
    if v_n >= v_max then return jsonb_build_object('ok', false, 'motivo', 'limite_aparelhos', 'limite', v_max); end if;
    insert into public.familia_vinculo (aparelho_id, pessoa_id, papel, nivel, porta, liberado_em) values (p_aparelho, p_pessoa, p_papel, p_nivel, p_porta, case when p_nivel = 2 then coalesce(p_liberado_em, now()) end);
  elsif p_nivel = 2 and (v_ja.nivel = 1 or (v_ja.liberado_em > coalesce(p_liberado_em, now()))) then
    update public.familia_vinculo set nivel = 2, porta = p_porta, liberado_em = coalesce(p_liberado_em, now()) where aparelho_id = p_aparelho and pessoa_id = p_pessoa;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- O aparelho desliga SÓ ele mesmo ("Desligar este celular"). Tirar outro celular é da recepção (função separada, no painel).
create or replace function public.familia_aparelho_desligar(p_aparelho uuid) returns void language sql security definer set search_path to '' as $$
  update public.familia_aparelho set desligado_em = now(), desligado_por = 'proprio' where id = p_aparelho and desligado_em is null $$;

-- ============================================================================================================================ PARTE 3: convite e "eu sei todos os dados"
-- Convite: quem JÁ abre laudo daquela pessoa gera um código de 15 min; quem usa passa a abrir laudo na hora (porta "convite"), como responsável.
create or replace function public.familia_convite_criar(p_aparelho uuid, p_pessoas uuid[], p_codigo_hash text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_ok integer;
begin
  select count(*) into v_ok from public.familia_vinculo v join public.familia_aparelho a on a.id = v.aparelho_id
   where v.aparelho_id = p_aparelho and a.desligado_em is null and v.pessoa_id = any (p_pessoas) and v.nivel = 2 and v.liberado_em <= now();
  if v_ok <> cardinality(p_pessoas) then return jsonb_build_object('ok', false, 'motivo', 'sem_acesso_ao_laudo'); end if;
  delete from public.familia_convite where aparelho_id = p_aparelho and usado_em is null;     -- um convite aberto por vez
  insert into public.familia_convite (codigo_hash, aparelho_id, pessoa_ids, expira_em) values (p_codigo_hash, p_aparelho, p_pessoas, now() + interval '15 minutes');
  return jsonb_build_object('ok', true, 'expira_em', now() + interval '15 minutes');
end $$;

create or replace function public.familia_convite_usar(p_codigo_hash text, p_aparelho uuid) returns jsonb language plpgsql security definer set search_path to '' as $$
declare c public.familia_convite; p uuid; r jsonb; v_feitos integer := 0; v_barrados integer := 0;
begin
  select * into c from public.familia_convite where codigo_hash = p_codigo_hash for update;
  if not found or c.usado_em is not null or c.expira_em < now() then return jsonb_build_object('ok', false, 'motivo', 'convite_invalido'); end if;
  if c.aparelho_id = p_aparelho then return jsonb_build_object('ok', false, 'motivo', 'mesmo_aparelho'); end if;
  foreach p in array c.pessoa_ids loop
    r := public.familia_vincular(p_aparelho, p, 'responsavel', 'convite', 2, now());
    if (r ->> 'ok')::boolean then v_feitos := v_feitos + 1; else v_barrados := v_barrados + 1; end if;
  end loop;
  if v_feitos = 0 then return jsonb_build_object('ok', false, 'motivo', coalesce(r ->> 'motivo', 'convite_invalido')); end if;
  update public.familia_convite set usado_em = now() where codigo_hash = p_codigo_hash;
  return jsonb_build_object('ok', true, 'ligadas', v_feitos, 'barradas', v_barrados);
end $$;

-- "Eu sei todos os dados": a Edge Function JÁ conferiu os quatro dados no Klingo. Aqui só se decide a espera: sem outro celular com acesso, é na hora;
-- com outro celular, abre um aviso para ele e a pessoa espera N horas (24) ou até alguém tocar em "Liberar".
create or replace function public.familia_pedir_por_dados(p_aparelho uuid, p_pessoa uuid, p_papel text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_h integer := public.familia_cfg('familia_espera_horas', 24); v_outros integer; v_lib timestamptz; r jsonb;
begin
  select count(*) into v_outros from public.familia_vinculo v join public.familia_aparelho a on a.id = v.aparelho_id
   where v.pessoa_id = p_pessoa and v.aparelho_id <> p_aparelho and a.desligado_em is null and v.nivel = 2 and v.liberado_em <= now();
  v_lib := case when v_outros = 0 then now() else now() + make_interval(hours => v_h) end;
  r := public.familia_vincular(p_aparelho, p_pessoa, p_papel, 'dados', 2, v_lib);
  if not (r ->> 'ok')::boolean then return r; end if;
  if v_outros > 0 and not exists (select 1 from public.familia_aviso where pessoa_id = p_pessoa and aparelho_pedinte = p_aparelho and resposta is null) then
    insert into public.familia_aviso (pessoa_id, aparelho_pedinte) values (p_pessoa, p_aparelho);
  end if;
  return jsonb_build_object('ok', true, 'espera_ate', case when v_outros > 0 then v_lib end, 'imediato', v_outros = 0);
end $$;

create or replace function public.familia_avisos(p_aparelho uuid) returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'pessoa', p.primeiro_nome, 'desde', x.criado_em) order by x.id), '[]'::jsonb)
    from public.familia_aviso x join public.familia_pessoa p on p.id = x.pessoa_id
   where x.resposta is null and exists (select 1 from public.familia_vinculo v where v.aparelho_id = p_aparelho and v.pessoa_id = x.pessoa_id and v.nivel = 2 and v.liberado_em <= now()) $$;

create or replace function public.familia_aviso_responder(p_aparelho uuid, p_aviso bigint, p_liberar boolean) returns jsonb language plpgsql security definer set search_path to '' as $$
declare x public.familia_aviso;
begin
  select * into x from public.familia_aviso where id = p_aviso and resposta is null for update;
  if not found or not exists (select 1 from public.familia_vinculo where aparelho_id = p_aparelho and pessoa_id = x.pessoa_id and nivel = 2 and liberado_em <= now()) then
    return jsonb_build_object('ok', false, 'motivo', 'aviso_invalido'); end if;
  update public.familia_aviso set resposta = case when p_liberar then 'liberar' else 'bloquear' end, respondido_em = now(), respondido_por = p_aparelho where id = p_aviso;
  if p_liberar then update public.familia_vinculo set liberado_em = now() where aparelho_id = x.aparelho_pedinte and pessoa_id = x.pessoa_id and nivel = 2 and liberado_em > now();
  else delete from public.familia_vinculo where aparelho_id = x.aparelho_pedinte and pessoa_id = x.pessoa_id and porta = 'dados' and nivel = 2 and liberado_em > now(); end if;
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================================================================================ PARTE 4: acompanhamento ("rastreio")
create or replace function public.familia_marcacao_gravar(p jsonb) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_id text := p ->> 'voucher_id'; v_status text := coalesce(nullif(p ->> 'status', ''), 'agendado'); v_antigo text; v_novo boolean := false;
begin
  if v_id is null or v_id !~ '^[0-9]{1,12}$' then raise exception 'voucher_invalido'; end if;
  select status into v_antigo from public.familia_marcacao where voucher_id = v_id;
  if not found then
    insert into public.familia_marcacao (voucher_id, pessoa_id, grupo_id, procedimento, profissional, unidade, data, hora, status)
    values (v_id, (p ->> 'pessoa_id')::uuid, nullif(p ->> 'grupo_id', '')::uuid, left(p ->> 'procedimento', 120), left(p ->> 'profissional', 120), left(p ->> 'unidade', 120), nullif(p ->> 'data', '')::date, left(p ->> 'hora', 8), v_status);
    insert into public.familia_evento (voucher_id, tipo) values (v_id, 'agendado');
    if v_status <> 'agendado' then insert into public.familia_evento (voucher_id, tipo) values (v_id, v_status); end if;
    v_novo := true;
  elsif v_antigo is distinct from v_status and not (v_antigo = 'laudo_pronto') then
    update public.familia_marcacao set status = v_status, atualizado_em = now(), laudo_pronto_em = case when v_status = 'laudo_pronto' then now() else laudo_pronto_em end where voucher_id = v_id;
    insert into public.familia_evento (voucher_id, tipo) values (v_id, v_status);
  end if;
  return jsonb_build_object('ok', true, 'novo', v_novo);
end $$;

-- Linha do tempo de tudo que o aparelho acompanha (só pessoas ligadas a ele), dos próximos para os antigos; devolve também há quanto tempo foi a última mudança.
create or replace function public.familia_acompanhar(p_aparelho uuid) returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('voucher', m.voucher_id, 'pessoa', p.id, 'nome', p.primeiro_nome, 'grupo', m.grupo_id, 'procedimento', m.procedimento, 'profissional', m.profissional,
      'unidade', m.unidade, 'data', m.data, 'hora', m.hora, 'status', m.status, 'laudo_pronto_em', m.laudo_pronto_em, 'atualizado_em', m.atualizado_em,
      'eventos', (select coalesce(jsonb_agg(jsonb_build_object('tipo', e.tipo, 'em', e.criado_em) order by e.id), '[]'::jsonb) from public.familia_evento e where e.voucher_id = m.voucher_id))
      order by (m.status in ('cancelado', 'remarcado')), m.data desc, m.hora desc), '[]'::jsonb)
    from public.familia_marcacao m join public.familia_pessoa p on p.id = m.pessoa_id
   where m.pessoa_id in (select v.pessoa_id from public.familia_vinculo v where v.aparelho_id = p_aparelho) $$;

-- Mediana de dias entre "atendido" e "laudo_pronto" por procedimento (a previsão que aprende). Só conta quem já passou pelos dois passos.
create or replace function public.familia_previsao_laudo(p_procedimento text) returns jsonb language sql stable security definer set search_path to '' as $$
  with t as (select extract(epoch from (l.criado_em - a.criado_em)) / 86400.0 as dias
               from public.familia_marcacao m join public.familia_evento a on a.voucher_id = m.voucher_id and a.tipo = 'atendido'
               join public.familia_evento l on l.voucher_id = m.voucher_id and l.tipo = 'laudo_pronto' where m.procedimento = p_procedimento and l.criado_em >= a.criado_em)
  select case when count(*) < 5 then jsonb_build_object('amostra', count(*)) else jsonb_build_object('amostra', count(*), 'mediana_dias', round((percentile_cont(0.5) within group (order by dias))::numeric, 1), 'p80_dias', round((percentile_cont(0.8) within group (order by dias))::numeric, 1)) end from t $$;

-- ============================================================================================================================ PARTE 5: cache, fila lenta e popularidade
create or replace function public.agenda_fila_pedir(p_chave text, p_params jsonb, p_prioridade integer default 5) returns bigint language plpgsql security definer set search_path to '' as $$
declare v bigint;
begin
  insert into public.agenda_fila (chave, params, prioridade) values (p_chave, p_params, least(9, greatest(1, p_prioridade)))
  on conflict (chave) do update set prioridade = least(public.agenda_fila.prioridade, excluded.prioridade),
      estado = case when public.agenda_fila.estado in ('feito', 'erro') then 'espera' else public.agenda_fila.estado end,
      proximo_em = case when public.agenda_fila.estado in ('feito', 'erro') then now() else public.agenda_fila.proximo_em end
  returning id into v;
  return v;
end $$;

-- Pega no máximo p_max tarefas por vez (a rotina chama com 3; menos se o Klingo reclamou). Quem está esperando (prioridade menor) vai primeiro.
create or replace function public.agenda_fila_pegar(p_max integer default 3) returns setof public.agenda_fila language plpgsql security definer set search_path to '' as $$
begin
  return query
  with pega as (select id from public.agenda_fila where (estado = 'espera' or (estado = 'rodando' and proximo_em < now() - interval '5 minutes')) and proximo_em <= now()
                 order by prioridade, proximo_em, id limit greatest(0, least(p_max, 3)) for update skip locked)
  update public.agenda_fila f set estado = 'rodando', tentativas = f.tentativas + 1, proximo_em = now() from pega where f.id = pega.id returning f.*;
end $$;

-- Terminou: p_ok = true marca feito; falhou: tenta de novo com espera crescente (1, 2, 4... até 60 min) e desiste na 6ª.
create or replace function public.agenda_fila_fim(p_id bigint, p_ok boolean, p_erro text default null, p_refazer_em interval default null) returns void language plpgsql security definer set search_path to '' as $$
declare f public.agenda_fila;
begin
  select * into f from public.agenda_fila where id = p_id for update;
  if not found then return; end if;
  if p_ok then update public.agenda_fila set estado = case when p_refazer_em is null then 'feito' else 'espera' end, concluido_em = now(), ultimo_erro = null, tentativas = 0, proximo_em = now() + coalesce(p_refazer_em, interval '0') where id = p_id;
  elsif f.tentativas >= 6 then update public.agenda_fila set estado = 'erro', ultimo_erro = left(p_erro, 120), concluido_em = now() where id = p_id;
  else update public.agenda_fila set estado = 'espera', ultimo_erro = left(p_erro, 120), proximo_em = now() + make_interval(mins => least(60, (2 ^ (f.tentativas - 1))::int)) where id = p_id; end if;
end $$;

create or replace function public.agenda_cache_ler(p_chave text) returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('dados', dados, 'buscado_em', buscado_em, 'vencido', valido_ate < now()) from public.agenda_cache where chave = p_chave $$;
create or replace function public.agenda_cache_gravar(p_chave text, p_dados jsonb, p_valido_seg integer) returns void language sql security definer set search_path to '' as $$
  insert into public.agenda_cache (chave, dados, buscado_em, valido_ate) values (p_chave, p_dados, now(), now() + make_interval(secs => greatest(10, p_valido_seg)))
  on conflict (chave) do update set dados = excluded.dados, buscado_em = now(), valido_ate = excluded.valido_ate $$;

-- "O que os outros mais marcam": horários marcados por médico nos últimos N dias (agenda_ocupacao já vem dos relatórios #7 e #47, sem dado de paciente).
create or replace function public.agenda_popularidade(p_dias integer default 90) returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('profissional', profissional, 'total', total) order by total desc), '[]'::jsonb)
    from (select profissional, sum(qtd)::int as total from public.agenda_ocupacao
           where fonte = 'marcada' and inicio >= (now() at time zone 'America/Bahia') - make_interval(days => least(365, greatest(7, p_dias))) group by profissional) t $$;

revoke all on function public.familia_cfg(text, integer), public.familia_aparelho_criar(text, text), public.familia_aparelho_ler(text), public.familia_vincular(uuid, uuid, text, text, integer, timestamptz),
  public.familia_aparelho_desligar(uuid), public.familia_convite_criar(uuid, uuid[], text), public.familia_convite_usar(text, uuid), public.familia_pedir_por_dados(uuid, uuid, text),
  public.familia_avisos(uuid), public.familia_aviso_responder(uuid, bigint, boolean), public.familia_marcacao_gravar(jsonb), public.familia_acompanhar(uuid), public.familia_previsao_laudo(text),
  public.agenda_fila_pedir(text, jsonb, integer), public.agenda_fila_pegar(integer), public.agenda_fila_fim(bigint, boolean, text, interval), public.agenda_cache_ler(text),
  public.agenda_cache_gravar(text, jsonb, integer), public.agenda_popularidade(integer) from public, anon, authenticated;
grant execute on function public.familia_cfg(text, integer), public.familia_aparelho_criar(text, text), public.familia_aparelho_ler(text), public.familia_vincular(uuid, uuid, text, text, integer, timestamptz),
  public.familia_aparelho_desligar(uuid), public.familia_convite_criar(uuid, uuid[], text), public.familia_convite_usar(text, uuid), public.familia_pedir_por_dados(uuid, uuid, text),
  public.familia_avisos(uuid), public.familia_aviso_responder(uuid, bigint, boolean), public.familia_marcacao_gravar(jsonb), public.familia_acompanhar(uuid), public.familia_previsao_laudo(text),
  public.agenda_fila_pedir(text, jsonb, integer), public.agenda_fila_pegar(integer), public.agenda_fila_fim(bigint, boolean, text, interval), public.agenda_cache_ler(text),
  public.agenda_cache_gravar(text, jsonb, integer), public.agenda_popularidade(integer) to service_role;

-- ============================================================================================================================ PARTE 6: pessoa (leitura e gravação só pela Edge Function)
-- Cria ou atualiza a pessoa pela chave. Quando já existe, só renova plano e id do Klingo (os dados cifrados antigos continuam; quem muda o contato é a própria pessoa no Klingo).
create or replace function public.familia_pessoa_guardar(p jsonb) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_id uuid; v_novo boolean := false;
begin
  select id into v_id from public.familia_pessoa where chave = p ->> 'chave';
  if not found then
    insert into public.familia_pessoa (chave, par_hash, primeiro_nome, dados_cifrados, cpf_de, klingo_id, plano_id, plano_nome)
    values (p ->> 'chave', p ->> 'par_hash', left(p ->> 'primeiro_nome', 40), p ->> 'dados_cifrados', coalesce(nullif(p ->> 'cpf_de', ''), 'proprio'), nullif(p ->> 'klingo_id', ''), nullif(p ->> 'plano_id', '')::integer, left(p ->> 'plano_nome', 80))
    returning id into v_id; v_novo := true;
  else
    update public.familia_pessoa set klingo_id = coalesce(nullif(p ->> 'klingo_id', ''), klingo_id), plano_id = coalesce(nullif(p ->> 'plano_id', '')::integer, plano_id),
           plano_nome = coalesce(left(p ->> 'plano_nome', 80), plano_nome), atualizado_em = now() where id = v_id;
  end if;
  return jsonb_build_object('id', v_id, 'novo', v_novo);
end $$;

-- Lê a pessoa SÓ se o aparelho tem vínculo com ela (devolve o texto cifrado: quem decifra é a Edge Function).
create or replace function public.familia_pessoa_ler(p_aparelho uuid, p_pessoa uuid) returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('id', p.id, 'primeiro_nome', p.primeiro_nome, 'dados_cifrados', p.dados_cifrados, 'cpf_de', p.cpf_de, 'klingo_id', p.klingo_id, 'plano_id', p.plano_id, 'plano', p.plano_nome,
         'papel', v.papel, 'nivel', case when v.nivel = 2 and v.liberado_em <= now() then 2 else 1 end)
    from public.familia_pessoa p join public.familia_vinculo v on v.pessoa_id = p.id join public.familia_aparelho a on a.id = v.aparelho_id
   where p.id = p_pessoa and v.aparelho_id = p_aparelho and a.desligado_em is null $$;
-- Leitura da rotina lenta (sem aparelho): só a Edge Function com a chave de serviço chama.
create or replace function public.familia_pessoa_ler_servico(p_pessoa uuid) returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('id', p.id, 'primeiro_nome', p.primeiro_nome, 'dados_cifrados', p.dados_cifrados, 'klingo_id', p.klingo_id, 'plano_id', p.plano_id) from public.familia_pessoa p where p.id = p_pessoa $$;
create or replace function public.familia_pessoa_por_par(p_par_hash text) returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'primeiro_nome', primeiro_nome, 'dados_cifrados', dados_cifrados, 'klingo_id', klingo_id) order by criado_em), '[]'::jsonb) from public.familia_pessoa where par_hash = p_par_hash $$;
create or replace function public.familia_pessoas_novas_hoje() returns integer language sql stable security definer set search_path to '' as $$
  select count(*)::integer from public.familia_pessoa where cpf_de = 'responsavel' and criado_em >= now() - interval '24 hours' $$;
-- O que a(s) pessoa(s) já marcaram (sem cancelar): serve para colocar primeiro o médico que a família já conhece.
create or replace function public.familia_historico(p_pessoas uuid[]) returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('profissional', profissional, 'total', total) order by total desc), '[]'::jsonb)
    from (select profissional, count(*)::int as total from public.familia_marcacao where pessoa_id = any (p_pessoas) and profissional is not null and status not in ('cancelado', 'remarcado') group by profissional) t $$;
-- Quem precisa ser relido no Klingo agora: pessoas de aparelhos usados na última hora (o resto espera a próxima visita).
create or replace function public.familia_pessoas_ativas(p_minutos integer default 60) returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(distinct v.pessoa_id), '[]'::jsonb) from public.familia_vinculo v join public.familia_aparelho a on a.id = v.aparelho_id
   where a.desligado_em is null and a.ultimo_uso >= now() - make_interval(mins => least(1440, greatest(1, p_minutos))) $$;
-- Marcações de uma pessoa que ainda valem acompanhar (futuras ou sem laudo), para a rotina conferir.
create or replace function public.familia_marcacoes_abertas(p_pessoa uuid) returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('voucher', voucher_id, 'status', status, 'data', data)), '[]'::jsonb) from public.familia_marcacao
   where pessoa_id = p_pessoa and status not in ('cancelado', 'remarcado', 'laudo_pronto', 'faltou') $$;

revoke all on function public.familia_pessoa_guardar(jsonb), public.familia_pessoa_ler(uuid, uuid), public.familia_pessoa_ler_servico(uuid), public.familia_pessoa_por_par(text), public.familia_pessoas_novas_hoje(),
  public.familia_historico(uuid[]), public.familia_pessoas_ativas(integer), public.familia_marcacoes_abertas(uuid) from public, anon, authenticated;
grant execute on function public.familia_pessoa_guardar(jsonb), public.familia_pessoa_ler(uuid, uuid), public.familia_pessoa_ler_servico(uuid), public.familia_pessoa_por_par(text), public.familia_pessoas_novas_hoje(),
  public.familia_historico(uuid[]), public.familia_pessoas_ativas(integer), public.familia_marcacoes_abertas(uuid) to service_role;

-- ============================================================================================================================ PARTE 7: registro de quem abriu laudo (sem conteúdo) e freio
create table if not exists public.familia_acesso (
  id bigint generated always as identity primary key,
  voucher_id text not null, aparelho_id uuid not null references public.familia_aparelho (id) on delete cascade, pessoa_id uuid not null references public.familia_pessoa (id) on delete cascade,
  em timestamptz not null default now()
);
create index if not exists familia_acesso_aparelho_idx on public.familia_acesso (aparelho_id, em desc);
alter table public.familia_acesso enable row level security;
revoke all on public.familia_acesso from anon, authenticated;
-- Registra a abertura de um laudo. Mais de 5 por minuto no mesmo celular: recusa (freio contra quem tenta abrir tudo de uma vez).
create or replace function public.familia_acesso_registrar(p_aparelho uuid, p_pessoa uuid, p_voucher text) returns jsonb language plpgsql security definer set search_path to '' as $$
begin
  if (select count(*) from public.familia_acesso where aparelho_id = p_aparelho and em > now() - interval '1 minute') >= 5 then return jsonb_build_object('ok', false, 'motivo', 'devagar'); end if;
  insert into public.familia_acesso (voucher_id, aparelho_id, pessoa_id) values (p_voucher, p_aparelho, p_pessoa);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.familia_acesso_registrar(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.familia_acesso_registrar(uuid, uuid, text) to service_role;

-- ============================================================================================================================ COMO VOLTAR ATRÁS
-- drop function public.familia_cfg(text, integer), public.familia_aparelho_criar(text, text), public.familia_aparelho_ler(text), public.familia_vincular(uuid, uuid, text, text, integer, timestamptz),
--   public.familia_aparelho_desligar(uuid), public.familia_convite_criar(uuid, uuid[], text), public.familia_convite_usar(text, uuid), public.familia_pedir_por_dados(uuid, uuid, text),
--   public.familia_avisos(uuid), public.familia_aviso_responder(uuid, bigint, boolean), public.familia_marcacao_gravar(jsonb), public.familia_acompanhar(uuid), public.familia_previsao_laudo(text),
--   public.agenda_fila_pedir(text, jsonb, integer), public.agenda_fila_pegar(integer), public.agenda_fila_fim(bigint, boolean, text, interval), public.agenda_cache_ler(text),
--   public.agenda_cache_gravar(text, jsonb, integer), public.agenda_popularidade(integer), public.familia_pessoa_guardar(jsonb), public.familia_pessoa_ler(uuid, uuid), public.familia_pessoa_ler_servico(uuid),
--   public.familia_pessoa_por_par(text), public.familia_pessoas_novas_hoje(), public.familia_historico(uuid[]), public.familia_pessoas_ativas(integer), public.familia_marcacoes_abertas(uuid), public.familia_acesso_registrar(uuid, uuid, text);
-- drop table public.familia_acesso, public.familia_evento, public.familia_marcacao, public.familia_aviso, public.familia_convite, public.familia_vinculo, public.familia_aparelho, public.familia_pessoa, public.agenda_fila, public.agenda_cache;
-- delete from public.config where chave in ('familia_max_aparelhos', 'familia_espera_horas', 'familia_dorme_meses');
