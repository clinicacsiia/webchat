-- FLUXOGRAMA: entrada (a tela do piloto e a do teste chamam pre_marcacao_registrar quando a pessoa deixa uma pré-marcação; a tela chama consulta_medicos para listar os médicos da consulta)
--   -> validação (protocolo, chave do aparelho, tipo e origem; prazo lido de config.pre_marcacao_prazo_horas, padrão 24; o prazo NÃO vem do aparelho, a não ser no teste)
--   -> lógica (o pedido fica guardado até vence_em; passado o prazo a rotina pre_marcacao_vencer marca "vencido", tira da fila de novos e o aparelho não consegue mais reabrir o pedido)
--   -> saída (aba Pré-marcação do painel mostra "Prazo vencido"; nada do pedido vai para o Klingo enquanto a pessoa não mandar tudo o que falta)
-- Versão 1.0 — 27/11/2026 / Mudança: implementação inicial (vencimento de 24 h da pré-marcação; origem 'piloto'; lista de médicos da consulta).
--   Parte de supabase/pre-marcacao-painel.sql (tabela e funções já aplicadas em 25/11/2026). Pode ser aplicado de novo sem efeito.
--
-- Regra do dono (27/11/2026): o pedido fica 24 horas porque não vamos ao Klingo até a pessoa mandar todos os arquivos.
-- Só mexe em linhas com tipo 'pre_marcacao' e situação 'aguardando_equipe'. Quem a equipe já resolveu ou descartou não é tocado.
-- Se a equipe está "em contato", o pedido fica marcado "vencido" mas continua na fila dela (ninguém some do painel no meio de uma conversa).
--
-- PARA VOLTAR ATRÁS (rollback):
--   select cron.unschedule('pre-marcacao-vigia');
--   drop function if exists public.pre_marcacao_vencer();
--   drop function if exists public.consulta_medicos(integer);
--   update public.pre_marcacao set situacao = 'aguardando_equipe' where situacao = 'vencido';
--   delete from public.config where chave = 'pre_marcacao_prazo_horas';
--   e reaplicar a função pre_marcacao_registrar de supabase/pre-marcacao-painel.sql (v1.1).

-- ===== PARTE 1: prazo (horas) =====
insert into public.config (chave, valor) values ('pre_marcacao_prazo_horas', '24') on conflict (chave) do nothing;

-- ===== PARTE 2: recebimento com o prazo decidido pelo servidor =====
create or replace function public.pre_marcacao_registrar(p jsonb)
 returns text
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_proto text; v_chave text; v_tipo text; d jsonb; pac jsonb; slot jsonb; pref jsonb; v_ident text; v_origem text; v_prazo integer;
  v_nome text; v_resp text; v_data date; v_dias text[]; v_pend text[]; v_ciente timestamptz; v_venc timestamptz; v_venc_cli timestamptz; v_cfg text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or length(p::text) > 200000 then raise exception 'dados_invalidos' using errcode = '22023'; end if;
  v_proto := upper(left(btrim(coalesce(p->>'protocolo', '')), 40));
  v_chave := left(btrim(coalesce(p->>'chave', '')), 80);
  v_tipo := coalesce(p->>'tipo', '');
  v_origem := case when p->>'origem' = 'piloto' then 'piloto' else 'teste' end;
  if v_proto !~ '^[A-Z0-9-]{6,40}$' or length(v_chave) < 16 or v_tipo not in ('pre_marcacao', 'contato_whatsapp', 'marcacao') then
    raise exception 'dados_invalidos' using errcode = '22023';
  end if;
  -- freio: no máximo 300 registros novos por hora
  if not exists (select 1 from public.pre_marcacao where protocolo = v_proto)
     and (select count(*) from public.pre_marcacao where criado_em > now() - interval '1 hour') >= 300 then
    raise exception 'limite' using errcode = '54000';
  end if;

  d := coalesce(p->'dados', '{}'::jsonb);
  if jsonb_typeof(d) <> 'object' then d := '{}'::jsonb; end if;
  d := d - 'fotoCart' - 'estado';                       -- foto e estado interno da tela ficam de fora
  pac := case when jsonb_typeof(d->'paciente') = 'object' then d->'paciente' else '{}'::jsonb end;
  slot := case when jsonb_typeof(d->'slot') = 'object' then d->'slot' else null end;
  pref := case when jsonb_typeof(d->'preferencia') = 'object' then d->'preferencia' else '{}'::jsonb end;

  v_ident := case when pac->>'tipo' = 'filho' then 'filho' else 'proprio' end;
  v_nome := left(btrim(coalesce(nullif(pac->>'nomeCrianca', ''), pac->>'nome', '')), 120);
  v_resp := case when v_ident = 'filho' then left(btrim(coalesce(pac->>'nome', '')), 120) else '' end;
  v_data := case when slot->>'data' ~ '^\d{4}-\d{2}-\d{2}$' then (slot->>'data')::date else null end;
  v_dias := case when jsonb_typeof(pref->'dias') = 'array'
    then coalesce((select array_agg(left(x, 20)) from jsonb_array_elements_text(pref->'dias') x), '{}') else '{}' end;
  v_pend := case when jsonb_typeof(d->'pendencias') = 'array'
    then coalesce((select array_agg(left(x, 120)) from jsonb_array_elements_text(d->'pendencias') x), '{}') else '{}' end;
  v_ciente := case when pref->'ciencia'->>'em' ~ '^\d{4}-\d{2}-\d{2}T' then (pref->'ciencia'->>'em')::timestamptz else null end;
  v_venc_cli := case when p->>'venceEm' ~ '^\d{4}-\d{2}-\d{2}T' then (p->>'venceEm')::timestamptz else null end;

  -- prazo: do servidor (config), nunca do aparelho. Única exceção: a página de TESTE, que tem um seletor de prazo para a diretoria (12 a 72 h).
  select valor into v_cfg from public.config where chave = 'pre_marcacao_prazo_horas';
  v_prazo := case when v_cfg ~ '^\d{1,3}$' then least(greatest(v_cfg::integer, 1), 168) else 24 end;
  v_venc := case
    when v_tipo <> 'pre_marcacao' then null
    when v_origem = 'teste' and v_venc_cli is not null and v_venc_cli between now() - interval '30 days' and now() + interval '72 hours' then v_venc_cli
    else now() + make_interval(hours => v_prazo) end;

  insert into public.pre_marcacao as t (protocolo, chave_cliente, origem, tipo, situacao, tipo_ident, nome_paciente, responsavel, telefone, email, consulta, pagamento,
      convenio, plano, medico, horario_data, horario_hora, horario_local, periodo, dias, pendencias, motivo, carteirinha, ciente_em, vence_em, dados)
  values (v_proto, v_chave, v_origem, v_tipo, left(coalesce(p->>'status', ''), 40), v_ident, v_nome, v_resp,
      left(btrim(coalesce(pac->>'telefone', '')), 30), left(btrim(coalesce(pac->>'email', '')), 200), left(btrim(coalesce(d->>'procNome', '')), 120),
      left(btrim(coalesce(d->>'pagto', '')), 40), left(btrim(coalesce(d->>'convenio', '')), 120), left(btrim(coalesce(d->>'plano', '')), 160),
      left(btrim(coalesce(nullif(slot->>'profissional', ''), d->'busca'->>'medicoNome', nullif(d->>'medicoNome', ''), '')), 120), v_data, left(coalesce(slot->>'hora', ''), 10),
      left(btrim(concat_ws(' · ', nullif(slot->>'local', ''), nullif(slot->>'unidade', ''))), 160),
      left(coalesce(pref->>'periodo', ''), 20), v_dias, v_pend, left(btrim(coalesce(p->>'motivo', '')), 300),
      coalesce((d->>'carteirinha')::boolean, false), v_ciente, v_venc, d)
  on conflict (protocolo) do update set
      tipo = excluded.tipo, situacao = excluded.situacao, tipo_ident = excluded.tipo_ident, nome_paciente = excluded.nome_paciente,
      responsavel = excluded.responsavel, telefone = excluded.telefone, email = excluded.email, consulta = excluded.consulta,
      pagamento = excluded.pagamento, convenio = excluded.convenio, plano = excluded.plano,
      medico = case when excluded.medico <> '' then excluded.medico else t.medico end,
      horario_data = excluded.horario_data, horario_hora = excluded.horario_hora, horario_local = excluded.horario_local,
      periodo = excluded.periodo, dias = excluded.dias, pendencias = excluded.pendencias, motivo = excluded.motivo,
      carteirinha = excluded.carteirinha, ciente_em = coalesce(excluded.ciente_em, t.ciente_em),
      vence_em = case when excluded.tipo <> 'pre_marcacao' then null
                      when t.origem = 'teste' and v_venc_cli is not null and v_venc_cli between now() - interval '30 days' and now() + interval '72 hours' then v_venc_cli
                      else coalesce(t.vence_em, excluded.vence_em) end,   -- o aparelho não estica o prazo
      dados = excluded.dados, atualizado_em = now()
    where t.chave_cliente = excluded.chave_cliente   -- outro aparelho não mexe no protocolo alheio
      and t.situacao <> 'vencido';                   -- pedido vencido não é reaberto: a pessoa faz um novo
  return v_proto;
end $function$;

revoke all on function public.pre_marcacao_registrar(jsonb) from public;
grant execute on function public.pre_marcacao_registrar(jsonb) to anon, authenticated, service_role;

-- ===== PARTE 3: rotina que vence os pedidos =====
create or replace function public.pre_marcacao_vencer()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_n integer;
begin
  with v as (
    update public.pre_marcacao
       set situacao = 'vencido',
           obs = case when fila = 'novo'
                      then left(concat_ws(E'\n', nullif(obs, ''), 'Vencido automaticamente: passou o prazo sem o paciente completar o pedido.'), 2000)
                      else obs end,
           fila = case when fila = 'novo' then 'descartado' else fila end,
           atualizado_em = now()
     where tipo = 'pre_marcacao' and situacao = 'aguardando_equipe' and fila in ('novo', 'em_contato')
       and vence_em is not null and vence_em < now()
    returning 1)
  select count(*) into v_n from v;
  return v_n;
end $function$;

revoke all on function public.pre_marcacao_vencer() from public, anon, authenticated;
grant execute on function public.pre_marcacao_vencer() to service_role;

select cron.unschedule('pre-marcacao-vigia') where exists (select 1 from cron.job where jobname = 'pre-marcacao-vigia');
select cron.schedule('pre-marcacao-vigia', '*/10 * * * *', 'select public.pre_marcacao_vencer()');

-- ===== PARTE 4: médicos que atendem a consulta (nomes, sem horário) =====
-- A agenda do Klingo só lista médicos que têm horário livre (e, para alguns planos, nenhum). Quem atende a consulta tem médico: esta lista vem do cadastro
-- das agendas (catalogo_agenda), só das unidades que marcam sozinhas, sem os bloqueados. Devolve só nomes (os mesmos que o chat já mostra ao paciente).
create or replace function public.consulta_medicos(p_procedimento_id integer)
 returns jsonb
 language sql
 stable security definer
 set search_path to ''
as $function$
  select coalesce(jsonb_agg(x.m order by x.m), '[]'::jsonb)
  from (select distinct m
        from public.unidade_config uc
        cross join lateral public.consultas_da_unidade(uc.catalogo) cu
        cross join lateral unnest(cu.medicos) as m
        where cu.id = p_procedimento_id and public.unidade_marca_auto(uc.catalogo)) x
$function$;

revoke all on function public.consulta_medicos(integer) from public;
grant execute on function public.consulta_medicos(integer) to anon, authenticated, service_role;
