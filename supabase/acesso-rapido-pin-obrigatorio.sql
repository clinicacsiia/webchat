-- FLUXOGRAMA: entrada (o chat abre e pergunta a app_porta se o PIN é obrigatório; a página /acesso/ chama app_pre_cadastro e app_pin_criar no primeiro acesso e app_acesso_registrar a cada entrada) -> validação (interruptor config.app_pin_obrigatorio; celular, nome, nascimento (maior de 18), CPF com dígito verificador do titular e de cada filho; aparelho desbloqueado pelo PIN para registrar o acesso) -> lógica (o servidor procura em silêncio o que a clínica já sabe daquela pessoa — mesmo celular + nome + nascimento — e só diz "falta o CPF" ou "não falta nada"; cria o cadastro com CPF e o PIN na mesma chamada, tudo ou nada; cada entrada grava aparelho, horário, IP e, só com permissão, a posição, e confere se a pessoa está na clínica e se tem exame hoje) -> saída (a tela nunca recebe CPF nem dado da clínica; a equipe lê o histórico de acessos em painel_app_acessos)
-- Versão 1.1 — 15/11/2026 / Mudança: o chat não pergunta mais CPF e nascimento a quem já tem os dados salvos: só pergunta "seus dados continuam os mesmos?" (app_chat_dados_resumo) e, se a pessoa disser que mudou, grava o novo valor no cadastro (app_dados_atualizar). Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (PIN obrigatório na porta do chat; pré-preenchimento pelo histórico; CPF obrigatório antes do PIN; registro de acessos com posição opcional)
--
-- POR QUE: o dono quer o PIN no começo de tudo. Quem é novo cria o PIN informando só o que falta; quem já preencheu antes (no chat, na clínica ou neste
-- aparelho) não digita de novo; quem passou 30 minutos sem usar confirma o PIN; e cada entrada fica registrada (aparelho, horário, IP e, se a pessoa
-- permitir, a posição para saber se está na clínica e conferir com o exame do dia).
--
-- PRIVACIDADE (mesma regra do restante do acesso rápido, docs/acesso-rapido-paciente.md): o celular NÃO é confirmado por SMS. Por isso a consulta ao
-- histórico exige os TRÊS dados juntos (celular + nome completo + data de nascimento) e NUNCA devolve o que achou: devolve só "falta o CPF" ou "não falta".
-- O CPF encontrado é gravado direto no cadastro, dentro do banco. Filhos do histórico NÃO são listados: só se completa o CPF de quem a pessoa digitou.
--
-- POSIÇÃO: só com config.app_local_ativo = 'sim' e com a permissão do aparelho. Guarda a posição arredondada (3 casas, cerca de 100 m), a precisão, a
-- distância até a clínica e "na clínica sim/não". Sem as coordenadas da clínica em config (clinica_lat, clinica_lng) não há como dizer "na clínica".
-- Registros com mais de 180 dias são apagados pela rotina diária (app_acesso_limpar, arquivo acesso-rapido-pin-obrigatorio-rotina.sql).
--
-- LIGAR (nasce DESLIGADO; nada muda para o paciente até lá):
--   update public.config set valor = 'sim' where chave = 'app_pin_obrigatorio';
-- DESLIGAR na hora (o chat volta a abrir sem PIN):  ... valor = 'nao' ...
-- POSIÇÃO: clinica_lat e clinica_lng (graus decimais, ex.: -12.9714) e clinica_raio_m (metros); depois  app_local_ativo = 'sim'.
--
-- ROLLBACK (não mexe em nenhuma função existente):
--   drop function if exists public.app_chat_pessoa(uuid, uuid), public.app_dados_atualizar(text, uuid, text), public.app_chat_dados_resumo(text, uuid, text), public.painel_app_acessos(uuid, integer), public.app_acesso_registrar(text, text, jsonb, jsonb),
--     public.app_pin_criar(text, text, text, text, text, jsonb, jsonb, text, text), public.app_pre_cadastro(text, text, text, jsonb),
--     public.app_porta(), public.app_cpf_historico(text, text, date, text), public.app_distancia_m(numeric, numeric, numeric, numeric);
--   drop table if exists public.app_acesso_log;
--   delete from public.config where chave in ('app_pin_obrigatorio', 'app_local_ativo', 'clinica_lat', 'clinica_lng', 'clinica_raio_m');
-- Pode ser aplicado mais de uma vez.

insert into public.config (chave, valor) values
  ('app_pin_obrigatorio', 'nao'), ('app_local_ativo', 'nao'), ('clinica_lat', ''), ('clinica_lng', ''), ('clinica_raio_m', '300')
on conflict (chave) do nothing;

-- Histórico de acessos (só a equipe lê, pela função painel_app_acessos; nenhuma regra de acesso = ninguém lê a tabela direto).
create table if not exists public.app_acesso_log (
  id bigint generated always as identity primary key,
  paciente_id uuid not null references public.app_paciente(id) on delete cascade,
  aparelho_id uuid references public.app_aparelho(id) on delete set null,
  evento text not null check (evento in ('cadastro', 'login', 'desbloqueio', 'conta_antiga', 'pin_esqueci', 'abertura')),
  em timestamptz not null default now(),
  ip text, agente text, idioma text, fuso text, tela text, plataforma text,
  lat numeric(8, 3), lng numeric(9, 3), precisao_m integer, distancia_m integer, na_clinica boolean, local_negado boolean not null default false,
  exames_hoje integer
);
comment on table public.app_acesso_log is 'Cada entrada no acesso rápido: aparelho, horário, IP, idioma, fuso e, só com permissão, a posição arredondada (~100 m) e se estava na clínica. Só a equipe lê (painel_app_acessos). Apagado depois de 180 dias.';
create index if not exists app_acesso_log_pac on public.app_acesso_log (paciente_id, em desc);
create index if not exists app_acesso_log_em on public.app_acesso_log (em);
alter table public.app_acesso_log enable row level security;

-- Distância em metros entre dois pontos (fórmula de haversine).
create or replace function public.app_distancia_m(p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric) returns integer language sql immutable set search_path to '' as $$
  select round(2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians((p_lat2 - p_lat1)::float8) / 2), 2) +
    cos(radians(p_lat1::float8)) * cos(radians(p_lat2::float8)) * power(sin(radians((p_lng2 - p_lng1)::float8) / 2), 2)))))::integer $$;

-- Interno: o CPF que a clínica ou as conversas antigas já têm DESTA pessoa (mesmo celular + nome + nascimento). Nunca vai para a tela.
create or replace function public.app_cpf_historico(p_tel text, p_nome text, p_nasc date, p_tipo text) returns text language sql stable security definer set search_path to '' as $$
  select t.cpf from (
    select regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g') as cpf, 1 as ord
      from public.pacientes p
     where p_tipo = 'proprio' and p.dt_nasc = p_nasc and p.telefones && array[p_tel, '55' || p_tel] and public.app_norm(p.nome) = public.app_norm(p_nome)
    union all
    select d.cpf, 2
      from public.conversas c
      join public.contatos ct on ct.id = c.contato_id
      left join public.pre_agendamentos pa on pa.conversa_id = c.id
      left join public.conversa_fluxo cf on cf.conversa_id = c.id
      cross join lateral (values
        (regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g'), coalesce(public.app_data_flex(pa.paciente ->> 'dt_nasc'), public.app_data_flex(cf.dados -> 'digitado' ->> 'dt_nasc'))),
        (regexp_replace(coalesce(cf.dados -> 'digitado' ->> 'cpf', ''), '\D', '', 'g'), coalesce(public.app_data_flex(cf.dados -> 'digitado' ->> 'dt_nasc'), public.app_data_flex(pa.paciente ->> 'dt_nasc')))
      ) d(cpf, nasc)
     where regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g') in (p_tel, '55' || p_tel)
       and c.paciente_tipo = p_tipo
       and public.app_norm(coalesce(c.paciente_nome, ct.nome)) = public.app_norm(p_nome)
       and d.nasc = p_nasc
  ) t
  where t.cpf ~ '^[0-9]{11}$' and public.fluxo_cpf_ok(t.cpf)
  order by t.ord limit 1 $$;

-- A porta do chat: o chat pergunta isto ao abrir. Não tem dado de ninguém.
create or replace function public.app_porta() returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'ativo', public.app_modo(),
    'obrigatorio', public.app_modo() and coalesce((select valor from public.config where chave = 'app_pin_obrigatorio'), 'nao') = 'sim',
    'local', public.app_modo() and coalesce((select valor from public.config where chave = 'app_local_ativo'), 'nao') = 'sim') $$;

-- Primeiro acesso, passo "o que falta": diz se o celular já tem PIN e de quem ainda falta o CPF. Nunca devolve o que a clínica tem guardado.
create or replace function public.app_pre_cadastro(p_telefone text, p_nome text, p_nascimento text, p_filhos jsonb default '[]'::jsonb) returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_nasc date := public.app_data(p_nascimento); v_filhos jsonb := coalesce(p_filhos, '[]'::jsonb); v_f jsonb; v_i integer := 0; v_fd date; v_falta jsonb := '[]'::jsonb;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if v_tel !~ '^[1-9]{2}9[0-9]{8}$' then return jsonb_build_object('ok', false, 'erro', 'celular', 'mensagem', 'Celular inválido. Use DDD + 9 dígitos.'); end if;
  if exists (select 1 from public.app_paciente where telefone = v_tel) then return jsonb_build_object('ok', true, 'situacao', 'tem_pin'); end if;
  if not public.app_nome_ok(v_nome) then return jsonb_build_object('ok', false, 'erro', 'nome', 'mensagem', 'Digite nome e sobrenome completos.'); end if;
  if v_nasc is null or v_nasc > public.app_hoje() or v_nasc < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'nascimento', 'mensagem', 'Data de nascimento inválida.'); end if;
  if public.app_idade(v_nasc) < 18 then return jsonb_build_object('ok', false, 'erro', 'menor', 'mensagem', 'O cadastro principal precisa ser de um maior de 18 anos.'); end if;
  if jsonb_typeof(v_filhos) <> 'array' or jsonb_array_length(v_filhos) > 10 then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Lista de filhos inválida (no máximo 10).'); end if;
  if public.app_cpf_historico(v_tel, v_nome, v_nasc, 'proprio') is null then v_falta := v_falta || jsonb_build_object('pessoa', 'eu'); end if;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_fd := public.app_data(v_f ->> 'nascimento');
    if jsonb_typeof(v_f) <> 'object' or not public.app_nome_ok(v_f ->> 'nome') then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Informe nome e sobrenome do filho(a).'); end if;
    if v_fd is null or v_fd > public.app_hoje() or v_fd < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Data de nascimento do filho(a) inválida.'); end if;
    if public.app_cpf_historico(v_tel, v_f ->> 'nome', v_fd, 'filho') is null then v_falta := v_falta || jsonb_build_object('pessoa', 'filho', 'indice', v_i); end if;
    v_i := v_i + 1;
  end loop;
  return jsonb_build_object('ok', true, 'situacao', 'novo', 'falta', v_falta);
end $$;

-- Interno: grava uma linha do histórico de acessos (o que o servidor sabe sozinho: aparelho, IP, hora).
create or replace function public.app_acesso_gravar(p_pac uuid, p_aparelho uuid, p_evento text, p_local jsonb, p_disp jsonb) returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_ip text; v_lat numeric; v_lng numeric; v_prec integer; v_dist integer; v_na boolean; v_neg boolean := false; v_clat numeric; v_clng numeric; v_raio integer; v_ex integer; v_hoje text;
  v_local_on boolean := coalesce((select valor from public.config where chave = 'app_local_ativo'), 'nao') = 'sim';
begin
  begin v_ip := left(nullif(btrim(split_part(coalesce(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', ''), ',', 1)), ''), 60); exception when others then v_ip := null; end;
  if v_local_on and p_local is not null and jsonb_typeof(p_local) = 'object' then
    if coalesce(p_local ->> 'negado', '') = 'true' then v_neg := true;
    elsif coalesce(p_local ->> 'lat', '') ~ '^-?[0-9]+(\.[0-9]+)?$' and coalesce(p_local ->> 'lng', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then
      v_lat := (p_local ->> 'lat')::numeric; v_lng := (p_local ->> 'lng')::numeric;
      if v_lat between -90 and 90 and v_lng between -180 and 180 then
        v_prec := case when coalesce(p_local ->> 'precisao', '') ~ '^[0-9]+(\.[0-9]+)?$' then least(round((p_local ->> 'precisao')::numeric), 100000)::integer end;
        select case when valor ~ '^-?[0-9]+(\.[0-9]+)?$' then valor::numeric end into v_clat from public.config where chave = 'clinica_lat';
        select case when valor ~ '^-?[0-9]+(\.[0-9]+)?$' then valor::numeric end into v_clng from public.config where chave = 'clinica_lng';
        select case when valor ~ '^[0-9]+$' then valor::int end into v_raio from public.config where chave = 'clinica_raio_m';
        if v_clat is not null and v_clng is not null then
          v_dist := public.app_distancia_m(v_lat, v_lng, v_clat, v_clng);
          v_na := v_dist <= coalesce(v_raio, 300);
        end if;
        v_lat := round(v_lat, 3); v_lng := round(v_lng, 3);
      else v_lat := null; v_lng := null; end if;
    end if;
  end if;
  v_hoje := to_char(now() at time zone 'America/Bahia', 'YYYY-MM-DD');
  begin
    select count(*)::integer into v_ex from jsonb_array_elements(public.app_pedido_dados(p_pac)) p, jsonb_array_elements(p -> 'exames') e
     where e ->> 'data' = v_hoje and coalesce((e ->> 'ok')::int, 0) between 2 and 4 and e ->> 'excecao' is null;
  exception when others then v_ex := null; end;
  insert into public.app_acesso_log (paciente_id, aparelho_id, evento, ip, agente, idioma, fuso, tela, plataforma, lat, lng, precisao_m, distancia_m, na_clinica, local_negado, exames_hoje)
  values (p_pac, p_aparelho, p_evento, v_ip, left(p_disp ->> 'agente', 200), left(p_disp ->> 'idioma', 20), left(p_disp ->> 'fuso', 60), left(p_disp ->> 'tela', 20), left(p_disp ->> 'plataforma', 60),
          v_lat, v_lng, v_prec, v_dist, v_na, v_neg, v_ex);
  return jsonb_build_object('na_clinica', v_na, 'exames_hoje', coalesce(v_ex, 0), 'local_negado', v_neg);
end $$;

-- Limpeza dos registros com mais de 180 dias: rodada pela rotina diária (acesso-rapido-pin-obrigatorio-rotina.sql), não a cada entrada.
create or replace function public.app_acesso_limpar() returns integer language plpgsql security definer set search_path to '' as $$
declare v_n integer;
begin
  with apagados as (delete from public.app_acesso_log where em < now() - interval '180 days' returning 1)
  select count(*)::integer into v_n from apagados;
  return v_n;
end $$;

-- Primeiro acesso completo: CPF (dela e dos filhos) + PIN na MESMA chamada, tudo ou nada. O que a clínica já sabe é aproveitado em silêncio.
create or replace function public.app_pin_criar(p_telefone text, p_nome text, p_nascimento text, p_pin text, p_cpf text default null, p_filhos jsonb default '[]'::jsonb,
  p_confianca jsonb default null, p_aparelho text default null, p_email text default null) returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')); v_nasc date := public.app_data(p_nascimento);
  v_filhos jsonb := coalesce(p_filhos, '[]'::jsonb); v_f jsonb; v_fd date; v_cpf text := nullif(regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'), ''); v_fcpf text; v_i integer := 0;
  v_cpfs text[] := '{}'; v_r jsonb; v_pac uuid; v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if jsonb_typeof(v_filhos) <> 'array' or jsonb_array_length(v_filhos) > 10 then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Lista de filhos inválida (no máximo 10).'); end if;
  if v_cpf is not null and not public.fluxo_cpf_ok(v_cpf) then return jsonb_build_object('ok', false, 'erro', 'cpf', 'mensagem', 'Os números do seu CPF não conferem. Confira, por favor.'); end if;
  if v_cpf is null and v_tel ~ '^[1-9]{2}9[0-9]{8}$' and public.app_nome_ok(v_nome) and v_nasc is not null then v_cpf := public.app_cpf_historico(v_tel, v_nome, v_nasc, 'proprio'); end if;
  if v_cpf is null then return jsonb_build_object('ok', false, 'erro', 'cpf_falta', 'mensagem', 'Informe o seu CPF para criar o PIN.'); end if;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_fd := public.app_data(v_f ->> 'nascimento'); v_fcpf := nullif(regexp_replace(coalesce(v_f ->> 'cpf', ''), '\D', '', 'g'), '');
    if v_fcpf is not null and not public.fluxo_cpf_ok(v_fcpf) then return jsonb_build_object('ok', false, 'erro', 'filho_cpf', 'indice', v_i, 'mensagem', 'Os números do CPF de ' || split_part(coalesce(v_f ->> 'nome', 'filho(a)'), ' ', 1) || ' não conferem.'); end if;
    if v_fcpf is null and v_fd is not null and public.app_nome_ok(v_f ->> 'nome') and v_tel ~ '^[1-9]{2}9[0-9]{8}$' then v_fcpf := public.app_cpf_historico(v_tel, v_f ->> 'nome', v_fd, 'filho'); end if;
    if v_fcpf is null then return jsonb_build_object('ok', false, 'erro', 'filho_cpf_falta', 'indice', v_i, 'mensagem', 'Informe o CPF de ' || split_part(coalesce(v_f ->> 'nome', 'filho(a)'), ' ', 1) || ' (se a criança não tiver, o do responsável).'); end if;
    v_cpfs := v_cpfs || v_fcpf; v_i := v_i + 1;
  end loop;
  v_r := public.app_cadastrar(p_telefone, p_nome, p_nascimento, p_pin, v_filhos, p_confianca, p_aparelho);
  if coalesce((v_r ->> 'ok')::boolean, false) is not true then return v_r; end if;
  select id into v_pac from public.app_paciente where telefone = v_tel;
  update public.app_paciente set cpf = v_cpf, atualizado_em = now(), email = case when v_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(v_email) <= 200 then v_email else email end where id = v_pac;
  v_i := 0;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_i := v_i + 1;
    update public.app_filho set cpf = v_cpfs[v_i]
     where responsavel_id = v_pac and removido_em is null and public.app_norm(nome) = public.app_norm(v_f ->> 'nome') and nascimento = public.app_data(v_f ->> 'nascimento');
  end loop;
  perform public.app_conferir_cadastro(v_pac);
  return jsonb_build_object('ok', true, 'token', v_r ->> 'token', 'perfil', public.app_perfil_json(v_pac));
end $$;

-- A cada entrada (cadastro, PIN, novo aparelho, conta antiga): grava aparelho, IP, horário e, com permissão, a posição. Exige o aparelho desbloqueado.
create or replace function public.app_acesso_registrar(p_token text, p_evento text, p_local jsonb default null, p_dispositivo jsonb default null) returns jsonb language plpgsql security definer set search_path to '' as $$
declare s record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if coalesce(p_evento, '') not in ('cadastro', 'login', 'desbloqueio', 'conta_antiga', 'pin_esqueci', 'abertura') then return jsonb_build_object('ok', false, 'erro', 'evento', 'mensagem', 'Não foi possível registrar.'); end if;
  return jsonb_build_object('ok', true) || public.app_acesso_gravar(s.o_pac, s.o_aparelho, p_evento, p_local, coalesce(p_dispositivo, '{}'::jsonb));
end $$;

-- Equipe: histórico de acessos (de uma pessoa ou os mais recentes).
create or replace function public.painel_app_acessos(p_paciente uuid default null, p_limite integer default 50) returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê os acessos.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(r order by r ->> 'em' desc) from (
    select jsonb_build_object('paciente_id', l.paciente_id, 'nome', a.nome, 'evento', l.evento, 'em', l.em, 'ip', l.ip, 'aparelho', ap.aparelho, 'agente', l.agente, 'fuso', l.fuso,
      'na_clinica', l.na_clinica, 'distancia_m', l.distancia_m, 'precisao_m', l.precisao_m, 'local_negado', l.local_negado, 'exames_hoje', l.exames_hoje,
      'divergente', coalesce(l.exames_hoje, 0) > 0 and l.na_clinica is false) as r
    from public.app_acesso_log l join public.app_paciente a on a.id = l.paciente_id left join public.app_aparelho ap on ap.id = l.aparelho_id
    where p_paciente is null or l.paciente_id = p_paciente
    order by l.em desc limit least(greatest(coalesce(p_limite, 50), 1), 300)) x), '[]'::jsonb);
end $$;


-- Interno: de quem é a conversa (a própria pessoa ou um filho do cadastro). Mesma regra de app_chat_dados: a conversa precisa ser do celular do cadastro.
create or replace function public.app_chat_pessoa(p_pac uuid, p_conversa uuid, out o_erro text, out o_eu boolean, out o_filho uuid, out o_nome text, out o_cpf text, out o_nasc date)
  language plpgsql stable security definer set search_path to '' as $$
declare a public.app_paciente%rowtype; c public.conversas; f public.app_filho%rowtype; v_tel text;
begin
  select * into a from public.app_paciente where id = p_pac;
  select * into c from public.conversas where id = p_conversa;
  select regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g') into v_tel from public.contatos ct where ct.id = c.contato_id;
  if v_tel is distinct from a.telefone then o_erro := 'celular'; return; end if;
  o_eu := coalesce(c.paciente_tipo, 'proprio') = 'proprio';
  if o_eu then o_nome := a.nome; o_cpf := a.cpf; o_nasc := a.nascimento;
  else
    select * into f from public.app_filho where responsavel_id = a.id and removido_em is null and public.app_norm(nome) = public.app_norm(c.paciente_nome) limit 1;
    if not found then o_erro := 'pessoa'; return; end if;
    o_filho := f.id; o_nome := f.nome; o_cpf := f.cpf; o_nasc := f.nascimento;
  end if;
end $$;

-- O chat pergunta isto quando o motor pede CPF e nascimento: se o cadastro já tem, o chat só pergunta "seus dados continuam os mesmos?" (CPF só mascarado).
create or replace function public.app_chat_dados_resumo(p_token text, p_conversa uuid, p_conv_token text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare s record; r record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  begin perform public.chat_valida(p_conversa, p_conv_token);
  exception when others then return jsonb_build_object('ok', false, 'erro', 'conversa'); end;
  select * into r from public.app_chat_pessoa(s.o_pac, p_conversa);
  if r.o_erro is not null then return jsonb_build_object('ok', false, 'erro', r.o_erro); end if;
  return jsonb_build_object('ok', true, 'tem', r.o_cpf is not null and r.o_nasc is not null, 'cpf_mascara', public.app_cpf_mascara(r.o_cpf),
    'nascimento', r.o_nasc, 'primeiro_nome', split_part(r.o_nome, ' ', 1), 'eu', r.o_eu);
end $$;

-- A pessoa disse "mudou algo" e digitou no chat: o valor novo passa a valer no cadastro (o PIN dela, digitado há menos de 30 minutos, é a prova).
create or replace function public.app_dados_atualizar(p_token text, p_conversa uuid, p_conv_token text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare s record; r record; d jsonb; pa public.pre_agendamentos; v_cpf text; v_nasc date; v_mudou boolean := false;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  begin perform public.chat_valida(p_conversa, p_conv_token);
  exception when others then return jsonb_build_object('ok', false, 'erro', 'conversa'); end;
  select * into r from public.app_chat_pessoa(s.o_pac, p_conversa);
  if r.o_erro is not null then return jsonb_build_object('ok', false, 'erro', r.o_erro); end if;
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  v_cpf := regexp_replace(coalesce(d -> 'digitado' ->> 'cpf', pa.paciente ->> 'cpf', ''), '\D', '', 'g');
  v_nasc := coalesce(public.app_data_flex(d -> 'digitado' ->> 'dt_nasc'), public.app_data_flex(pa.paciente ->> 'dt_nasc'));
  if v_cpf ~ '^[0-9]{11}$' and public.fluxo_cpf_ok(v_cpf) and v_cpf is distinct from r.o_cpf then
    if r.o_eu then update public.app_paciente set cpf = v_cpf, atualizado_em = now() where id = s.o_pac; perform public.app_conferir_cadastro(s.o_pac);
    else update public.app_filho set cpf = v_cpf where id = r.o_filho; end if;
    v_mudou := true;
  end if;
  if v_nasc is not null and v_nasc between date '1900-01-01' and public.app_hoje() and v_nasc is distinct from r.o_nasc then
    if r.o_eu and public.app_idade(v_nasc) >= 18 then update public.app_paciente set nascimento = v_nasc, atualizado_em = now() where id = s.o_pac; v_mudou := true;
    elsif not r.o_eu then update public.app_filho set nascimento = v_nasc where id = r.o_filho; v_mudou := true; end if;
  end if;
  if v_mudou then perform public.app_evento_gravar(s.o_pac, 'dados_atualizados_no_chat'); end if;
  return jsonb_build_object('ok', true, 'atualizou', v_mudou, 'perfil', public.app_perfil_json(s.o_pac));
end $$;

revoke all on function public.app_distancia_m(numeric, numeric, numeric, numeric), public.app_cpf_historico(text, text, date, text), public.app_porta(),
  public.app_pre_cadastro(text, text, text, jsonb), public.app_acesso_gravar(uuid, uuid, text, jsonb, jsonb),
  public.app_pin_criar(text, text, text, text, text, jsonb, jsonb, text, text), public.app_acesso_registrar(text, text, jsonb, jsonb), public.painel_app_acessos(uuid, integer),
  public.app_chat_pessoa(uuid, uuid), public.app_chat_dados_resumo(text, uuid, text), public.app_dados_atualizar(text, uuid, text), public.app_acesso_limpar()
  from public, anon, authenticated;
grant execute on function public.app_porta(), public.app_pre_cadastro(text, text, text, jsonb), public.app_pin_criar(text, text, text, text, text, jsonb, jsonb, text, text),
  public.app_acesso_registrar(text, text, jsonb, jsonb), public.app_chat_dados_resumo(text, uuid, text), public.app_dados_atualizar(text, uuid, text) to anon, authenticated;
grant execute on function public.painel_app_acessos(uuid, integer) to authenticated;
