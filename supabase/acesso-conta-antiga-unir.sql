-- FLUXOGRAMA: entrada (pessoa que tem conta antiga de e-mail e senha E acesso rápido de celular e PIN, ainda separados; ou que cria o PIN agora pela conta antiga)
--   -> validação (DUAS provas: sessão da conta antiga (auth.uid(), a senha) + código do aparelho com o PIN já digitado (app_aparelho_validar); conta ainda sem ligação; acesso ainda sem ligação;
--                 é a mesma pessoa: o celular do acesso rápido é um dos celulares da conta ou do cadastro da clínica, OU o e-mail é o mesmo)
--   -> lógica (liga: app_paciente.conta_antiga_id = conta; completa o que falta no acesso (e-mail, CPF válido do cadastro da clínica, cadastro da clínica sugerido) sem sobrescrever nada;
--              traz para o acesso as conversas feitas pela conta (conversas.conta_id) sem contá-las como novidade; a conta antiga NÃO é apagada)
--   -> saída (JSON ok com quantas conversas entraram; erros em palavras simples; a conta ligada sai da lista "Contas antigas sem PIN" do painel)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (defeito: quem tinha PIN criado pelo celular e depois entrava pela conta antiga era mandado só digitar o PIN e as duas ficavam separadas, com o histórico fora do "Acompanhe seus pedidos"; app_conta_antiga_migrar não trazia as conversas da conta)
--
-- DEPENDE DE: acesso-rapido-paciente.sql, acesso-rapido-conta-antiga.sql, acompanhar-pedidos.sql (app_conversa, app_pedido_dados). A seção 3 recria app_conta_antiga_migrar (texto da produção + UMA linha).
--
-- O QUE NÃO FAZ DE PROPÓSITO: não junta sozinha por e-mail/celular iguais (celular e e-mail do acesso rápido não são confirmados: qualquer pessoa poderia declarar os de outra e ler o histórico dela);
--   não traz filhos (precisam de conferência da pessoa, no mesmo passo da migração normal); não apaga nem bloqueia a conta antiga (decisão do dono: login_paciente).
-- ROLLBACK: drop function if exists public.app_conta_antiga_unir(text); drop function if exists public.app_conta_antiga_importar(uuid, uuid);
--   e recriar app_conta_antiga_migrar sem a linha "perform public.app_conta_antiga_importar" (texto anterior: git, supabase/producao/funcoes/app_conta_antiga_migrar.sql antes desta mudança).
-- COMO APLICAR (limite de 60 s do conector): em TRÊS partes, na ordem das seções (1; 2; 3). Pode ser aplicado mais de uma vez.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 1. Traz as conversas feitas pela conta antiga para o acesso rápido (não conta como novidade; função interna)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.app_conta_antiga_importar(p_conta uuid, p_pac uuid) returns integer
language plpgsql security definer set search_path to ''
as $f$
declare n integer := 0;
begin
  insert into public.app_conversa (paciente_id, conversa_id, pessoa_nome, eu)
  select p_pac, c.id,
         case when coalesce(c.paciente_tipo, 'proprio') = 'proprio' then a.nome else coalesce(nullif(btrim(c.paciente_nome), ''), 'Filho(a)') end,
         coalesce(c.paciente_tipo, 'proprio') = 'proprio'
    from public.conversas c cross join public.app_paciente a
   where c.conta_id = p_conta and a.id = p_pac
  on conflict (paciente_id, conversa_id) do nothing;
  get diagnostics n = row_count;
  update public.app_conversa ac set visto_em = now(),
         visto_sig = coalesce((select e ->> 'sig' from jsonb_array_elements(public.app_pedido_dados(ac.paciente_id, ac.conversa_id)) e limit 1), md5(''))
   where ac.paciente_id = p_pac and ac.visto_sig is null;
  return n;
end $f$;
revoke all on function public.app_conta_antiga_importar(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 2. Liga a conta antiga ao acesso rápido que já existe (precisa da senha E do PIN)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.app_conta_antiga_unir(p_token text) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare
  cp public.contas_paciente%rowtype; p public.pacientes%rowtype; a public.app_paciente%rowtype; s record;
  v_mesma boolean; v_cpf text; v_email text; n integer;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  select * into cp from public.contas_paciente where id = (select auth.uid()) for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'sem_conta', 'mensagem', 'Entre com o e-mail e a senha da sua conta antiga.'); end if;
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select * into a from public.app_paciente where id = s.o_pac for update;
  if not found then return public.app_erro_json('sessao'); end if;
  if a.conta_antiga_id = cp.id then
    return jsonb_build_object('ok', true, 'ja_unida', true, 'conversas', public.app_conta_antiga_importar(cp.id, a.id));
  end if;
  if a.conta_antiga_id is not null or exists (select 1 from public.app_paciente x where x.conta_antiga_id = cp.id) then
    return jsonb_build_object('ok', false, 'erro', 'ja_ligada', 'mensagem', 'Esta conta já está ligada a outro acesso rápido. Fale com a recepção.');
  end if;
  if cp.paciente_id is not null then select * into p from public.pacientes where id = cp.paciente_id; end if;
  v_mesma := (nullif(lower(btrim(coalesce(a.email, ''))), '') is not null and lower(btrim(coalesce(a.email, ''))) = lower(btrim(coalesce(cp.email, ''))))
          or exists (select 1 from unnest(array[cp.telefone] || coalesce(p.telefones, '{}'::text[])) x
                      where x is not null and public.fone_chave(x) is not null and public.fone_chave(x) = public.fone_chave(a.telefone));
  if not v_mesma then
    return jsonb_build_object('ok', false, 'erro', 'outra_pessoa', 'mensagem', 'O celular do seu PIN não é o desta conta antiga. Fale com a recepção para juntar os dois.');
  end if;
  v_cpf := case when a.cpf is null and regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g') ~ '^[0-9]{11}$' and public.fluxo_cpf_ok(regexp_replace(p.cpf, '\D', '', 'g')) then regexp_replace(p.cpf, '\D', '', 'g') end;
  v_email := case when a.email is null and lower(btrim(coalesce(cp.email, ''))) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then lower(btrim(cp.email)) end;
  update public.app_paciente set conta_antiga_id = cp.id, cpf = coalesce(cpf, v_cpf), email = coalesce(email, v_email),
         paciente_sugerido_id = coalesce(paciente_sugerido_id, cp.paciente_id), atualizado_em = now()
   where id = a.id;
  n := public.app_conta_antiga_importar(cp.id, a.id);
  perform public.app_evento_gravar(a.id, 'conta_antiga_unida');
  return jsonb_build_object('ok', true, 'ja_unida', false, 'conversas', n);
end $f$;
revoke all on function public.app_conta_antiga_unir(text) from public, anon;
grant execute on function public.app_conta_antiga_unir(text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3. A migração normal (conta antiga cria o PIN) também traz as conversas da conta. Texto da produção + UMA linha (marcada abaixo).
-- ---------------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_conta_antiga_migrar(p_pin text, p_telefone text DEFAULT NULL::text, p_nome text DEFAULT NULL::text, p_nascimento text DEFAULT NULL::text, p_filhos jsonb DEFAULT NULL::jsonb, p_aparelho text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if public.app_pin_fraco(p_pin) then return jsonb_build_object('ok', false, 'erro', 'pin_fraco', 'mensagem', 'Escolha um PIN menos óbvio: não use números repetidos (1111), em sequência (1234) nem pares repetidos (1212).'); end if;
  if cp.paciente_id is not null then select * into p from public.pacientes where id = cp.paciente_id; end if;

  v_tel := coalesce(public.app_tel_br(p_telefone), public.app_tel_br(cp.telefone), (select public.app_tel_br(x) from unnest(coalesce(p.telefones, '{}'::text[])) x where public.app_tel_br(x) is not null limit 1));
  v_nome := coalesce(nullif(btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')), ''), nullif(btrim(cp.nome), ''), nullif(btrim(p.nome), ''));
  v_nasc := coalesce(public.app_data(p_nascimento), case when p.dt_nasc between date '1900-01-01' and public.app_hoje() then p.dt_nasc end);
  if v_tel is null then return jsonb_build_object('ok', false, 'erro', 'celular', 'mensagem', 'Informe o seu celular com DDD + 9 dígitos.'); end if;
  if not public.app_nome_ok(v_nome) then return jsonb_build_object('ok', false, 'erro', 'nome', 'mensagem', 'Digite nome e sobrenome completos.'); end if;
  if v_nasc is null or v_nasc > public.app_hoje() or v_nasc < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'nascimento', 'mensagem', 'Informe a data de nascimento.'); end if;
  if public.app_idade(v_nasc) < 18 then return jsonb_build_object('ok', false, 'erro', 'menor', 'mensagem', 'O cadastro principal precisa ser de um maior de 18 anos.'); end if;

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
    select h.cpf into v_fcpf from public.app_conta_antiga_historico_filhos(cp.id) h where h.chave = public.app_norm(v_fn) and (h.nasc is null or h.nasc = v_fd) and h.cpf is not null limit 1;
    insert into public.app_filho (responsavel_id, nome, nascimento, cpf, criado_em) values (v_id, v_fn, v_fd, v_fcpf, clock_timestamp());
  end loop;
  perform public.app_conta_antiga_importar(cp.id, v_id);   -- NOVO (única linha a mais): as conversas da conta antiga passam a aparecer em "Acompanhe seus pedidos"
  v_token := public.app_aparelho_abrir(v_id, p_aparelho);
  perform public.app_evento_gravar(v_id, 'conta_antiga_herdada');
  return jsonb_build_object('ok', true, 'token', v_token, 'perfil', public.app_perfil_json(v_id));
end $function$;
