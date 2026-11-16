-- FLUXOGRAMA: entrada (a página /acesso/ pede o código por app_codigo_pedir e o confere por app_codigo_validar; a equipe vê e descarta pelo botão Pendências > Códigos do painel: painel_app_codigos, painel_app_codigo_descartar) -> validação (só vale com config.app_codigo_email = 'sim'; celular em formato válido; cadastro só de celular NOVO; "esqueci o PIN" só se nome e nascimento conferem; no máximo 3 pedidos por celular por hora e 5 erros por código; o código vence em app_codigo_validade_min minutos) -> lógica (o BANCO sorteia o código de 6 números e guarda; o e-mail sai por uma Edge Function (app-codigo-enviar) chamada pelo banco; se o e-mail falhar, não houver e-mail ou cair no spam, a atendente vê o código no painel, confirma que é a pessoa e passa o número; app_cadastrar e app_pin_esqueci passam a RECUSAR sem um código aceito) -> saída (JSON com ok/erro/mensagem; o e-mail do cadastro só passa a valer depois de confirmado)
-- Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial. Confirmação por e-mail para celular novo (primeiro acesso) e para "esqueci o PIN"; o código aparece no painel até ser usado, descartado ou vencer.
--
-- POR QUE: o celular não é confirmado (decisão do dono: nada de SMS). Sem isso, qualquer pessoa que soubesse celular + nome + nascimento de outra podia criar PIN no lugar dela ("esqueci o PIN") ou
-- se cadastrar com o celular alheio. O código por e-mail prova que a pessoa tem o e-mail do cadastro; quando não há e-mail (ou o envio falha), a atendente confirma a pessoa e passa o código.
--
-- NASCE DESLIGADO: config.app_codigo_email = 'nao' (tudo continua como antes). Ligar SÓ depois de a página nova estar publicada (a página antiga não sabe digitar o código):
--     update public.config set valor = 'sim' where chave = 'app_codigo_email';       -- desligar na hora: valor = 'nao'
--
-- ROLLBACK (comandos com "drop" pedem confirmação do dono no painel; antes, voltar as duas funções à versão do retrato: git show HEAD~:supabase/producao/funcoes/app_cadastrar.sql e app_pin_esqueci.sql):
--   update public.config set valor = 'nao' where chave = 'app_codigo_email';   -- basta para voltar ao comportamento antigo
--   drop function if exists public.app_codigo_pedir(text, text, text, text, text), public.app_codigo_validar(text, text, text), public.app_codigo_exigido(),
--     public.app_codigo_disparar(uuid), public.app_codigo_para_enviar(uuid), public.app_codigo_envio_marcar(uuid, boolean, text), public.painel_app_codigos(), public.painel_app_codigo_descartar(uuid);
--   drop table if exists public.app_codigo_email;   delete from public.config where chave in ('app_codigo_email', 'app_codigo_validade_min');
-- Pode ser aplicado mais de uma vez.

insert into public.config (chave, valor) values ('app_codigo_email', 'nao'), ('app_codigo_validade_min', '60') on conflict (chave) do nothing;

create table if not exists public.app_codigo_email (
  id uuid primary key default gen_random_uuid(),
  finalidade text not null check (finalidade in ('cadastro', 'esqueci_pin')),
  telefone text not null,
  nome text,
  email text,
  codigo text not null check (codigo ~ '^[0-9]{6}$'),
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null,
  validado_em timestamptz,
  usado_em timestamptz,
  descartado_em timestamptz,
  tentativas integer not null default 0,
  envio text not null default 'pendente' check (envio in ('pendente', 'enviado', 'erro', 'sem_email')),
  envio_erro text);
comment on table public.app_codigo_email is 'Código de 6 números para confirmar o e-mail no primeiro acesso e no "esqueci o PIN". Guardado de forma legível DE PROPÓSITO: a atendente o vê no painel e o passa à pessoa depois de confirmar quem é. Vale poucos minutos e some do painel quando usado, descartado ou vencido.';
create index if not exists app_codigo_email_tel on public.app_codigo_email (telefone, finalidade, criado_em desc);
alter table public.app_codigo_email enable row level security;
revoke all on table public.app_codigo_email from public, anon, authenticated;

create or replace function public.app_codigo_exigido() returns boolean language sql stable security definer set search_path to '' as $$
  select public.app_modo() and coalesce((select valor from public.config where chave = 'app_codigo_email'), 'nao') = 'sim' $$;

-- Chama a Edge Function que manda o e-mail (mesmo modo das outras: pg_net + segredo do cofre). Se faltar a configuração, o envio fica "pendente" e o painel mostra "e-mail não saiu".
create or replace function public.app_codigo_disparar(p_id uuid) returns void language plpgsql security definer set search_path to '' as $$
declare v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo();
begin
  if v_base = '' or v_seg is null then return; end if;
  perform net.http_post(url := v_base || 'app-codigo-enviar', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('id', p_id), timeout_milliseconds := 20000);
exception when others then null;
end $$;

create or replace function public.app_codigo_pedir(p_telefone text, p_finalidade text, p_email text default null, p_nome text default null, p_nascimento text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); v_email text := lower(btrim(coalesce(p_email, ''))); v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  a public.app_paciente%rowtype; v_seg integer; v_min integer; v_id uuid; v_cod text; v_mask text; v_r jsonb;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if not public.app_codigo_exigido() then return jsonb_build_object('ok', true, 'exigido', false); end if;
  if p_finalidade not in ('cadastro', 'esqueci_pin') then return jsonb_build_object('ok', false, 'erro', 'finalidade', 'mensagem', 'Não foi possível concluir.'); end if;
  if v_tel !~ '^[1-9]{2}9[0-9]{8}$' then return jsonb_build_object('ok', false, 'erro', 'celular', 'mensagem', 'Celular inválido. Use DDD + 9 dígitos.'); end if;
  if p_finalidade = 'cadastro' then
    if exists (select 1 from public.app_paciente where telefone = v_tel) then return jsonb_build_object('ok', false, 'erro', 'telefone_cadastrado', 'mensagem', 'Este celular já tem cadastro. Entre com o seu PIN.'); end if;
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 200 then return jsonb_build_object('ok', false, 'erro', 'email', 'mensagem', 'Digite um e-mail válido para receber o código.'); end if;
  else
    select * into a from public.app_paciente where telefone = v_tel for update;
    if not found then return jsonb_build_object('ok', false, 'erro', 'dados', 'mensagem', 'Os dados não conferem com o cadastro.'); end if;
    v_seg := public.app_trava(a.id);
    if v_seg > 0 then return public.app_bloqueado_json(v_seg); end if;
    if not (public.app_norm(p_nome) = public.app_norm(a.nome) and public.app_data(p_nascimento) = a.nascimento) then
      v_r := public.app_falha(a.id);   -- conta nas mesmas tentativas do PIN (e bloqueia igual)
      if v_r ->> 'erro' = 'bloqueado' then return v_r; end if;
      return jsonb_build_object('ok', false, 'erro', 'dados', 'restantes', v_r -> 'restantes', 'mensagem', 'Os dados não conferem com o cadastro.');
    end if;
    v_email := lower(btrim(coalesce(a.email, ''))); v_nome := a.nome;
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then v_email := ''; end if;
  end if;
  if (select count(*) from public.app_codigo_email where telefone = v_tel and finalidade = p_finalidade and criado_em > now() - interval '1 hour') >= 3 then
    return jsonb_build_object('ok', false, 'erro', 'muitos', 'mensagem', 'Você já pediu vários códigos. Espere um pouco ou fale com a clínica.');
  end if;
  if (select count(*) from public.app_codigo_email where criado_em > now() - interval '1 hour') >= 200 then
    return jsonb_build_object('ok', false, 'erro', 'limite', 'mensagem', 'Muitos pedidos agora. Tente de novo em alguns minutos.');
  end if;
  select case when valor ~ '^[0-9]+$' then valor::int end into v_min from public.config where chave = 'app_codigo_validade_min';
  v_min := least(greatest(coalesce(v_min, 60), 5), 720);
  -- depois de 3 dias o registro perde nome, e-mail, celular e código (sem "delete": o conector do Supabase pede confirmação do dono em comandos que apagam)
  update public.app_codigo_email set nome = null, email = null, telefone = '00000000000', codigo = '000000', descartado_em = coalesce(descartado_em, now()) where criado_em < now() - interval '3 days' and telefone <> '00000000000';
  update public.app_codigo_email set descartado_em = now() where telefone = v_tel and finalidade = p_finalidade and usado_em is null and descartado_em is null;
  v_cod := lpad((('x' || substr(md5(gen_random_uuid()::text), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0');
  insert into public.app_codigo_email (finalidade, telefone, nome, email, codigo, expira_em, envio)
  values (p_finalidade, v_tel, nullif(v_nome, ''), nullif(v_email, ''), v_cod, now() + make_interval(mins => v_min), case when v_email = '' then 'sem_email' else 'pendente' end) returning id into v_id;
  if v_email <> '' then
    perform public.app_codigo_disparar(v_id);
    v_mask := left(split_part(v_email, '@', 1), 1) || '***@' || split_part(v_email, '@', 2);
  end if;
  return jsonb_build_object('ok', true, 'exigido', true, 'enviado', v_email <> '', 'email_mascara', v_mask, 'validade_min', v_min);
end $$;

create or replace function public.app_codigo_validar(p_telefone text, p_finalidade text, p_codigo text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); c public.app_codigo_email%rowtype; v_rest integer;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if not public.app_codigo_exigido() then return jsonb_build_object('ok', true, 'exigido', false); end if;
  if coalesce(p_codigo, '') !~ '^[0-9]{6}$' then return jsonb_build_object('ok', false, 'erro', 'codigo', 'mensagem', 'O código tem 6 números.'); end if;
  select * into c from public.app_codigo_email where telefone = v_tel and finalidade = p_finalidade and usado_em is null and descartado_em is null and expira_em > now() and tentativas < 5
   order by criado_em desc limit 1 for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'codigo_vencido', 'mensagem', 'Esse código venceu ou foi cancelado. Peça um novo.'); end if;
  if c.codigo = p_codigo then
    update public.app_codigo_email set validado_em = coalesce(validado_em, now()), expira_em = greatest(expira_em, now() + interval '30 minutes') where id = c.id;
    return jsonb_build_object('ok', true, 'exigido', true);
  end if;
  update public.app_codigo_email set tentativas = tentativas + 1, descartado_em = case when tentativas + 1 >= 5 then now() end where id = c.id returning 5 - tentativas into v_rest;
  if v_rest <= 0 then return jsonb_build_object('ok', false, 'erro', 'codigo_bloqueado', 'mensagem', 'Muitos erros. Peça um código novo.'); end if;
  return jsonb_build_object('ok', false, 'erro', 'codigo', 'restantes', v_rest, 'mensagem', case when v_rest = 1 then 'Código incorreto. Resta 1 tentativa.' else 'Código incorreto. Restam ' || v_rest || ' tentativas.' end);
end $$;

-- Usadas só pela Edge Function (service_role): entrega o necessário para montar o e-mail e anota o resultado do envio.
create or replace function public.app_codigo_para_enviar(p_id uuid) returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('email', c.email, 'codigo', c.codigo, 'nome', c.nome, 'finalidade', c.finalidade, 'validade_min', greatest(1, ceil(extract(epoch from (c.expira_em - now())) / 60)::int))
    from public.app_codigo_email c where c.id = p_id and c.envio = 'pendente' and c.email is not null and c.usado_em is null and c.descartado_em is null and c.expira_em > now() $$;

create or replace function public.app_codigo_envio_marcar(p_id uuid, p_ok boolean, p_erro text default null) returns void language sql security definer set search_path to '' as $$
  update public.app_codigo_email set envio = case when p_ok then 'enviado' else 'erro' end, envio_erro = case when p_ok then null else left(coalesce(p_erro, 'falha'), 120) end where id = p_id $$;

-- Equipe: lista dos códigos que ainda valem (não usados, não descartados, não vencidos). "envio": enviado | erro (inclui "não saiu em 2 minutos") | sem_email | pendente.
create or replace function public.painel_app_codigos() returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê os códigos.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'finalidade', c.finalidade, 'celular', c.telefone, 'nome', c.nome, 'email', c.email, 'codigo', c.codigo, 'criado_em', c.criado_em, 'expira_em', c.expira_em,
      'digitado', c.validado_em is not null, 'tentativas', c.tentativas, 'envio_erro', c.envio_erro,
      'envio', case when c.envio = 'pendente' and c.criado_em < now() - interval '2 minutes' then 'erro' else c.envio end) order by c.criado_em desc)
    from public.app_codigo_email c where c.usado_em is null and c.descartado_em is null and c.expira_em > now()), '[]'::jsonb);
end $$;

create or replace function public.painel_app_codigo_descartar(p_id uuid) returns integer language plpgsql security definer set search_path to '' as $$
declare n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe descarta códigos.' using errcode = '42501'; end if;
  update public.app_codigo_email set descartado_em = now() where id = p_id and usado_em is null and descartado_em is null;
  get diagnostics n = row_count; return n;
end $$;

-- Contador do botão Pendências: acrescenta "codigos" (códigos ainda não digitados pela pessoa).
create or replace function public.painel_app_pendencias_resumo() returns jsonb language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê as pendências.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'solicitacoes', (select count(distinct m.grupo) from public.app_marcacao m where m.status = 'solicitada'),
    'revisoes', (select count(*) from public.app_paciente a
                  where a.revisar_motivo is not null
                     or (a.paciente_sugerido_id is null and a.revisao_resolvida_em is null and exists (select 1 from public.pacientes p where p.telefones && array[a.telefone, '55' || a.telefone]))),
    'contas_antigas', (select count(*) from public.contas_paciente c where not exists (select 1 from public.app_paciente a where a.conta_antiga_id = c.id)),
    'sem_cpf', (select count(*) from public.app_paciente a where a.cpf is null),
    'acesso_rapido', (select count(*) from public.app_paciente),
    'codigos', (select count(*) from public.app_codigo_email c where c.usado_em is null and c.descartado_em is null and c.expira_em > now() and c.validado_em is null));
end $$;

-- As duas funções que criam acesso passam a exigir o código aceito (só com app_codigo_email = 'sim'). Mesmos parâmetros e permissões de antes.
create or replace function public.app_cadastrar(p_telefone text, p_nome text, p_nascimento text, p_pin text, p_filhos jsonb DEFAULT '[]'::jsonb, p_confianca jsonb DEFAULT NULL::jsonb, p_aparelho text DEFAULT NULL::text)
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
  v_c jsonb; v_vistos text[] := '{}'; v_chave text; v_cod public.app_codigo_email%rowtype;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if v_tel !~ '^[1-9]{2}9[0-9]{8}$' then return jsonb_build_object('ok', false, 'erro', 'celular', 'mensagem', 'Celular inválido. Use DDD + 9 dígitos.'); end if;
  if not public.app_nome_ok(v_nome) then return jsonb_build_object('ok', false, 'erro', 'nome', 'mensagem', 'Digite nome e sobrenome completos.'); end if;
  if v_nasc is null or v_nasc > public.app_hoje() or v_nasc < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'nascimento', 'mensagem', 'Data de nascimento inválida.'); end if;
  if public.app_idade(v_nasc) < 18 then return jsonb_build_object('ok', false, 'erro', 'menor', 'mensagem', 'O cadastro principal precisa ser de um maior de 18 anos.'); end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'O PIN precisa ter 4 números.'); end if;
  if public.app_pin_fraco(p_pin) then return jsonb_build_object('ok', false, 'erro', 'pin_fraco', 'mensagem', 'Escolha um PIN menos óbvio: não use números repetidos (1111), em sequência (1234) nem pares repetidos (1212).'); end if;
  if jsonb_typeof(v_filhos) <> 'array' or jsonb_array_length(v_filhos) > 10 then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Lista de filhos inválida (no máximo 10).'); end if;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_fd := public.app_data(v_f ->> 'nascimento');
    if jsonb_typeof(v_f) <> 'object' or not public.app_nome_ok(v_f ->> 'nome') then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Informe nome e sobrenome do filho(a).'); end if;
    if v_fd is null or v_fd > public.app_hoje() or v_fd < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Data de nascimento do filho(a) inválida.'); end if;
    v_c := public.app_filho_conflito(v_nome, v_nasc, v_f ->> 'nome', v_fd, coalesce(v_f ->> 'mesmo_nome_confirmado', '') = 'true');
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
  if public.app_codigo_exigido() then   -- confirmação do e-mail (supabase/acesso-codigo-email.sql): sem código digitado e aceito, não nasce cadastro
    select * into v_cod from public.app_codigo_email where telefone = v_tel and finalidade = 'cadastro' and validado_em > now() - interval '30 minutes' and usado_em is null and descartado_em is null order by validado_em desc limit 1 for update;
    if not found then return jsonb_build_object('ok', false, 'erro', 'codigo_email', 'mensagem', 'Confirme o seu e-mail com o código antes de criar o PIN.'); end if;
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
  if v_cod.id is not null then
    update public.app_codigo_email set usado_em = now() where id = v_cod.id;
    update public.app_paciente set email = v_cod.email where id = v_id;
  end if;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_chave := public.app_norm(v_f ->> 'nome') || '|' || (v_f ->> 'nascimento');
    continue when v_chave = any(v_vistos);
    v_vistos := v_vistos || v_chave;
    insert into public.app_filho (responsavel_id, nome, nascimento, criado_em)
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

create or replace function public.app_pin_esqueci(p_telefone text, p_nome text, p_nascimento text, p_pin_novo text, p_aparelho text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); a public.app_paciente%rowtype; v_seg integer; r jsonb; v_token text; v_cod public.app_codigo_email%rowtype;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if coalesce(p_pin_novo, '') !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'O PIN precisa ter 4 números.'); end if;
  if public.app_pin_fraco(p_pin_novo) then return jsonb_build_object('ok', false, 'erro', 'pin_fraco', 'mensagem', 'Escolha um PIN menos óbvio: não use números repetidos (1111), em sequência (1234) nem pares repetidos (1212).'); end if;
  if public.app_codigo_exigido() then   -- o código do e-mail (ou o que a atendente passou) precisa ter sido digitado e aceito
    select * into v_cod from public.app_codigo_email where telefone = v_tel and finalidade = 'esqueci_pin' and validado_em > now() - interval '30 minutes' and usado_em is null and descartado_em is null order by validado_em desc limit 1 for update;
    if not found then return jsonb_build_object('ok', false, 'erro', 'codigo_email', 'mensagem', 'Confirme o código enviado ao seu e-mail antes de criar um novo PIN.'); end if;
  end if;
  select * into a from public.app_paciente where telefone = v_tel for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'dados', 'mensagem', 'Os dados não conferem com o cadastro.'); end if;
  v_seg := public.app_trava(a.id);
  if v_seg > 0 then return public.app_bloqueado_json(v_seg); end if;
  if public.app_norm(p_nome) = public.app_norm(a.nome) and public.app_data(p_nascimento) = a.nascimento then
    update public.app_paciente set pin_hash = extensions.crypt(p_pin_novo, extensions.gen_salt('bf', 8)), atualizado_em = now() where id = a.id;
    perform public.app_acerto(a.id);
    if v_cod.id is not null then update public.app_codigo_email set usado_em = now() where id = v_cod.id; end if;
    delete from public.app_aparelho where paciente_id = a.id;
    v_token := public.app_aparelho_abrir(a.id, p_aparelho);
    perform public.app_evento_gravar(a.id, 'pin_redefinido');
    return jsonb_build_object('ok', true, 'token', v_token, 'perfil', public.app_perfil_json(a.id));
  end if;
  r := public.app_falha(a.id);
  if r ->> 'erro' = 'bloqueado' then return r; end if;
  return jsonb_build_object('ok', false, 'erro', 'dados', 'restantes', r -> 'restantes', 'mensagem', 'Os dados não conferem com o cadastro.');
end $function$;

revoke all on function public.app_codigo_exigido(), public.app_codigo_disparar(uuid), public.app_codigo_para_enviar(uuid), public.app_codigo_envio_marcar(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.app_codigo_exigido(), public.app_codigo_disparar(uuid), public.app_codigo_para_enviar(uuid), public.app_codigo_envio_marcar(uuid, boolean, text) to service_role;
revoke all on function public.app_codigo_pedir(text, text, text, text, text), public.app_codigo_validar(text, text, text) from public;
grant execute on function public.app_codigo_pedir(text, text, text, text, text), public.app_codigo_validar(text, text, text) to anon, authenticated, service_role;
revoke all on function public.painel_app_codigos(), public.painel_app_codigo_descartar(uuid), public.painel_app_pendencias_resumo() from public, anon, authenticated;
grant execute on function public.painel_app_codigos(), public.painel_app_codigo_descartar(uuid), public.painel_app_pendencias_resumo() to authenticated;
