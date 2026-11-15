-- FLUXOGRAMA: entrada (quem tem conta antiga de e-mail e senha entra uma última vez, e a página chama app_conta_antiga_resumo e app_conta_antiga_herdar com a sessão dessa conta) -> validação (só quem está logado numa conta antiga; interruptor config.app_acesso_modo ligado; PIN de 4 números; celular, nome e nascimento conferidos como no cadastro novo; maior de 18; celular livre) -> lógica (junta o que já temos da conta e do cadastro da clínica: nome, celular, e-mail, CPF e nascimento; só pede o que falta e o PIN novo; cria o acesso rápido ligado à conta antiga e abre o aparelho) -> saída (código do aparelho + perfil; a partir daí a pessoa entra só com celular + PIN; a conta antiga não é apagada)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (contas antigas passam a ter o acesso rápido: uma forma de login só)
--
-- POR QUE: existem dois logins (e-mail + senha, de 31/10, e celular + PIN, de 14/11). O dono quer uma forma só. Quem já tem conta antiga entra mais uma vez
-- com e-mail e senha, cria o PIN e o banco copia para o acesso rápido o que já tem guardado (nome, celular, e-mail e, se a conta estiver ligada a um
-- cadastro da clínica, CPF e nascimento). Nada é criado sozinho: sem a pessoa digitar o PIN, nenhuma linha nasce em app_paciente.
--
-- SEGURANÇA:
--   * só o papel `authenticated` executa (quem acabou de provar e-mail + senha); o público (anon) não executa nenhuma das duas funções;
--   * a conta é a do próprio login (auth.uid()): ninguém herda a conta de outra pessoa;
--   * o celular continua sem confirmação por SMS (mesma limitação do cadastro novo); celular já usado por outro acesso é recusado;
--   * o CPF vem do cadastro da clínica e é guardado só no banco (a página recebe só a máscara, como no acesso rápido);
--   * a conta antiga NÃO é apagada nem alterada (só ganha o vínculo em app_paciente.conta_antiga_id): voltar atrás é simples;
--   * cada herança grava um evento sem dado pessoal em app_evento.
--
-- DEPENDE DE: supabase/acesso-rapido-paciente.sql e supabase/acesso-rapido-chat.sql (colunas cpf e email de app_paciente).
--
-- ROLLBACK (não mexe em nenhuma função existente):
--   drop function if exists public.app_conta_antiga_herdar(text, text, text, text, text), public.app_conta_antiga_resumo(), public.app_tel_br(text);
--   alter table public.app_paciente drop column if exists conta_antiga_id;
-- Pode ser aplicado mais de uma vez.

alter table public.app_paciente add column if not exists conta_antiga_id uuid references public.contas_paciente (id) on delete set null;
create unique index if not exists app_paciente_conta_antiga on public.app_paciente (conta_antiga_id) where conta_antiga_id is not null;
comment on column public.app_paciente.conta_antiga_id is 'Conta antiga (e-mail e senha) da qual este acesso rápido herdou os dados. Vazio para quem se cadastrou direto pelo celular.';

-- Celular do Brasil como o acesso rápido guarda: só dígitos, DDD + 9 + 8 números (tira o 55 da frente). Nulo se não servir.
create or replace function public.app_tel_br(t text) returns text language sql immutable set search_path to '' as $$
  select case when d ~ '^[1-9]{2}9[0-9]{8}$' then d when d ~ '^55[1-9]{2}9[0-9]{8}$' then substr(d, 3) end
  from (select regexp_replace(coalesce(t, ''), '\D', '', 'g') as d) x $$;

-- O que a conta antiga já tem e o que falta para virar acesso rápido. Só devolve dados da própria conta logada.
create or replace function public.app_conta_antiga_resumo() returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare cp public.contas_paciente%rowtype; p public.pacientes%rowtype; v_tel text; v_nome text; v_nasc date; v_cpf text; v_falta jsonb := '[]'::jsonb;
begin
  select * into cp from public.contas_paciente where id = (select auth.uid());
  if not found then return jsonb_build_object('ok', true, 'conta', false); end if;
  if exists (select 1 from public.app_paciente where conta_antiga_id = cp.id) then
    return jsonb_build_object('ok', true, 'conta', true, 'migrada', true, 'email', cp.email);
  end if;
  if cp.paciente_id is not null then select * into p from public.pacientes where id = cp.paciente_id; end if;
  v_tel := coalesce(public.app_tel_br(cp.telefone), (select public.app_tel_br(x) from unnest(coalesce(p.telefones, '{}'::text[])) x where public.app_tel_br(x) is not null limit 1));
  v_nome := case when public.app_nome_ok(cp.nome) then btrim(cp.nome) when public.app_nome_ok(p.nome) then btrim(p.nome) end;
  v_nasc := case when p.dt_nasc between date '1900-01-01' and public.app_hoje() then p.dt_nasc end;
  v_cpf := case when regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g') ~ '^[0-9]{11}$' and public.fluxo_cpf_ok(regexp_replace(p.cpf, '\D', '', 'g')) then regexp_replace(p.cpf, '\D', '', 'g') end;
  if v_nome is null then v_falta := v_falta || '"nome"'::jsonb; end if;
  if v_tel is null then v_falta := v_falta || '"telefone"'::jsonb; end if;
  if v_nasc is null then v_falta := v_falta || '"nascimento"'::jsonb; end if;
  return jsonb_build_object('ok', true, 'conta', true, 'migrada', false, 'email', cp.email, 'nome', v_nome, 'telefone', v_tel, 'nascimento', v_nasc,
    'cpf_mascara', public.app_cpf_mascara(v_cpf), 'falta', v_falta);
end $$;

-- Cria o acesso rápido a partir da conta antiga. O que a pessoa informa vale; o que não informar vem da conta e do cadastro da clínica.
create or replace function public.app_conta_antiga_herdar(p_pin text, p_telefone text default null, p_nome text default null, p_nascimento text default null, p_aparelho text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  cp public.contas_paciente%rowtype; p public.pacientes%rowtype; v_tel text; v_nome text; v_nasc date; v_cpf text; v_email text; v_id uuid; v_max integer; v_token text;
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
  v_token := public.app_aparelho_abrir(v_id, p_aparelho);
  perform public.app_evento_gravar(v_id, 'conta_antiga_herdada');
  return jsonb_build_object('ok', true, 'token', v_token, 'perfil', public.app_perfil_json(v_id));
end $$;

revoke all on function public.app_tel_br(text), public.app_conta_antiga_resumo(), public.app_conta_antiga_herdar(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.app_conta_antiga_resumo(), public.app_conta_antiga_herdar(text, text, text, text, text) to authenticated;
