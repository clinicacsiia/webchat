-- FLUXOGRAMA: entrada (toda chamada do paciente ao banco: chat, conta antiga por e-mail, check-in; o chat e a minha-vez mandam o aparelho no cabeçalho x-acesso) -> validação (app_pin_token: só vale com app_acesso_modo, app_pin_obrigatorio e app_pin_servidor = sim; chamada sem requisição HTTP, service_role, funções app_* e a EQUIPE passam) -> lógica (sem aparelho com PIN dos últimos 30 minutos a chamada é recusada com pin_obrigatorio; as ações antigas renovam o prazo, as demais só conferem) -> saída (44 funções protegidas além das 5 de acesso-rapido-pin-servidor.sql: quem entra só com o código da conversa ou só com e-mail e senha não vê nem faz nada sem PIN)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (auditoria de 15/11/2026: o PIN passa a valer para o sistema todo, inclusive os cadastros antigos).
--
-- POR QUE: a auditoria achou portas que não passavam pelo PIN: (1) conta_paciente_conversas devolvia os CÓDIGOS das conversas e conta_paciente_meus_dados devolvia CPF e histórico só com e-mail e senha; (2) as 33 funções do chat que usam só o código da conversa (ler mensagens, enviar foto...); (3) checkin_publico e fila_cheguei (check-in sem PIN: fase 2).
--
-- COMO FUNCIONA: app_pin_token() decide se a chamada precisa de PIN; app_pin_exigir() (já existia; renova os 30 minutos) e app_pin_exigir_leitura() (só confere, não renova) recusam com 'pin_obrigatorio'. O bloco no fim acrescenta a chamada no começo de cada função (lê a definição ATUAL do banco; pula quem já tem). As 4 funções escritas em SQL puro são reescritas em PL/pgSQL só para poder chamar a trava.
-- FASE 2 (acesso-rapido-pin-fila.sql): checkin_publico, fila_cheguei, fila_minha_vez, paciente_jornada e fila_push_salvar só passam a exigir o PIN DEPOIS de a minha-vez nova (que manda o aparelho) estar publicada; antes disso o check-in da recepção quebraria (foi o que aconteceu por alguns minutos em 15/11/2026 e foi recuado na hora).
-- NÃO ENTRAM DE PROPÓSITO: chat_incidente (relato de erro, não lê nada), chat_push_remover, fila_push_remover e conta_senha_trocada (só mexem no que é da própria pessoa), as de configuração pública (app_porta, chat_config, chat_saude, login_paciente_ativo) e fila_minha_vez_ticket (o link da fila é uma credencial emitida pela clínica).
-- A trava continua controlada por config.app_pin_servidor (nasce 'nao'; ligar só com as telas novas publicadas). Desligar: update public.config set valor = 'nao' where chave = 'app_pin_servidor';
-- ROLLBACK: voltar cada função à versão anterior (git de supabase/producao/funcoes/<nome>.sql); as funções novas podem ficar (não fazem nada com a trava desligada).

-- Quem precisa do PIN nesta chamada? null = ninguém (dispensado); '' = precisa e não mandou aparelho; texto = código do aparelho a conferir.
create or replace function public.app_pin_token() returns text language plpgsql stable security definer set search_path to '' as $$
declare v_h jsonb; v_path text;
begin
  if coalesce((select valor from public.config where chave = 'app_pin_servidor'), 'nao') <> 'sim' then return null; end if;
  if not public.app_modo() or coalesce((select valor from public.config where chave = 'app_pin_obrigatorio'), 'nao') <> 'sim' then return null; end if;
  begin v_h := current_setting('request.headers', true)::jsonb; exception when others then v_h := null; end;
  if v_h is null then return null; end if;   -- sem requisição HTTP (rotina do banco, teste interno): a regra é da porta
  begin if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role' then return null; end if; exception when others then null; end;
  begin v_path := current_setting('request.path', true); exception when others then v_path := null; end;
  if coalesce(v_path, '') like '/rpc/app\_%' then return null; end if;   -- as funções app_* já conferem o aparelho e o PIN sozinhas
  if public.papel_atual() is not null then return null; end if;   -- a equipe (admin, atendente...) não usa PIN de paciente
  return coalesce(nullif(btrim(coalesce(v_h ->> 'x-acesso', '')), ''), '');
end $$;
revoke all on function public.app_pin_token() from public, anon, authenticated;

create or replace function public.app_pin_exigir() returns void language plpgsql security definer set search_path to '' as $$
declare v_tok text; s record;
begin
  v_tok := public.app_pin_token();
  if v_tok is null then return; end if;
  if v_tok = '' then raise exception 'pin_obrigatorio' using hint = 'Digite o seu PIN para continuar.'; end if;
  select * into s from public.app_aparelho_validar(v_tok);   -- confere o PIN dos últimos 30 minutos e RENOVA o prazo
  if s.o_erro is not null then raise exception 'pin_obrigatorio' using hint = 'Digite o seu PIN para continuar.'; end if;
end $$;
revoke all on function public.app_pin_exigir() from public, anon, authenticated;

create or replace function public.app_pin_exigir_leitura() returns void language plpgsql security definer set search_path to '' as $$
declare v_tok text;
begin
  v_tok := public.app_pin_token();
  if v_tok is null then return; end if;
  -- só confere (não renova): o prazo de 30 minutos é renovado pelo uso do chat (app_perfil) e pelas ações principais
  if v_tok = '' or not exists (select 1 from public.app_aparelho a where a.token_hash = encode(sha256(convert_to(v_tok, 'UTF8')), 'hex')
        and a.ultimo_uso_em >= now() - interval '90 days' and a.desbloqueada_ate is not null and a.desbloqueada_ate >= now()) then
    raise exception 'pin_obrigatorio' using hint = 'Digite o seu PIN para continuar.';
  end if;
end $$;
revoke all on function public.app_pin_exigir_leitura() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.conta_paciente_conversas()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  return (select coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'token', s.token, 'criado_em', (extract(epoch from c.criado_em) * 1000)::bigint,
      'tipo', coalesce(c.paciente_tipo, 'proprio'), 'nomeCrianca', case when c.paciente_tipo = 'filho' then coalesce(c.paciente_nome, '') else '' end,
      'ultima', left(coalesce(c.ultima_mensagem, ''), 120)) order by c.criado_em desc)
    from (select x.* from public.conversas x where x.conta_id = (select auth.uid()) order by x.criado_em desc limit 30) c
    join public.conversa_segredo s on s.conversa_id = c.id
    where exists (select 1 from public.contas_paciente cp where cp.id = (select auth.uid()))), '[]'::jsonb));
end $function$;

CREATE OR REPLACE FUNCTION public.conta_paciente_resumo()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  return (select coalesce((select jsonb_build_object('conta', true, 'email', cp.email, 'nome', cp.nome, 'telefone', cp.telefone,
                                             'cadastro_salvo', cp.paciente_id is not null, 'aceitou_lgpd', cp.aceitou_lgpd_em is not null)
                     from public.contas_paciente cp where cp.id = (select auth.uid())), jsonb_build_object('conta', false)));
end $function$;

CREATE OR REPLACE FUNCTION public.conta_paciente_vinculo_estado()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  return (select coalesce((select jsonb_build_object(
      'ligada', cp.paciente_id is not null,
      'verificar_aberto', exists (select 1 from public.vinculo_solicitacoes s where s.conta_id = cp.id and s.tipo = 'verificar' and s.status = 'aberta'),
      'alteracao_aberta', exists (select 1 from public.vinculo_solicitacoes s where s.conta_id = cp.id and s.tipo = 'alterar' and s.status = 'aberta'))
    from public.contas_paciente cp where cp.id = (select auth.uid())), jsonb_build_object('ligada', false, 'verificar_aberto', false, 'alteracao_aberta', false)));
end $function$;

CREATE OR REPLACE FUNCTION public.conta_precisa_trocar_senha()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  return (select coalesce((select senha_provisoria from public.contas_paciente where id = (select auth.uid())), false));
end $function$;

do $mig$
declare r record; v_def text; v_novo text;
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('chat_acompanhar', 'chat_anexo_enviar', 'chat_arquivo_equipe', 'chat_avaliacao_estado', 'chat_avaliar', 'chat_consulta_salvar', 'chat_consultas', 'chat_corpo', 'chat_despedida_imagem', 'chat_disponibilidade_alterar', 'chat_disponibilidade_cancelar', 'chat_disponibilidade_registrar', 'chat_disponibilidade_responder', 'chat_disponibilidade_ver', 'chat_exames', 'chat_exames_buscar', 'chat_exames_salvar', 'chat_foto_enviar', 'chat_horario_escolher', 'chat_horarios', 'chat_listar', 'chat_medico_limpar', 'chat_medicos_disponiveis', 'chat_pedido_enviar', 'chat_pedido_escolha', 'chat_pedido_ler', 'chat_pedido_salvar', 'chat_previsao_aceitar', 'chat_push_estado', 'chat_push_salvar', 'chat_push_silenciar', 'chat_reentrada_estado', 'chat_voltar', 'conta_paciente_adotar_conversas', 'conta_paciente_confirmar_cpf', 'conta_paciente_excluir', 'conta_paciente_meus_dados', 'conta_paciente_pedir_alteracao', 'conta_paciente_perfil', 'conta_paciente_vincular') order by p.proname loop
    v_def := pg_get_functiondef(r.oid);
    if position('app_pin_exigir' in v_def) > 0 then continue; end if;   -- já aplicada
    v_novo := regexp_replace(v_def, E'(AS \\$function\\$.*?\\n[ \\t]*begin[ \\t]*\\n)', E'\\1  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)\n');
    if v_novo = v_def then raise exception 'não achei o begin principal de %', r.proname; end if;
    execute v_novo;
  end loop;
end $mig$;
