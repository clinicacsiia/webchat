-- Autoatendimento com a API do Klingo — Parte 2: funções de base (interruptores, segredos, cota, medidas, tradução de convênio, origem do agendado). Escrito em 12/11/2026.
--
-- FLUXOGRAMA: funções internas (só service_role) -> klingo_cfg lê um interruptor; klingo_ativo diz se ESTA conversa usa a automação (lista de teste, percentual);
--   klingo_hash gera o hash do CPF com um segredo próprio no cofre (separado do ia_segredo); klingo_segredo_ok confere o segredo das Edge Functions novas;
--   klingo_cota_pegar/klingo_cota_429 dividem as chamadas ao Klingo entre todas as funções; klingo_medir conta o que acontece (para a autogestão);
--   klingo_catalogo_gravar + klingo_plano_mapear_auto traduzem o convênio do chat (texto) para o plano do Klingo (número); klingo_plano_resolver escolhe o plano certo.
-- Versão 1.0 — 12/11/2026 / Mudança: primeira versão.
-- Para voltar atrás: drop function public.klingo_cfg(text, text), klingo_segredo_ok(text), klingo_hash(text), klingo_ativo(uuid, text), klingo_medir(text, bigint, bigint),
--   klingo_cota_pegar(integer), klingo_cota_429(), klingo_catalogo_gravar(jsonb), klingo_plano_mapear_auto(), klingo_plano_resolver(text, integer);
--   e recolocar pre_agendamento_autoria_trg como está em supabase/producao/funcoes/.

-- Segredos novos no cofre (valores aleatórios; ninguém os lê). Se já existirem, não mexe.
do $$ begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'klingo_hash_sal') then perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'klingo_hash_sal', 'sal do hash de CPF (autoatendimento Klingo)'); end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'klingo_interno_segredo') then perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'klingo_interno_segredo', 'segredo das Edge Functions internas do Klingo'); end if;
exception when others then raise notice 'cofre: %', sqlerrm;
end $$;

create or replace function public.klingo_cfg(p_chave text, p_padrao text default '') returns text
language sql stable security definer set search_path to '' as $$
  select coalesce((select valor from public.config where chave = p_chave), p_padrao)
$$;

create or replace function public.klingo_segredo() returns text
language plpgsql stable security definer set search_path to '' as $$
declare v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = 'klingo_interno_segredo' limit 1;
  return v;
exception when others then return null;
end $$;

-- A Edge Function manda o segredo que recebeu e pergunta ao banco se confere (assim ela nunca precisa conhecer o valor guardado).
create or replace function public.klingo_segredo_ok(p_valor text) returns boolean
language plpgsql stable security definer set search_path to '' as $$
declare v text := public.klingo_segredo();
begin
  return v is not null and p_valor is not null and length(p_valor) = length(v) and p_valor = v;
end $$;

create or replace function public.klingo_hash(p_texto text) returns text
language plpgsql stable security definer set search_path to '' as $$
declare v_sal text;
begin
  select decrypted_secret into v_sal from vault.decrypted_secrets where name = 'klingo_hash_sal' limit 1;
  if v_sal is null then raise exception 'klingo_hash_sal ausente no cofre'; end if;
  return encode(extensions.hmac(convert_to(coalesce(p_texto, ''), 'UTF8'), convert_to(v_sal, 'UTF8'), 'sha256'), 'hex');
end $$;

-- Esta conversa usa a automação? 'nao' nunca; telefone da lista de teste sempre; 'sim' respeita o percentual.
create or replace function public.klingo_ativo(p_conversa uuid, p_chave text) returns boolean
language plpgsql stable security definer set search_path to '' as $$
declare v_modo text := public.klingo_cfg(p_chave, 'nao'); v_tel text; v_pct integer;
begin
  if v_modo not in ('teste', 'sim') then return false; end if;
  select right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) into v_tel
    from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
  if v_tel is not null and length(v_tel) = 8 and exists (
       select 1 from regexp_split_to_table(public.klingo_cfg('klingo_api_telefones_teste', ''), '[^0-9]+') t
        where length(t) >= 8 and right(t, 8) = v_tel) then return true; end if;
  if v_modo = 'teste' then return false; end if;
  v_pct := least(100, greatest(0, coalesce(nullif(public.klingo_cfg('klingo_api_percentual', '100'), '')::integer, 100)));
  return (abs(hashtext(p_conversa::text)) % 100) < v_pct;
exception when others then return false;
end $$;

create or replace function public.klingo_medir(p_tipo text, p_n bigint default 1, p_ms bigint default null) returns void
language sql security definer set search_path to '' as $$
  insert into public.klingo_medida (dia, tipo, n, soma_ms) values ((now() at time zone 'America/Bahia')::date, left(p_tipo, 60), p_n, coalesce(p_ms, 0))
  on conflict (dia, tipo) do update set n = public.klingo_medida.n + excluded.n, soma_ms = public.klingo_medida.soma_ms + excluded.soma_ms
$$;

-- Cota: pede N fichas. ok=false traz quantos ms esperar. A função que chama espera (no máximo alguns segundos) e tenta de novo.
create or replace function public.klingo_cota_pegar(p_n integer default 1) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare c public.klingo_cota; v_agora timestamptz := clock_timestamp(); v_f numeric;
begin
  select * into c from public.klingo_cota where id for update;
  if c.pausado_ate is not null and c.pausado_ate > v_agora then
    return jsonb_build_object('ok', false, 'motivo', 'pausado', 'espera_ms', ceil(extract(epoch from c.pausado_ate - v_agora) * 1000)::int);
  end if;
  v_f := least(c.max_fichas, c.fichas + greatest(extract(epoch from v_agora - c.reposto_em), 0) * c.reposicao_por_s);
  if v_f >= p_n then
    update public.klingo_cota set fichas = v_f - p_n, reposto_em = v_agora, pausado_ate = null where id;
    return jsonb_build_object('ok', true);
  end if;
  update public.klingo_cota set fichas = v_f, reposto_em = v_agora where id;
  return jsonb_build_object('ok', false, 'motivo', 'sem_fichas', 'espera_ms', ceil((p_n - v_f) / c.reposicao_por_s * 1000)::int);
end $$;

-- O Klingo respondeu 429: todo mundo para por 60 s (o chat cai para a grade, com o aviso de previsão).
create or replace function public.klingo_cota_429() returns void
language plpgsql security definer set search_path to '' as $$
begin
  update public.klingo_cota set fichas = 0, reposto_em = clock_timestamp(), pausado_ate = clock_timestamp() + interval '60 seconds', ultimo_429_em = now() where id;
  perform public.klingo_medir('api_429');
end $$;

-- Catálogo do Klingo -> banco. p = {"convenios":[{id,nome,planos:[{id,nome}]}], "especialidades":[{cbos,nome,codigo,procedimentos:[...]}]}
create or replace function public.klingo_catalogo_gravar(p jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_c integer := 0; v_e integer := 0;
begin
  if jsonb_typeof(p -> 'convenios') = 'array' then
    insert into public.klingo_convenio (plano_id, convenio_id, convenio, plano, convenio_norm, padrao, visto_em)
    select (pl ->> 'id')::integer, (c ->> 'id')::integer, left(c ->> 'nome', 200), left(coalesce(pl ->> 'nome', ''), 200), coalesce(public.norm_nome(c ->> 'nome'), ''),
           coalesce(public.norm_nome(pl ->> 'nome') = public.norm_nome(c ->> 'nome'), false), now()
      from jsonb_array_elements(p -> 'convenios') c, jsonb_array_elements(case when jsonb_typeof(c -> 'planos') = 'array' then c -> 'planos' else '[]'::jsonb end) pl
     where (pl ->> 'id') ~ '^[0-9]+$' and (c ->> 'id') ~ '^[0-9]+$' and nullif(c ->> 'nome', '') is not null
    on conflict (plano_id) do update set convenio_id = excluded.convenio_id, convenio = excluded.convenio, plano = excluded.plano,
      convenio_norm = excluded.convenio_norm, padrao = excluded.padrao, visto_em = now();
    get diagnostics v_c = row_count;
  end if;
  if jsonb_typeof(p -> 'especialidades') = 'array' then
    insert into public.klingo_especialidade (cbos, nome, codigo, procedimentos, atualizado_em)
    select e ->> 'cbos', left(e ->> 'nome', 120), left(e ->> 'codigo', 20),
           coalesce((select array_agg(x::integer) from jsonb_array_elements_text(case when jsonb_typeof(e -> 'procedimentos') = 'array' then e -> 'procedimentos' else '[]'::jsonb end) x where x ~ '^[0-9]+$'), '{}'), now()
      from jsonb_array_elements(p -> 'especialidades') e where (e ->> 'cbos') ~ '^[0-9]+$'
    on conflict (cbos) do update set nome = excluded.nome, codigo = excluded.codigo, procedimentos = excluded.procedimentos, atualizado_em = now();
    get diagnostics v_e = row_count;
  end if;
  return jsonb_build_object('planos', v_c, 'especialidades', v_e, 'mapa', public.klingo_plano_mapear_auto());
end $$;

-- Traduz cada convênio do chat (texto de catalogo_plano.operadora) para o convênio/plano do Klingo. Nunca mexe no que a equipe escolheu à mão.
create or replace function public.klingo_plano_mapear_auto() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_a integer := 0; v_n integer := 0;
begin
  with conv as (
    select convenio_id, convenio_norm, (array_agg(plano_id order by plano_id) filter (where padrao))[1] as padrao_id, count(*) as n, min(plano_id) as unico
      from public.klingo_convenio group by convenio_id, convenio_norm),
  ops as (select distinct operadora from public.catalogo_plano where coalesce(ativo, true) and nullif(btrim(operadora), '') is not null)
  insert into public.klingo_plano_map (operadora, convenio_id, plano_id, origem)
  select o.operadora, c.convenio_id, case when c.padrao_id is not null then c.padrao_id when c.n = 1 then c.unico end, 'auto'
    from ops o join conv c on c.convenio_norm = public.norm_nome(o.operadora)
  on conflict (operadora) do update set convenio_id = excluded.convenio_id, plano_id = excluded.plano_id, origem = 'auto', atualizado_em = now()
    where public.klingo_plano_map.origem in ('auto', 'nao_atende');
  get diagnostics v_a = row_count;
  insert into public.klingo_plano_map (operadora, origem)
  select o.operadora, 'nao_atende' from (select distinct operadora from public.catalogo_plano where coalesce(ativo, true) and nullif(btrim(operadora), '') is not null) o
   where not exists (select 1 from public.klingo_plano_map m where m.operadora = o.operadora)
  on conflict (operadora) do nothing;
  get diagnostics v_n = row_count;
  return jsonb_build_object('traduzidos', v_a, 'sem_correspondencia_novos', v_n);
end $$;

-- Qual plano do Klingo usar para o convênio que o paciente escolheu no chat.
--   Particular: sempre o plano Particular. Convênio com plano padrão: o padrão, a não ser que o cadastro do paciente já tenha outro plano DO MESMO convênio.
--   Convênio sem plano padrão (ex.: milhares de planos): só com o plano que o paciente já tem no cadastro do Klingo. Sem isso, a automação não marca.
create or replace function public.klingo_plano_resolver(p_operadora text, p_plano_cadastro integer default null) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare m public.klingo_plano_map;
begin
  select * into m from public.klingo_plano_map where lower(btrim(operadora)) = lower(btrim(coalesce(p_operadora, ''))) limit 1;
  if m.operadora is null or m.origem = 'nao_atende' then return jsonb_build_object('plano_id', null, 'motivo', 'sem_traducao'); end if;
  if public.norm_nome(p_operadora) = 'PARTICULAR' and m.plano_id is not null then return jsonb_build_object('plano_id', m.plano_id, 'via', 'padrao'); end if;
  if p_plano_cadastro is not null and m.convenio_id is not null
     and exists (select 1 from public.klingo_convenio k where k.plano_id = p_plano_cadastro and k.convenio_id = m.convenio_id) then
    return jsonb_build_object('plano_id', p_plano_cadastro, 'via', 'cadastro');
  end if;
  if m.plano_id is not null then return jsonb_build_object('plano_id', m.plano_id, 'via', 'padrao'); end if;
  return jsonb_build_object('plano_id', null, 'motivo', 'plano_do_cadastro_necessario');
end $$;

-- Origem do "agendado": equipe | reconhecido | chat_api
create or replace function public.pre_agendamento_autoria_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  begin
    if new.status = 'agendado' and old.status is distinct from 'agendado' then
      new.agendado_em := now();
      new.agendado_por := case when coalesce((select public.papel_atual()), '') <> '' then (select auth.uid()) end;
      if new.agendado_origem is null then
        new.agendado_origem := case when new.agendado_por is not null then 'equipe' when new.agendado_auto_em is not null then 'reconhecido' end;
      end if;
    elsif old.status = 'agendado' and new.status is distinct from 'agendado' then
      new.agendado_origem := null;
    end if;
  exception when others then null;
  end;
  return new;
end $$;

update public.pre_agendamentos set agendado_origem = case when agendado_por is not null then 'equipe' when agendado_auto_em is not null then 'reconhecido' end
 where status = 'agendado' and agendado_origem is null and (agendado_por is not null or agendado_auto_em is not null);

-- Só o sistema chama estas funções
do $$ declare f text; begin
  for f in select unnest(array['klingo_cfg(text, text)', 'klingo_segredo()', 'klingo_segredo_ok(text)', 'klingo_hash(text)', 'klingo_ativo(uuid, text)', 'klingo_medir(text, bigint, bigint)',
      'klingo_cota_pegar(integer)', 'klingo_cota_429()', 'klingo_catalogo_gravar(jsonb)', 'klingo_plano_mapear_auto()', 'klingo_plano_resolver(text, integer)', 'pre_agendamento_autoria_trg()']) loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
