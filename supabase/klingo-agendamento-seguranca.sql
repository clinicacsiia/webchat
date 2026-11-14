-- Fluxo: Entrada (IP, ação e CPF vindos da função klingo-agendamento) → Validação (chave de desligamento + limites por IP e por CPF)
--        → Processamento (conta eventos recentes, só com hash) → Persistência (klingo_agendamento_evento) → Saída ({ok, motivo, id}).
-- Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Trava NO SERVIDOR para a função pública klingo-agendamento (ela segue pública e com o mesmo contrato;
--   só passa a recusar ritmo abusivo, tentativas repetidas e escrita quando a gestão desligar). Não apaga nem altera nada existente. NÃO aplicada na produção.
-- Ordem de publicação: 1) este SQL  2) a função klingo-agendamento v1.1 (ela chama klingo_agendamento_passar; sem este SQL ela recusa tudo por segurança).
-- Reversão: publicar a função anterior (v2 da produção) e, se quiser, `drop table public.klingo_agendamento_evento` (só guarda hashes).
-- LGPD: nenhum CPF, nascimento, nome ou IP em claro; só hashes com sal do cofre (klingo_hash). Retenção: 30 dias.

create table if not exists public.klingo_agendamento_evento (
  id bigserial primary key,
  em timestamptz not null default now(),
  ip_hash text not null,
  cpf_hash text,
  acao text not null,
  escrita boolean not null default false,
  resultado text            -- ok | recusado | divergente | bloqueado_*
);
create index if not exists klingo_agendamento_evento_ip_em on public.klingo_agendamento_evento (ip_hash, em desc);
create index if not exists klingo_agendamento_evento_cpf_em on public.klingo_agendamento_evento (cpf_hash, em desc) where cpf_hash is not null;
alter table public.klingo_agendamento_evento enable row level security;   -- sem política: só a função (definer) e service_role enxergam
revoke all on public.klingo_agendamento_evento from public, anon, authenticated;

-- Chaves novas (valores que PRESERVAM o comportamento de hoje; o dono pode apertar depois)
insert into public.config (chave, valor) values
  ('agendamento_externo_modo', 'sim'),            -- sim | leitura (só consulta, nada escreve no Klingo) | nao (tudo recusado)
  ('agendamento_ip_por_minuto', '60'),
  ('agendamento_ip_escritas_hora', '30'),
  ('agendamento_ip_divergentes_hora', '15'),
  ('agendamento_cpf_escritas_hora', '8'),
  ('agendamento_cpf_divergentes_dia', '10')
on conflict (chave) do nothing;

create or replace function public.klingo_agendamento_passar(p_ip text, p_acao text, p_cpf text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $f$
declare
  v_ip text; v_cpf text; v_escrita boolean; v_modo text; v_mestre text; v_id bigint;
  v_lim_min int; v_lim_esc_ip int; v_lim_div_ip int; v_lim_esc_cpf int; v_lim_div_cpf int;
  v_n int;
  v_motivo text;
begin
  v_escrita := p_acao in ('atualizar_contato','reservar','soltar','marcar','remarcar','cancelar','trocar_procedimento','checkin','cancelar_checkin','cadastrar');
  select coalesce(valor, 'sim') into v_modo from public.config where chave = 'agendamento_externo_modo';
  select coalesce(valor, 'sim') into v_mestre from public.config where chave = 'klingo_auto';
  v_modo := coalesce(v_modo, 'sim');
  v_lim_min := coalesce((select nullif(valor, '')::int from public.config where chave = 'agendamento_ip_por_minuto'), 60);
  v_lim_esc_ip := coalesce((select nullif(valor, '')::int from public.config where chave = 'agendamento_ip_escritas_hora'), 30);
  v_lim_div_ip := coalesce((select nullif(valor, '')::int from public.config where chave = 'agendamento_ip_divergentes_hora'), 15);
  v_lim_esc_cpf := coalesce((select nullif(valor, '')::int from public.config where chave = 'agendamento_cpf_escritas_hora'), 8);
  v_lim_div_cpf := coalesce((select nullif(valor, '')::int from public.config where chave = 'agendamento_cpf_divergentes_dia'), 10);

  v_ip := public.klingo_hash('ip|' || coalesce(nullif(trim(p_ip), ''), 'desconhecido'));
  v_cpf := case when p_cpf is null or p_cpf = '' then null else public.klingo_hash(regexp_replace(p_cpf, '\D', '', 'g')) end;

  -- 1) chaves de desligamento (a gestão pode recuar sem publicar nada)
  if v_modo = 'nao' then v_motivo := 'desligado';
  elsif v_escrita and (v_modo = 'leitura' or v_mestre = 'nao') then v_motivo := 'escrita_desligada';
  end if;

  -- 2) ritmo por IP (qualquer ação)
  if v_motivo is null then
    select count(*) into v_n from public.klingo_agendamento_evento where ip_hash = v_ip and em > now() - interval '1 minute';
    if v_n >= v_lim_min then v_motivo := 'ip_ritmo'; end if;
  end if;
  -- 3) escritas por IP e por CPF; nascimentos errados por IP e por CPF
  if v_motivo is null and v_escrita then
    select count(*) into v_n from public.klingo_agendamento_evento where ip_hash = v_ip and escrita and em > now() - interval '1 hour' and coalesce(resultado, 'ok') not like 'bloqueado%';
    if v_n >= v_lim_esc_ip then v_motivo := 'ip_escritas'; end if;
    if v_motivo is null and v_cpf is not null then
      select count(*) into v_n from public.klingo_agendamento_evento where cpf_hash = v_cpf and escrita and em > now() - interval '1 hour' and coalesce(resultado, 'ok') not like 'bloqueado%';
      if v_n >= v_lim_esc_cpf then v_motivo := 'cpf_escritas'; end if;
    end if;
  end if;
  if v_motivo is null then
    select count(*) into v_n from public.klingo_agendamento_evento where ip_hash = v_ip and resultado = 'divergente' and em > now() - interval '1 hour';
    if v_n >= v_lim_div_ip then v_motivo := 'ip_divergentes'; end if;
  end if;
  if v_motivo is null and v_cpf is not null then
    select count(*) into v_n from public.klingo_agendamento_evento where cpf_hash = v_cpf and resultado = 'divergente' and em > now() - interval '1 day';
    if v_n >= v_lim_div_cpf then v_motivo := 'cpf_divergentes'; end if;
  end if;

  insert into public.klingo_agendamento_evento (ip_hash, cpf_hash, acao, escrita, resultado)
  values (v_ip, v_cpf, left(coalesce(p_acao, ''), 40), v_escrita, case when v_motivo is null then null else 'bloqueado_' || v_motivo end)
  returning id into v_id;

  -- limpeza leve (retenção de 30 dias), sem custo no caminho normal
  if v_id % 50 = 0 then delete from public.klingo_agendamento_evento where em < now() - interval '30 days'; end if;

  if v_motivo is not null then return jsonb_build_object('ok', false, 'motivo', v_motivo, 'id', v_id); end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end
$f$;

create or replace function public.klingo_agendamento_resultado(p_id bigint, p_resultado text)
returns void
language sql
security definer
set search_path = ''
as $f$
  update public.klingo_agendamento_evento
     set resultado = p_resultado
   where id = p_id
     and p_resultado in ('ok', 'recusado', 'divergente')
     and (resultado is null or p_resultado = 'divergente');
$f$;

revoke all on function public.klingo_agendamento_passar(text, text, text) from public, anon, authenticated;
revoke all on function public.klingo_agendamento_resultado(bigint, text) from public, anon, authenticated;
grant execute on function public.klingo_agendamento_passar(text, text, text) to service_role;
grant execute on function public.klingo_agendamento_resultado(bigint, text) to service_role;
