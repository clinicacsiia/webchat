-- ÚLTIMA PARTE da aplicação em produção de supabase/acesso-rapido-paciente.sql (14 e 15/11/2026).
-- As partes 1, 2a, 3a, 4 e a migração acesso-rapido-chat.sql já estão aplicadas. Esta traz as 3 funções que têm `delete`
-- (o conector do Supabase pede confirmação neles e expira em 60 s): app_aparelho_abrir, app_pin_esqueci e app_sair, mais as permissões finais.
-- Colar no editor SQL: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/sql/new  (pode rodar de novo sem problema)
-- (15/11/2026) Pode ser colada ANTES ou DEPOIS de supabase/acesso-rapido-conta-antiga.sql: o bloco final devolve a permissão das funções da conta antiga.
-- Depois: refazer o retrato (supabase/producao/LEIAME.md) e `npm run test:retrato`.

-- Abre um aparelho novo: devolve o código (só aqui ele existe em texto; o banco guarda o hash). No máximo 5 aparelhos por titular.
create or replace function public.app_aparelho_abrir(p_pac uuid, p_aparelho text) returns text language plpgsql security definer set search_path to '' as $$
declare v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  insert into public.app_aparelho (paciente_id, token_hash, aparelho, desbloqueada_ate)
  values (p_pac, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), left(nullif(btrim(coalesce(p_aparelho, '')), ''), 120), now() + interval '30 minutes');
  delete from public.app_aparelho where id in (select id from public.app_aparelho where paciente_id = p_pac order by ultimo_uso_em desc offset 5);
  update public.app_paciente set ultimo_acesso_em = now() where id = p_pac;
  return v_token;
end $$;


-- "Esqueci o PIN": celular + nome + nascimento. Conta como erro de PIN, derruba os outros aparelhos e deixa registro.
create or replace function public.app_pin_esqueci(p_telefone text, p_nome text, p_nascimento text, p_pin_novo text, p_aparelho text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); a public.app_paciente%rowtype; v_seg integer; r jsonb; v_token text;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if coalesce(p_pin_novo, '') !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'O PIN precisa ter 4 números.'); end if;
  select * into a from public.app_paciente where telefone = v_tel for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'dados', 'mensagem', 'Os dados não conferem com o cadastro.'); end if;
  v_seg := public.app_trava(a.id);
  if v_seg > 0 then return public.app_bloqueado_json(v_seg); end if;
  if public.app_norm(p_nome) = public.app_norm(a.nome) and public.app_data(p_nascimento) = a.nascimento then
    update public.app_paciente set pin_hash = extensions.crypt(p_pin_novo, extensions.gen_salt('bf', 8)), atualizado_em = now() where id = a.id;
    perform public.app_acerto(a.id);
    delete from public.app_aparelho where paciente_id = a.id;
    v_token := public.app_aparelho_abrir(a.id, p_aparelho);
    perform public.app_evento_gravar(a.id, 'pin_redefinido');
    return jsonb_build_object('ok', true, 'token', v_token, 'perfil', public.app_perfil_json(a.id));
  end if;
  r := public.app_falha(a.id);
  if r ->> 'erro' = 'bloqueado' then return r; end if;
  return jsonb_build_object('ok', false, 'erro', 'dados', 'restantes', r -> 'restantes', 'mensagem', 'Os dados não conferem com o cadastro.');
end $$;


create or replace function public.app_sair(p_token text) returns jsonb language sql security definer set search_path to '' as $$
  with apagado as (delete from public.app_aparelho where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') returning 1)
  select jsonb_build_object('ok', true) $$;


-- ---- Permissões: tudo fechado; só as funções do paciente para a chave pública, as da equipe para quem está logado.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as assinatura from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'app\_%' or p.proname like 'painel\_app\_%') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.assinatura);
  end loop;
end $$;
grant execute on function
  public.app_cadastrar(text, text, text, text, jsonb, jsonb, text), public.app_login(text, text, text), public.app_desbloquear(text, text), public.app_perfil(text),
  public.app_pin_trocar(text, text, text), public.app_pin_esqueci(text, text, text, text, text), public.app_sair(text),
  public.app_filho_salvar(text, text, text), public.app_filho_remover(text, uuid),
  public.app_confianca_salvar(text, text, text, text), public.app_confianca_remover(text, uuid), public.app_confianca_novo_codigo(text, uuid), public.app_confianca_aceitar(text, text),
  public.app_selecao_salvar(text, jsonb), public.app_marcar(text, jsonb, text, text, text, text), public.app_marcacao_cancelar(text, uuid)
  to anon, authenticated;
grant execute on function public.painel_app_solicitacoes(text), public.painel_app_solicitacao_status(uuid, text) to authenticated;

-- permissões das funções da migração do chat (repetidas aqui porque o bloco acima apaga e concede de novo)
grant execute on function public.app_ativo(), public.app_pessoa_cpf_salvar(text, text, text), public.app_chat_dados(text, uuid, text) to anon, authenticated;

-- As funções da conta antiga (supabase/acesso-rapido-conta-antiga.sql) perdem a permissão no bloco acima; devolve se já existirem.
do $$ begin
  if to_regprocedure('public.app_conta_antiga_resumo()') is not null then
    grant execute on function public.app_conta_antiga_resumo(), public.app_conta_antiga_herdar(text, text, text, text, text) to authenticated;
  end if;
end $$;

-- As funções de pendências (supabase/acesso-rapido-pendencias.sql) também perdem a permissão no bloco acima; devolve se já existirem.
do $$ begin
  if to_regprocedure('public.app_pendencias(text)') is not null then
    grant execute on function public.app_pendencias(text), public.app_pendencia_responder(text, text, text, text) to anon, authenticated;
    grant execute on function public.painel_app_revisoes(), public.painel_app_revisao_resolver(uuid) to authenticated;
  end if;
end $$;

-- As funções de filhos (supabase/acesso-rapido-filhos.sql) também perdem a permissão no bloco acima; devolve se já existirem.
do $$ begin
  if to_regprocedure('public.app_filho_adicionar(text, text, text, boolean)') is not null then
    grant execute on function public.app_filho_adicionar(text, text, text, boolean) to anon, authenticated;
    grant execute on function public.app_conta_antiga_filhos(), public.app_conta_antiga_migrar(text, text, text, text, jsonb, text) to authenticated;
  end if;
end $$;

-- As funções do painel de pendências (supabase/acesso-rapido-painel.sql) também perdem a permissão no bloco acima; devolve se já existirem.
do $$ begin
  if to_regprocedure('public.painel_app_pendencias_resumo()') is not null then
    grant execute on function public.painel_app_pendencias_resumo(), public.painel_app_contas_antigas() to authenticated;
  end if;
end $$;
