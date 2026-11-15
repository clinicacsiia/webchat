-- FLUXOGRAMA: entrada (o paciente cadastra ou adiciona um filho; quem tem conta antiga entra com e-mail e senha e a página lista os filhos que já marcaram exames nessa conta) -> validação (nome e nascimento do filho; filho com o MESMO nome do titular é ele mesmo ou precisa de confirmação; mesmo filho duas vezes vale uma; no máximo 10) -> lógica (conta antiga: junta o histórico dos filhos da conta, a pessoa confere, corrige e confirma; o CPF do filho só vem do histórico da PRÓPRIA conta autenticada) -> saída (filhos gravados em app_filho; nenhuma pergunta repetida no chat)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (filhos dos contatos antigos; homônimo do titular; filho repetido)
--
-- POR QUE (dados reais de 15/11/2026, só contagens): 262 contatos marcaram atendimento "para filho" e 22 têm mais de um filho. 14 desses contatos têm um
-- "filho" com o MESMO nome do próprio contato (3 com nascimento de adulto = a própria pessoa marcada como filho; 4 com nascimento de criança; 7 sem
-- nascimento) e em 4 deles há também outros filhos de verdade. O acesso rápido tratava esse "filho" como mais um filho. Agora:
--   * filho com o mesmo nome E o mesmo nascimento do titular  -> recusado ("é o seu próprio cadastro");
--   * filho com o mesmo nome do titular e nascimento diferente -> a pessoa precisa CONFIRMAR que é outra pessoa (ex.: filha com o nome da mãe);
--   * o mesmo filho (nome + nascimento) digitado duas vezes     -> vale uma vez só.
--
-- CONTAS ANTIGAS (4 das 5 que aparecem no histórico têm filhos): app_conta_antiga_filhos() lista, só para quem está logado na conta, os filhos dos
-- atendimentos ligados à PRÓPRIA conta (conversas.conta_id), com nascimento e CPF mascarado quando o histórico tem. app_conta_antiga_migrar() grava os
-- que a pessoa confirmar (e, se o nome e o nascimento batem com o histórico da conta, traz o CPF dele; senão ele entra em "Falta pouco").
-- Contatos SEM conta (só celular) NÃO têm filhos trazidos do histórico: o celular não é confirmado e isso mostraria nomes e dados de crianças a quem só
-- digitou um número. Eles digitam os filhos e o CPF uma vez, com as mesmas regras de homônimo e repetido.
--
-- SEGURANÇA: as duas funções da conta antiga só executam para o papel authenticated e usam auth.uid(); nenhuma lê conversas de outra conta ou de outro
-- celular. Nenhuma devolve CPF inteiro.
--
-- ROLLBACK (voltar às versões anteriores = reaplicar acesso-rapido-paciente.sql e acesso-rapido-conta-antiga.sql):
--   drop function if exists public.app_conta_antiga_migrar(text, text, text, text, jsonb, text), public.app_conta_antiga_filhos(), public.app_conta_antiga_historico_filhos(uuid),
--     public.app_filho_adicionar(text, text, text, boolean), public.app_filho_conflito(text, date, text, date, boolean), public.app_data_flex(text);
-- Pode ser aplicado mais de uma vez.

-- Data como o chat guardou: DD/MM/AAAA ou AAAA-MM-DD. Nulo se não for uma data de verdade.
create or replace function public.app_data_flex(t text) returns date language plpgsql immutable set search_path to '' as $$
begin
  if t ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' then return public.app_data(substr(t, 7, 4) || '-' || substr(t, 4, 2) || '-' || substr(t, 1, 2)); end if;
  return public.app_data(t);
end $$;

-- Filho com o nome do titular? Devolve o erro (jsonb) ou nulo se pode seguir.
create or replace function public.app_filho_conflito(p_titular_nome text, p_titular_nasc date, p_nome text, p_nasc date, p_confirmado boolean) returns jsonb
language sql stable set search_path to '' as $$
  select case
    when public.app_norm(p_nome) is distinct from public.app_norm(p_titular_nome) then null
    when p_nasc = p_titular_nasc then jsonb_build_object('ok', false, 'erro', 'mesmo_cadastro', 'mensagem', 'Esse é o seu próprio cadastro: não precisa colocar você como filho(a).')
    when coalesce(p_confirmado, false) then null
    else jsonb_build_object('ok', false, 'erro', 'homonimo', 'mensagem', 'O nome é igual ao seu. Se for outra pessoa com o mesmo nome (por exemplo, um(a) filho(a)), confirme para continuar.')
  end $$;

-- Cadastro único com as regras novas de filho (mesmo assinatura de antes).
CREATE OR REPLACE FUNCTION public.app_cadastrar(p_telefone text, p_nome text, p_nascimento text, p_pin text, p_filhos jsonb DEFAULT '[]'::jsonb, p_confianca jsonb DEFAULT NULL::jsonb, p_aparelho text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_nasc date := public.app_data(p_nascimento);
  v_filhos jsonb := coalesce(p_filhos, '[]'::jsonb);
  v_f jsonb; v_fd date; v_id uuid; v_sug uuid; v_max integer; v_ctel text; v_token text;
  v_c jsonb; v_vistos text[] := '{}'; v_chave text;
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
    v_c := public.app_filho_conflito(v_nome, v_nasc, v_f ->> 'nome', v_fd, coalesce(v_f ->> 'mesmo_nome_confirmado', '') = 'true');   -- filho com o nome do titular: é ela mesma ou precisa de confirmação
    if v_c is not null then return v_c; end if;
  end loop;
  if p_confianca is not null and p_confianca <> 'null'::jsonb then
    v_ctel := regexp_replace(coalesce(p_confianca ->> 'telefone', ''), '\D', '', 'g');
    if jsonb_typeof(p_confianca) <> 'object' or length(btrim(coalesce(p_confianca ->> 'nome', ''))) < 2 or v_ctel !~ '^[1-9]{2}9[0-9]{8}$'
       or coalesce(p_confianca ->> 'relacao', '') not in ('Cônjuge', 'Pai/Mãe', 'Avó/Avô', 'Irmão(ã)', 'Outro') then
      return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Dados do número de confiança inválidos.');
    end if;
    if v_ctel = v_tel then return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Use um número diferente do seu.'); end if;
  end if;
  select case when valor ~ '^[0-9]+$' then valor::int end into v_max from public.config where chave = 'app_cadastros_max_hora';
  if (select count(*) from public.app_paciente where criado_em > now() - interval '1 hour') >= coalesce(v_max, 100) then
    return jsonb_build_object('ok', false, 'erro', 'limite', 'mensagem', 'Muitos cadastros agora. Tente de novo em alguns minutos.');
  end if;
  if exists (select 1 from public.app_paciente where telefone = v_tel) then
    return jsonb_build_object('ok', false, 'erro', 'telefone_cadastrado', 'mensagem', 'Este celular já tem cadastro. Entre com o seu PIN.');
  end if;
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
    v_chave := public.app_norm(v_f ->> 'nome') || '|' || (v_f ->> 'nascimento');
    continue when v_chave = any(v_vistos);   -- o mesmo filho digitado duas vezes vale uma vez só
    v_vistos := v_vistos || v_chave;
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
end $function$;


-- Adicionar filho depois do cadastro, com a confirmação de homônimo.
create or replace function public.app_filho_adicionar(p_token text, p_nome text, p_nascimento text, p_mesmo_nome_confirmado boolean default false) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare s record; a public.app_paciente%rowtype; v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')); v_nasc date := public.app_data(p_nascimento); v_c jsonb;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if not public.app_nome_ok(v_nome) then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Informe nome e sobrenome do filho(a).'); end if;
  if v_nasc is null or v_nasc > public.app_hoje() or v_nasc < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Data de nascimento inválida.'); end if;
  select * into a from public.app_paciente where id = s.o_pac;
  v_c := public.app_filho_conflito(a.nome, a.nascimento, v_nome, v_nasc, p_mesmo_nome_confirmado);
  if v_c is not null then return v_c; end if;
  if not exists (select 1 from public.app_filho where responsavel_id = s.o_pac and removido_em is null and nascimento = v_nasc and public.app_norm(nome) = public.app_norm(v_nome)) then
    if (select count(*) from public.app_filho where responsavel_id = s.o_pac and removido_em is null) >= 10 then
      return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Limite de 10 filhos. Fale com a clínica para cadastrar mais.');
    end if;
    insert into public.app_filho (responsavel_id, nome, nascimento) values (s.o_pac, v_nome, v_nasc);
  end if;
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $$;

-- A versão antiga (3 parâmetros) continua existindo e passa pelas mesmas regras, sem confirmação (então recusa homônimo).
create or replace function public.app_filho_salvar(p_token text, p_nome text, p_nascimento text) returns jsonb
language sql security definer set search_path to '' as $$ select public.app_filho_adicionar(p_token, p_nome, p_nascimento, false) $$;

-- Interno: filhos que aparecem nos atendimentos ligados a UMA conta (um por nome), com o nascimento e o CPF mais recentes que o histórico tem.
create or replace function public.app_conta_antiga_historico_filhos(p_conta uuid) returns table (nome text, chave text, nasc date, cpf text, atendimentos integer)
language sql stable security definer set search_path to '' as $$
  select (array_agg(x.nome order by x.criado_em desc))[1], x.chave,
         (array_agg(x.nasc order by x.criado_em desc) filter (where x.nasc is not null))[1],
         (array_agg(x.cpf order by x.criado_em desc) filter (where x.cpf is not null))[1],
         count(distinct x.conversa)::integer
  from (
    select c.id as conversa, c.criado_em, btrim(regexp_replace(c.paciente_nome, '\s+', ' ', 'g')) as nome, public.app_norm(c.paciente_nome) as chave,
           coalesce(public.app_data_flex(pa.paciente ->> 'dt_nasc'), public.app_data_flex(cf.dados -> 'digitado' ->> 'dt_nasc')) as nasc,
           (select d from (values (regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g')), (regexp_replace(coalesce(cf.dados -> 'digitado' ->> 'cpf', ''), '\D', '', 'g'))) v(d)
             where d ~ '^[0-9]{11}$' and public.fluxo_cpf_ok(d) limit 1) as cpf
    from public.conversas c
    left join public.pre_agendamentos pa on pa.conversa_id = c.id
    left join public.conversa_fluxo cf on cf.conversa_id = c.id
    where c.conta_id = p_conta and c.paciente_tipo = 'filho' and public.app_nome_ok(c.paciente_nome)
  ) x group by x.chave $$;

-- Filhos que já marcaram exame pela conta antiga, para a pessoa conferir. Só devolve dados da própria conta logada; CPF só mascarado.
create or replace function public.app_conta_antiga_filhos() returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare cp public.contas_paciente%rowtype; p public.pacientes%rowtype; v_nome text; v_nasc date;
begin
  select * into cp from public.contas_paciente where id = (select auth.uid());
  if not found or exists (select 1 from public.app_paciente where conta_antiga_id = cp.id) then return jsonb_build_object('ok', true, 'filhos', '[]'::jsonb); end if;
  if cp.paciente_id is not null then select * into p from public.pacientes where id = cp.paciente_id; end if;
  v_nome := case when public.app_nome_ok(cp.nome) then btrim(cp.nome) when public.app_nome_ok(p.nome) then btrim(p.nome) end;
  v_nasc := case when p.dt_nasc between date '1900-01-01' and public.app_hoje() then p.dt_nasc end;
  return jsonb_build_object('ok', true, 'filhos', coalesce((select jsonb_agg(jsonb_build_object(
      'nome', h.nome, 'nascimento', h.nasc, 'cpf_mascara', public.app_cpf_mascara(h.cpf), 'atendimentos', h.atendimentos,
      'mesmo_nome', v_nome is not null and h.chave = public.app_norm(v_nome),
      'mesmo_cadastro', v_nome is not null and h.chave = public.app_norm(v_nome) and h.nasc is not null and h.nasc = v_nasc) order by h.nome)
    from public.app_conta_antiga_historico_filhos(cp.id) h), '[]'::jsonb));
end $$;

-- Cria o acesso rápido a partir da conta antiga, já com os filhos que a pessoa confirmou. p_filhos = [{nome, nascimento, mesmo_nome_confirmado?}].
create or replace function public.app_conta_antiga_migrar(p_pin text, p_telefone text default null, p_nome text default null, p_nascimento text default null, p_filhos jsonb default null, p_aparelho text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  cp public.contas_paciente%rowtype; p public.pacientes%rowtype; v_tel text; v_nome text; v_nasc date; v_cpf text; v_email text; v_id uuid; v_max integer; v_token text;
  v_filhos jsonb := coalesce(p_filhos, '[]'::jsonb); v_f jsonb; v_fn text; v_fd date; v_c jsonb; v_chave text; v_vistos text[] := '{}'; v_fcpf text;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  select * into cp from public.contas_paciente where id = (select auth.uid()) for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'sem_conta', 'mensagem', 'Entre com o e-mail e a senha da sua conta antiga.'); end if;
  if exists (select 1 from public.app_paciente where conta_antiga_id = cp.id) then
    return jsonb_build_object('ok', false, 'erro', 'ja_migrada', 'mensagem', 'Você já criou o seu PIN. Entre com o celular e o PIN.');
  end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'O PIN precisa ter 4 números.'); end if;
  if cp.paciente_id is not null then select * into p from public.pacientes where id = cp.paciente_id; end if;

  v_tel := coalesce(public.app_tel_br(p_telefone), public.app_tel_br(cp.telefone), (select public.app_tel_br(x) from unnest(coalesce(p.telefones, '{}'::text[])) x where public.app_tel_br(x) is not null limit 1));
  v_nome := coalesce(nullif(btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')), ''), nullif(btrim(cp.nome), ''), nullif(btrim(p.nome), ''));
  v_nasc := coalesce(public.app_data(p_nascimento), case when p.dt_nasc between date '1900-01-01' and public.app_hoje() then p.dt_nasc end);
  if v_tel is null then return jsonb_build_object('ok', false, 'erro', 'celular', 'mensagem', 'Informe o seu celular com DDD + 9 dígitos.'); end if;
  if not public.app_nome_ok(v_nome) then return jsonb_build_object('ok', false, 'erro', 'nome', 'mensagem', 'Digite nome e sobrenome completos.'); end if;
  if v_nasc is null or v_nasc > public.app_hoje() or v_nasc < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'nascimento', 'mensagem', 'Informe a data de nascimento.'); end if;
  if public.app_idade(v_nasc) < 18 then return jsonb_build_object('ok', false, 'erro', 'menor', 'mensagem', 'O cadastro principal precisa ser de um maior de 18 anos.'); end if;

  -- filhos: tudo conferido ANTES de gravar qualquer coisa
  if jsonb_typeof(v_filhos) <> 'array' or jsonb_array_length(v_filhos) > 10 then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Lista de filhos inválida (no máximo 10).'); end if;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_fn := btrim(regexp_replace(coalesce(v_f ->> 'nome', ''), '\s+', ' ', 'g')); v_fd := public.app_data(v_f ->> 'nascimento');
    if jsonb_typeof(v_f) <> 'object' or not public.app_nome_ok(v_fn) then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Informe nome e sobrenome do filho(a).'); end if;
    if v_fd is null or v_fd > public.app_hoje() or v_fd < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Informe a data de nascimento de ' || split_part(v_fn, ' ', 1) || '.'); end if;
    v_c := public.app_filho_conflito(v_nome, v_nasc, v_fn, v_fd, coalesce(v_f ->> 'mesmo_nome_confirmado', '') = 'true');
    if v_c is not null then return v_c; end if;
  end loop;

  select case when valor ~ '^[0-9]+$' then valor::int end into v_max from public.config where chave = 'app_cadastros_max_hora';
  if (select count(*) from public.app_paciente where criado_em > now() - interval '1 hour') >= coalesce(v_max, 100) then
    return jsonb_build_object('ok', false, 'erro', 'limite', 'mensagem', 'Muitos cadastros agora. Tente de novo em alguns minutos.');
  end if;
  if exists (select 1 from public.app_paciente where telefone = v_tel) then
    return jsonb_build_object('ok', false, 'erro', 'telefone_cadastrado', 'mensagem', 'Este celular já tem acesso rápido. Entre com o celular e o PIN, ou use outro celular.');
  end if;

  v_cpf := case when regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g') ~ '^[0-9]{11}$' and public.fluxo_cpf_ok(regexp_replace(p.cpf, '\D', '', 'g')) then regexp_replace(p.cpf, '\D', '', 'g') end;
  v_email := case when lower(btrim(coalesce(cp.email, ''))) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then lower(btrim(cp.email)) end;
  begin
    insert into public.app_paciente (telefone, nome, nascimento, pin_hash, paciente_sugerido_id, cpf, email, conta_antiga_id)
    values (v_tel, v_nome, v_nasc, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)), cp.paciente_id, v_cpf, v_email, cp.id) returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'erro', 'telefone_cadastrado', 'mensagem', 'Este celular já tem acesso rápido. Entre com o celular e o PIN, ou use outro celular.');
  end;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_fn := btrim(regexp_replace(v_f ->> 'nome', '\s+', ' ', 'g')); v_fd := public.app_data(v_f ->> 'nascimento');
    v_chave := public.app_norm(v_fn) || '|' || v_fd::text;
    continue when v_chave = any(v_vistos);
    v_vistos := v_vistos || v_chave;
    -- CPF só do histórico da PRÓPRIA conta, e só se o nome bate e o nascimento não contradiz
    select h.cpf into v_fcpf from public.app_conta_antiga_historico_filhos(cp.id) h where h.chave = public.app_norm(v_fn) and (h.nasc is null or h.nasc = v_fd) and h.cpf is not null limit 1;
    insert into public.app_filho (responsavel_id, nome, nascimento, cpf, criado_em) values (v_id, v_fn, v_fd, v_fcpf, clock_timestamp());
  end loop;
  v_token := public.app_aparelho_abrir(v_id, p_aparelho);
  perform public.app_evento_gravar(v_id, 'conta_antiga_herdada');
  return jsonb_build_object('ok', true, 'token', v_token, 'perfil', public.app_perfil_json(v_id));
end $$;

-- A função anterior (sem filhos) passa a usar a nova.
create or replace function public.app_conta_antiga_herdar(p_pin text, p_telefone text default null, p_nome text default null, p_nascimento text default null, p_aparelho text default null) returns jsonb
language sql security definer set search_path to '' as $$ select public.app_conta_antiga_migrar(p_pin, p_telefone, p_nome, p_nascimento, null, p_aparelho) $$;

revoke all on function public.app_data_flex(text), public.app_filho_conflito(text, date, text, date, boolean), public.app_filho_adicionar(text, text, text, boolean), public.app_filho_salvar(text, text, text),
  public.app_conta_antiga_historico_filhos(uuid), public.app_conta_antiga_filhos(), public.app_conta_antiga_migrar(text, text, text, text, jsonb, text), public.app_conta_antiga_herdar(text, text, text, text, text),
  public.app_cadastrar(text, text, text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.app_filho_adicionar(text, text, text, boolean), public.app_filho_salvar(text, text, text), public.app_cadastrar(text, text, text, text, jsonb, jsonb, text) to anon, authenticated;
grant execute on function public.app_conta_antiga_filhos(), public.app_conta_antiga_migrar(text, text, text, text, jsonb, text), public.app_conta_antiga_herdar(text, text, text, text, text) to authenticated;
