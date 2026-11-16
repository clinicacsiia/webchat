-- FLUXOGRAMA: entrada (a Edge Function app-laudos, SÓ com a chave do servidor; o paciente nunca chama estas funções) -> validação (aparelho com PIN dos últimos 30 minutos; cada pessoa só vale
--   se a clínica confirmou CPF + nascimento + nome no Klingo e se o CPF/nascimento guardados ainda são os mesmos da conferência) -> lógica (guarda só a LISTA de marcações atendidas e o estado de cada laudo:
--   aguardando / disponível / em revisão; o PDF NUNCA é guardado: a Edge Function busca no Klingo a cada download) -> saída (lista enxuta, sem CPF, sem PDF, sem texto de laudo)
-- Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (laudos no aplicativo: baixar quantas vezes quiser, sempre conferindo o Klingo antes).
--
-- O QUE FAZ: tabelas app_laudo_pessoa e app_laudo + 8 funções (todas só do service_role) + chave config.app_laudos ('sim' = ligado; 'nao' = desliga na hora, a lista some e o download é recusado).
-- NÃO guarda laudo, PDF, CPF em claro nem texto médico: só id da marcação, nome do exame, data, unidade e o estado. O CPF e o nascimento continuam onde já estavam (app_paciente / app_filho).
-- A "prova" de que a marcação é da pessoa é o Klingo: os ids vêm de GET /vouchers com a sessão do próprio paciente (login só depois de CPF + nascimento + nome conferidos).
--
-- COMO VOLTAR ATRÁS (cada comando pode pedir confirmação no conector do Supabase; o aplicativo apenas para de mostrar laudos, nada mais depende destas funções):
--   update public.config set valor = 'nao' where chave = 'app_laudos';     -- desliga na hora (recomendado)
--   drop function if exists public.app_laudos_contexto(text, boolean), public.app_laudos_pessoas(uuid), public.app_laudos_pessoa_gravar(uuid, text, text, text),
--     public.app_laudos_itens_gravar(uuid, text, jsonb), public.app_laudos_a_checar(uuid, integer), public.app_laudos_estado(uuid, text, boolean),
--     public.app_laudos_lista(uuid), public.app_laudos_pode(text, text);
--   drop table if exists public.app_laudo; drop table if exists public.app_laudo_pessoa; delete from public.config where chave = 'app_laudos';
--   (depois apague a Edge Function app-laudos no painel e refaça o retrato.)
-- COMO APLICAR (limite de 60 s do conector): em 3 partes, na ordem das seções 1 (tabelas + chave), 2 (leitura) e 3 (gravação). Pode ser aplicado mais de uma vez. Este arquivo não tem DELETE nem DROP.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 1. Tabelas (RLS ligada e nenhuma regra: só as funções abaixo leem e gravam) e a chave de liga/desliga
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.app_laudo_pessoa (
  paciente_id uuid not null references public.app_paciente(id) on delete cascade,
  pessoa text not null,                         -- 'eu' ou o id do filho (app_filho.id)
  ident_hash text,                              -- klingo_hash(cpf|nascimento) no momento da conferência; se o CPF ou o nascimento mudarem, a conferência deixa de valer
  klingo_id text check (klingo_id is null or klingo_id ~ '^P[0-9]+$'),
  situacao text not null default 'pendente' check (situacao in ('pendente', 'confere', 'divergente', 'nao_encontrado', 'sem_cadastro', 'travado')),
  verificado_em timestamptz,
  voucher_em timestamptz,                       -- última leitura das marcações no Klingo
  criado_em timestamptz not null default now(),
  primary key (paciente_id, pessoa)
);
alter table public.app_laudo_pessoa enable row level security;
revoke all on public.app_laudo_pessoa from public, anon, authenticated;
comment on table public.app_laudo_pessoa is 'Conferência da identidade de cada pessoa do cadastro (titular e filhos) no Klingo, para os laudos do aplicativo. Sem CPF em claro: só o hash.';

create table if not exists public.app_laudo (
  paciente_id uuid not null references public.app_paciente(id) on delete cascade,
  marcacao_id text not null check (marcacao_id ~ '^[0-9]{1,12}$'),   -- id da marcação no Klingo (a chave de GET /resultado/{id})
  pessoa text not null,
  ident_hash text not null,                     -- a identidade conferida com que esta linha foi gravada
  procedimento text,
  data_exame date,
  unidade text,
  estado text not null default 'aguardando' check (estado in ('aguardando', 'disponivel', 'em_revisao')),
  checado_em timestamptz,
  disponivel_em timestamptz,
  retirado_em timestamptz,                      -- última vez em que o Klingo deixou de dizer "pronto" para um laudo que já estava disponível
  atualizado_em timestamptz not null default now(),
  primary key (paciente_id, marcacao_id)
);
create index if not exists app_laudo_pessoa_idx on public.app_laudo (paciente_id, pessoa);
alter table public.app_laudo enable row level security;
revoke all on public.app_laudo from public, anon, authenticated;
comment on table public.app_laudo is 'Marcações atendidas de cada pessoa (lista do Klingo) e o estado do laudo. NÃO guarda o laudo nem o PDF: o arquivo é buscado no Klingo a cada download.';

insert into public.config (chave, valor) values ('app_laudos', 'sim') on conflict (chave) do nothing;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 2. Leitura
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- As pessoas de um cadastro (titular + filhos não removidos) com o hash atual de CPF + nascimento.
create or replace function public.app_laudos_pessoas(p_pac uuid)
returns table (pessoa text, nome text, nascimento date, cpf text, eu boolean, ih text, ord integer, criado timestamptz)
language sql stable security definer set search_path to ''
as $f$
  select 'eu'::text, a.nome, a.nascimento, a.cpf, true, case when a.cpf is not null then public.klingo_hash(a.cpf || '|' || a.nascimento::text) end, 0, a.criado_em
    from public.app_paciente a where a.id = p_pac
  union all
  select f.id::text, f.nome, f.nascimento, f.cpf, false, case when f.cpf is not null then public.klingo_hash(f.cpf || '|' || f.nascimento::text) end, 1, f.criado_em
    from public.app_filho f where f.responsavel_id = p_pac and f.removido_em is null
$f$;
revoke all on function public.app_laudos_pessoas(uuid) from public, anon, authenticated;
grant execute on function public.app_laudos_pessoas(uuid) to service_role;

-- Aparelho com PIN -> as pessoas do cadastro (com CPF, só para a Edge Function) e o que já se sabe da conferência de cada uma.
create or replace function public.app_laudos_contexto(p_token text, p_renova boolean default false) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare s record; v_trava timestamptz;
begin
  if coalesce((select valor from public.config where chave = 'app_laudos'), 'sim') <> 'sim' then
    return jsonb_build_object('ok', false, 'erro', 'desligado', 'mensagem', 'Os laudos pelo aplicativo ainda não estão disponíveis. Fale com a clínica.');
  end if;
  select * into s from public.app_aparelho_validar(p_token, p_renova);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if not p_renova then   -- abrir ou recarregar a tela não estende o PIN (igual a app_pedidos)
    select desbloqueada_ate into v_trava from public.app_aparelho where id = s.o_aparelho;
    if v_trava is null or v_trava < now() then return public.app_erro_json('bloqueado'); end if;
  end if;
  return jsonb_build_object('ok', true, 'paciente_id', s.o_pac, 'pessoas', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'chave', p.pessoa, 'nome', p.nome, 'nascimento', p.nascimento, 'cpf', p.cpf, 'eu', p.eu,
             'klingo_id', case when lp.ident_hash is not distinct from p.ih then lp.klingo_id end,
             'voucher_em', case when lp.ident_hash is not distinct from p.ih then lp.voucher_em end,
             'situacao', case when lp.ident_hash is not distinct from p.ih then lp.situacao else 'pendente' end,
             'verificado_em', case when lp.ident_hash is not distinct from p.ih then lp.verificado_em end) order by p.ord, p.criado, p.pessoa), '[]'::jsonb)
      from public.app_laudos_pessoas(s.o_pac) p
      left join public.app_laudo_pessoa lp on lp.paciente_id = s.o_pac and lp.pessoa = p.pessoa));
end $f$;
revoke all on function public.app_laudos_contexto(text, boolean) from public, anon, authenticated;
grant execute on function public.app_laudos_contexto(text, boolean) to service_role;

-- Marcações cujo estado vale a pena conferir no Klingo agora (no máximo p_max, as mais novas e as nunca conferidas primeiro).
create or replace function public.app_laudos_a_checar(p_pac uuid, p_max integer default 6) returns jsonb
language sql stable security definer set search_path to ''
as $f$
  select coalesce(jsonb_agg(t.marcacao_id), '[]'::jsonb)
    from (select l.marcacao_id
            from public.app_laudo l
            join public.app_laudos_pessoas(p_pac) p on p.pessoa = l.pessoa and p.ih = l.ident_hash
            join public.app_laudo_pessoa lp on lp.paciente_id = l.paciente_id and lp.pessoa = l.pessoa and lp.ident_hash = l.ident_hash and lp.situacao = 'confere'
           where l.paciente_id = p_pac
             and (l.data_exame is null or l.data_exame >= current_date - 400)
             and (l.checado_em is null or l.checado_em < now() - interval '15 minutes')
             and (l.estado <> 'aguardando' or l.data_exame is null or l.data_exame >= current_date - 45 or l.checado_em is null or l.checado_em < now() - interval '1 day')
           order by (l.checado_em is null) desc, l.data_exame desc nulls last, l.marcacao_id desc
           limit greatest(least(coalesce(p_max, 6), 10), 1)) t
$f$;
revoke all on function public.app_laudos_a_checar(uuid, integer) from public, anon, authenticated;
grant execute on function public.app_laudos_a_checar(uuid, integer) to service_role;

-- O que a tela mostra: pessoas (com a situação da conferência) e os laudos. Sem CPF, sem PDF.
create or replace function public.app_laudos_lista(p_pac uuid) returns jsonb
language sql stable security definer set search_path to ''
as $f$
  select jsonb_build_object('ok', true,
    'pessoas', (select coalesce(jsonb_agg(jsonb_build_object('nome', p.nome, 'eu', p.eu,
                  'situacao', case when p.cpf is null then 'sem_cpf' when lp.ident_hash is not distinct from p.ih then coalesce(lp.situacao, 'pendente') else 'pendente' end) order by p.ord, p.criado, p.pessoa), '[]'::jsonb)
                  from public.app_laudos_pessoas(p_pac) p left join public.app_laudo_pessoa lp on lp.paciente_id = p_pac and lp.pessoa = p.pessoa),
    'itens', (select coalesce(jsonb_agg(jsonb_build_object('id', l.marcacao_id, 'pessoa', p.nome, 'eu', p.eu, 'nome', l.procedimento, 'data', l.data_exame, 'unidade', l.unidade,
                  'estado', l.estado, 'checado_em', l.checado_em) order by l.data_exame desc nulls last, l.marcacao_id desc), '[]'::jsonb)
                from public.app_laudo l
                join public.app_laudos_pessoas(p_pac) p on p.pessoa = l.pessoa and p.ih = l.ident_hash
                join public.app_laudo_pessoa lp on lp.paciente_id = l.paciente_id and lp.pessoa = l.pessoa and lp.ident_hash = l.ident_hash and lp.situacao = 'confere'
               where l.paciente_id = p_pac
                 and (l.estado <> 'aguardando' or (l.data_exame >= current_date - 30 and coalesce(l.procedimento, '') !~* '^\s*(consulta|retorno)')))   -- sem laudo ainda: só o recente e só o que não é consulta
  )
$f$;
revoke all on function public.app_laudos_lista(uuid) from public, anon, authenticated;
grant execute on function public.app_laudos_lista(uuid) to service_role;

-- Antes de baixar: o aparelho está com o PIN em dia e a marcação é de uma pessoa deste cadastro, com a identidade ainda conferida.
create or replace function public.app_laudos_pode(p_token text, p_marcacao text) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare s record;
begin
  if coalesce((select valor from public.config where chave = 'app_laudos'), 'sim') <> 'sim' then
    return jsonb_build_object('ok', false, 'erro', 'desligado', 'mensagem', 'Os laudos pelo aplicativo ainda não estão disponíveis. Fale com a clínica.');
  end if;
  select * into s from public.app_aparelho_validar(p_token);   -- exige o PIN e renova os 30 minutos: baixar é uso de verdade
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if (select count(*) from public.app_evento e where e.paciente_id = s.o_pac and e.tipo = 'laudo_baixado' and e.criado_em > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('ok', false, 'erro', 'muitos', 'mensagem', 'Muitos downloads seguidos. Tente de novo daqui a pouco.');
  end if;
  if not exists (select 1 from public.app_laudo l
                   join public.app_laudos_pessoas(s.o_pac) p on p.pessoa = l.pessoa and p.ih = l.ident_hash
                   join public.app_laudo_pessoa lp on lp.paciente_id = l.paciente_id and lp.pessoa = l.pessoa and lp.ident_hash = l.ident_hash and lp.situacao = 'confere'
                  where l.paciente_id = s.o_pac and l.marcacao_id = p_marcacao) then
    return jsonb_build_object('ok', false, 'erro', 'sem_acesso', 'mensagem', 'Laudo não encontrado.');
  end if;
  return jsonb_build_object('ok', true, 'paciente_id', s.o_pac);
end $f$;
revoke all on function public.app_laudos_pode(text, text) from public, anon, authenticated;
grant execute on function public.app_laudos_pode(text, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3. Gravação
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Resultado da conferência no Klingo. 'travado' (muitas tentativas erradas com o CPF) guarda o que já havia; as outras recusas apagam o id do Klingo.
create or replace function public.app_laudos_pessoa_gravar(p_pac uuid, p_pessoa text, p_situacao text, p_klingo_id text) returns void
language plpgsql security definer set search_path to ''
as $f$
declare p record;
begin
  if p_situacao not in ('confere', 'divergente', 'nao_encontrado', 'sem_cadastro', 'travado') then return; end if;
  select * into p from public.app_laudos_pessoas(p_pac) x where x.pessoa = p_pessoa;
  if not found or p.ih is null then return; end if;   -- pessoa removida ou sem CPF
  insert into public.app_laudo_pessoa as lp (paciente_id, pessoa, ident_hash, klingo_id, situacao, verificado_em)
  values (p_pac, p_pessoa, p.ih, case when p_situacao = 'confere' then p_klingo_id end, p_situacao, now())
  on conflict (paciente_id, pessoa) do update set
    klingo_id = case when excluded.situacao = 'confere' then excluded.klingo_id
                     when excluded.situacao = 'travado' and lp.ident_hash is not distinct from excluded.ident_hash then lp.klingo_id end,
    voucher_em = case when lp.ident_hash is not distinct from excluded.ident_hash and excluded.situacao in ('confere', 'travado') then lp.voucher_em end,
    ident_hash = excluded.ident_hash, situacao = excluded.situacao, verificado_em = now();
end $f$;
revoke all on function public.app_laudos_pessoa_gravar(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.app_laudos_pessoa_gravar(uuid, text, text, text) to service_role;

-- A lista de marcações atendidas lida do Klingo (com a sessão da própria pessoa). Só grava se a pessoa está conferida e a identidade não mudou.
create or replace function public.app_laudos_itens_gravar(p_pac uuid, p_pessoa text, p_itens jsonb) returns boolean
language plpgsql security definer set search_path to ''
as $f$
declare p record; e jsonb; v_id text;
begin
  select x.* into p from public.app_laudos_pessoas(p_pac) x
    join public.app_laudo_pessoa lp on lp.paciente_id = p_pac and lp.pessoa = x.pessoa and lp.ident_hash = x.ih and lp.situacao = 'confere'
   where x.pessoa = p_pessoa;
  if not found or jsonb_typeof(p_itens) <> 'array' then return false; end if;
  for e in select * from jsonb_array_elements(p_itens) limit 200 loop
    v_id := e ->> 'id';
    if v_id is null or v_id !~ '^[0-9]{1,12}$' then continue; end if;
    insert into public.app_laudo as l (paciente_id, marcacao_id, pessoa, ident_hash, procedimento, data_exame, unidade)
    values (p_pac, v_id, p_pessoa, p.ih, left(e ->> 'procedimento', 200), public.fluxo_ler_data(e ->> 'data'), left(e ->> 'unidade', 120))
    on conflict (paciente_id, marcacao_id) do update set
      estado = case when l.ident_hash is distinct from excluded.ident_hash then 'aguardando' else l.estado end,
      checado_em = case when l.ident_hash is distinct from excluded.ident_hash then null else l.checado_em end,
      disponivel_em = case when l.ident_hash is distinct from excluded.ident_hash then null else l.disponivel_em end,
      retirado_em = case when l.ident_hash is distinct from excluded.ident_hash then null else l.retirado_em end,
      pessoa = excluded.pessoa, ident_hash = excluded.ident_hash, procedimento = excluded.procedimento, data_exame = excluded.data_exame, unidade = excluded.unidade, atualizado_em = now();
  end loop;
  update public.app_laudo_pessoa set voucher_em = now() where paciente_id = p_pac and pessoa = p_pessoa;
  return true;
end $f$;
revoke all on function public.app_laudos_itens_gravar(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.app_laudos_itens_gravar(uuid, text, jsonb) to service_role;

-- O que o Klingo disse agora: pronto (com arquivo) ou não. Disponível que deixa de estar pronto vira "em revisão" (a equipe retirou para ajuste).
create or replace function public.app_laudos_estado(p_pac uuid, p_marcacao text, p_pronto boolean) returns void
language sql security definer set search_path to ''
as $f$
  update public.app_laudo set
    estado = case when p_pronto then 'disponivel' when estado in ('disponivel', 'em_revisao') then 'em_revisao' else 'aguardando' end,
    disponivel_em = case when p_pronto then coalesce(disponivel_em, now()) else disponivel_em end,
    retirado_em = case when p_pronto then null when estado = 'disponivel' then now() else retirado_em end,
    checado_em = now(), atualizado_em = now()
   where paciente_id = p_pac and marcacao_id = p_marcacao
$f$;
revoke all on function public.app_laudos_estado(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.app_laudos_estado(uuid, text, boolean) to service_role;
