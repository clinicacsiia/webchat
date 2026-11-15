-- FLUXOGRAMA: entrada (o Klingo é quem decide: a função klingo-sincronizar, ação "exames", pergunta à API de 5 em 5 minutos, para 25 exames por vez, se há horário livre nos próximos 45 dias e grava o resultado em klingo_proc_api)
--   -> validação (só entram na varredura exames que o chat tem E que a API do Klingo lista em klingo_exame_api; resposta de erro nunca vira "sem horário")
--   -> lógica (klingo_exame_oferecido decide se o exame aparece: some se a API não o lista ou se a última checagem não achou horário; volta sozinho quando o Klingo passar a ter horário;
--      se a varredura parar por mais de N horas, o exame "sem horário" volta a aparecer em vez de sumir para sempre; interruptor config.klingo_exames_so_api, desligado até a primeira varredura completa)
--   -> saída (chat_exames, chat_exames_buscar e a leitura de pedido já passam por klingo_liberado -> klingo_automatizavel: o filtro vale em todas; klingo_exames_cobertura mostra a cobertura para ligar com segurança)
-- Versão 1.1 — 15/11/2026 / Mudança: parte 6 (conversa sem horário na API ganha a etiqueta "Sem horário no Klingo" na lista do painel).
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (o chat só mostra o exame que a API do Klingo oferece; caso da RM ENDOVAGINAL sem horário).
-- Aplicar em PARTES (cada bloco "-- PARTE n" é uma migração). Reversão no fim do arquivo.

-- PARTE 1 ------------------------------------------------------------------ coluna e interruptores
alter table public.klingo_proc_api add column if not exists primeiro_dia date;
comment on column public.klingo_proc_api.primeiro_dia is 'Primeiro dia com horário livre visto na última varredura que achou horário (só catálogo, nenhum dado de paciente).';
insert into public.config (chave, valor) values
  ('klingo_exames_so_api', 'nao'),      -- sim = o chat só mostra exame que a API do Klingo oferece com horário
  ('klingo_exames_vazio_min', '60'),    -- exame sem horário é perguntado de novo a cada 60 min (volta ao chat logo depois de abrir agenda no Klingo)
  ('klingo_exames_tem_min', '120'),     -- exame com horário é conferido de novo a cada 120 min
  ('klingo_exames_vencimento_h', '6')   -- se a última checagem de um exame "sem horário" tem mais de 6 h, a varredura parou: o exame volta a aparecer
on conflict (chave) do nothing;

-- PARTE 2 ------------------------------------------------------------------ gravar o resultado da varredura
create or replace function public.klingo_sondagem_registrar(p_proc integer, p_tem boolean, p_primeiro date default null) returns void
  language sql security definer set search_path to '' as $f$
  insert into public.klingo_proc_api (procedimento_id, com_horario_em, vazio_em, primeiro_dia)
  values (p_proc, case when p_tem then now() end, case when not p_tem then now() end, case when p_tem then p_primeiro end)
  on conflict (procedimento_id) do update set
    com_horario_em = case when p_tem then now() else public.klingo_proc_api.com_horario_em end,
    vazio_em = case when not p_tem then now() else public.klingo_proc_api.vazio_em end,
    primeiro_dia = case when p_tem then p_primeiro else null end
$f$;
create or replace function public.klingo_sondagem_gravar(p_proc integer, p_tem boolean) returns void
  language sql security definer set search_path to '' as $f$ select public.klingo_sondagem_registrar(p_proc, p_tem, null) $f$;
revoke all on function public.klingo_sondagem_registrar(integer, boolean, date) from public, anon, authenticated;
grant execute on function public.klingo_sondagem_registrar(integer, boolean, date) to service_role;

-- PARTE 3 ------------------------------------------------------------------ quem entra na varredura: todo exame do chat que a API lista; o que nunca foi visto vai primeiro, depois o mais antigo
create or replace function public.klingo_exames_sondar(p_n integer default 15) returns setof integer
  language sql stable security definer set search_path to '' as $f$
  with cfg as (select greatest(5, coalesce(nullif(public.klingo_cfg('klingo_exames_vazio_min', '60'), '')::int, 60)) as vazio,
                      greatest(5, coalesce(nullif(public.klingo_cfg('klingo_exames_tem_min', '120'), '')::int, 120)) as tem)
  select f.id
    from public.fluxo_exames f
    join public.klingo_exame_api k on k.id = f.id
    left join public.klingo_proc_api x on x.procedimento_id = f.id
    cross join cfg
   where x.procedimento_id is null
      or greatest(x.com_horario_em, x.vazio_em) is null
      or greatest(x.com_horario_em, x.vazio_em) < now() - make_interval(mins =>
           case when x.com_horario_em is null or (x.vazio_em is not null and x.vazio_em > x.com_horario_em) then cfg.vazio else cfg.tem end)
   order by (x.procedimento_id is null) desc, greatest(x.com_horario_em, x.vazio_em) nulls first, f.demanda desc, f.id
   limit greatest(1, least(coalesce(p_n, 15), 40))
$f$;

-- PARTE 4 ------------------------------------------------------------------ a regra de "aparece ou não"
create or replace function public.klingo_exame_oferecido(p_proc integer) returns boolean
  language plpgsql stable security definer set search_path to '' as $f$
declare p public.klingo_proc_api; v_tem boolean; v_ult timestamptz; v_h int;
begin
  if public.klingo_cfg('klingo_exames_so_api', 'nao') <> 'sim' then return true; end if;
  if not exists (select 1 from public.klingo_exame_api) then return true; end if;               -- cópia do catálogo da API vazia (falha de sincronização): não esconde tudo
  if not exists (select 1 from public.klingo_exame_api where id = p_proc) then return false; end if;   -- a API do Klingo não oferece este exame
  select * into p from public.klingo_proc_api where procedimento_id = p_proc;
  if not found then return false; end if;                                                         -- a API ainda não confirmou horário (a varredura pega os novos primeiro)
  v_tem := p.com_horario_em is not null and (p.vazio_em is null or p.com_horario_em >= p.vazio_em);
  if v_tem then return true; end if;
  v_ult := greatest(p.com_horario_em, p.vazio_em);
  v_h := greatest(1, coalesce(nullif(public.klingo_cfg('klingo_exames_vencimento_h', '6'), '')::int, 6));
  return v_ult < now() - make_interval(hours => v_h);                                             -- sem horário: some; se a varredura parou, volta (melhor mostrar do que perder o exame)
end $f$;
revoke all on function public.klingo_exame_oferecido(integer) from public, anon, authenticated;
grant execute on function public.klingo_exame_oferecido(integer) to service_role;

create or replace function public.klingo_automatizavel(p_proc integer, p_tipo text) returns boolean
  language sql stable security definer set search_path to '' as $f$
  select case when p_tipo = 'consulta' then exists (select 1 from public.klingo_especialidade e where e.liberada_api and p_proc = any (e.procedimentos))
              when p_tipo = 'exame' then p_proc is not null and public.klingo_exame_oferecido(p_proc)
              else false end
$f$;

-- PARTE 5 ------------------------------------------------------------------ cobertura (para ligar o interruptor com segurança) e varredura de 5 em 5 minutos
create or replace function public.klingo_exames_cobertura() returns jsonb
  language sql stable security definer set search_path to '' as $f$
  select jsonb_build_object(
    'exames_no_chat', (select count(*) from public.fluxo_exames),
    'na_api', (select count(*) from public.fluxo_exames f join public.klingo_exame_api k on k.id = f.id),
    'conferidos', (select count(*) from public.fluxo_exames f join public.klingo_exame_api k on k.id = f.id join public.klingo_proc_api x on x.procedimento_id = f.id),
    'com_horario', (select count(*) from public.fluxo_exames f join public.klingo_exame_api k on k.id = f.id join public.klingo_proc_api x on x.procedimento_id = f.id
                     where x.com_horario_em is not null and (x.vazio_em is null or x.com_horario_em >= x.vazio_em)),
    'sem_horario', (select count(*) from public.fluxo_exames f join public.klingo_exame_api k on k.id = f.id join public.klingo_proc_api x on x.procedimento_id = f.id
                     where x.vazio_em is not null and (x.com_horario_em is null or x.vazio_em > x.com_horario_em)),
    'faltam_conferir', (select count(*) from public.fluxo_exames f join public.klingo_exame_api k on k.id = f.id left join public.klingo_proc_api x on x.procedimento_id = f.id where x.procedimento_id is null),
    'fora_da_api', (select count(*) from public.fluxo_exames f where not exists (select 1 from public.klingo_exame_api k where k.id = f.id)),
    'mais_antiga_h', (select round(extract(epoch from now() - min(greatest(x.com_horario_em, x.vazio_em))) / 3600, 1)
                       from public.fluxo_exames f join public.klingo_exame_api k on k.id = f.id join public.klingo_proc_api x on x.procedimento_id = f.id))
$f$;
revoke all on function public.klingo_exames_cobertura() from public, anon, authenticated;
grant execute on function public.klingo_exames_cobertura() to service_role;

-- PARTE 6 ------------------------------------------------------------------ sem horário na API: a equipe é avisada sozinha (etiqueta na lista do painel)
-- Quando a API responde "sem horário" para a conversa, a lista do painel mostra "Sem horário no Klingo" (o campo alerta_agenda que já existe) para a equipe chamar a paciente.
-- A etiqueta só é posta se o campo estiver vazio (não atropela outro alerta) e só é tirada se for esta mesma (quando depois aparece horário).
create or replace function public.klingo_horarios_motivo(p_conversa uuid, p_motivo text, p_detalhe text default null::text) returns void
  language plpgsql security definer set search_path to '' as $f$
begin
  if p_motivo is null then
    delete from public.klingo_horarios_falha where conversa_id = p_conversa;
    update public.conversas set alerta_agenda = null where id = p_conversa and alerta_agenda = 'Sem horário no Klingo';
  else
    insert into public.klingo_horarios_falha (conversa_id, motivo, detalhe, em)
    values (p_conversa, left(btrim(p_motivo), 60), left(nullif(btrim(coalesce(p_detalhe, '')), ''), 200), now())
    on conflict (conversa_id) do update set motivo = excluded.motivo, detalhe = excluded.detalhe, em = excluded.em;
    if p_motivo = 'api_sem_horario' then
      update public.conversas set alerta_agenda = 'Sem horário no Klingo' where id = p_conversa and alerta_agenda is null and encerrada_em is null;
    end if;
  end if;
exception when foreign_key_violation then null;
end $f$;

-- A rotina do banco que dispara a varredura passa de 10 para 5 minutos (25 exames por vez: o catálogo inteiro em cerca de 2 horas).
-- select cron.alter_job(31, schedule := '*/5 * * * *');   -- rodar à parte, depois das partes 1 a 5

-- REVERSÃO ------------------------------------------------------------------
-- update public.config set valor = 'nao' where chave = 'klingo_exames_so_api';          -- volta a mostrar todos os exames na hora
-- select cron.alter_job(31, schedule := '*/10 * * * *');
-- (parte 6: voltar a função klingo_horarios_motivo para supabase/producao/funcoes/klingo_horarios_motivo.sql do commit anterior)
-- (para voltar também o código antigo: arquivos supabase/producao/funcoes/klingo_automatizavel.sql e klingo_exames_sondar.sql)
