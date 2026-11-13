-- FLUXOGRAMA: entrada (o paciente digita nome, celular e e-mail no formulário inicial, ou o "Não sou eu" pede tudo de novo) -> validação (nome completo com 2 palavras, celular com DDD válido,
--   e-mail com formato válido; conferido NO BANCO, não só na tela, e salvo na hora) -> fase 2 (CPF e data de nascimento, conferidos na API) -> fase 3 (nome da mãe, só depois) -> saída.
-- Versão 1.0 — 13/11/2026 / Mudança: pedido do dono. (1) funções fluxo_nome_ok, fluxo_telefone_ok, fluxo_email_ok; (2) chat_iniciar e fluxo_aplicar passam a usá-las (antes: nome ≥ 2 letras,
--   telefone só 10 ou 11 dígitos); (3) "Não sou eu" agora começa por nome completo + celular + e-mail (validados e salvos) ANTES de CPF e nascimento; o preenchimento automático NÃO muda.
-- Cada trecho é aplicado sobre a função que está na produção AGORA (troca de texto com conferência de que o ponto existe uma só vez); rodar de novo não repete.
-- ROLLBACK: reaplicar chat_iniciar, fluxo_aplicar, fluxo_perguntar e fluxo_proximo a partir do retrato (supabase/producao/funcoes/ depois de refeito) e drop das 3 funções fluxo_*_ok.
-- APLICAR EM PARTES (a ferramenta de migração expira em 60 s): 1) funções e texto; 2) chat_iniciar; 3) fluxo_aplicar; 4) fluxo_perguntar; 5) fluxo_proximo.

-- Parte 1
create or replace function public.fluxo_nome_ok(p text) returns boolean language sql immutable set search_path to '' as $f$
  select p is not null and char_length(btrim(p)) between 5 and 120
    and btrim(p) ~ '^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ''’.-]*( +[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ''’.-]*)+$'
    and (select count(*) from regexp_split_to_table(btrim(p), ' +') w where char_length(regexp_replace(w, '[^A-Za-zÀ-ÖØ-öø-ÿ]', '', 'g')) >= 2) >= 2
$f$;
create or replace function public.fluxo_telefone_ok(p text) returns boolean language sql immutable set search_path to '' as $f$
  with t as (select case when char_length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) in (12, 13) and left(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 2) = '55'
                         then substr(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 3) else regexp_replace(coalesce(p, ''), '\D', '', 'g') end d)
  select char_length(d) in (10, 11) and d ~ '^[1-9][1-9]' and (char_length(d) = 10 or substr(d, 3, 1) = '9') and substr(d, 3, 1) <> '0' and d !~ '^(\d)\1+$' from t
$f$;
create or replace function public.fluxo_email_ok(p text) returns boolean language sql immutable set search_path to '' as $f$
  select p is not null and char_length(btrim(p)) between 6 and 200 and btrim(p) ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$' and btrim(p) !~ '\.\.'
$f$;
revoke all on function public.fluxo_nome_ok(text), public.fluxo_telefone_ok(text), public.fluxo_email_ok(text) from public, anon, authenticated;
grant execute on function public.fluxo_nome_ok(text), public.fluxo_telefone_ok(text), public.fluxo_email_ok(text) to service_role;
insert into public.fluxo_texto (chave, texto, descricao) values
 ('nse_dados', 'Tudo bem, vamos recomeçar. Primeiro preciso do nome completo, do celular e do e-mail de quem vai ser atendido. Eu confiro agora e já guardo.', 'Fase 1 do "Não sou eu": nome, celular e e-mail')
on conflict (chave) do nothing;

-- Funções auxiliares de aplicação de trechos (somem no fim do arquivo)
create or replace function pg_temp.trocar(p_nome regprocedure, p_ancora text, p_novo text, p_marca text) returns void language plpgsql as $f$
declare d text := pg_get_functiondef(p_nome); n int;
begin
  if position(p_marca in d) > 0 then return; end if;   -- já aplicado
  n := (length(d) - length(replace(d, p_ancora, ''))) / length(p_ancora);
  if n <> 1 then raise exception 'ponto de troca % em %: encontrado % vez(es)', left(p_ancora, 50), p_nome, n; end if;
  execute replace(d, p_ancora, p_novo);
end $f$;

-- Parte 2: chat_iniciar (fase 1 do formulário inicial)
select pg_temp.trocar('public.chat_iniciar(text,text,text,text,boolean,text,text,text,text,text,jsonb,text)'::regprocedure,
  $a$if char_length(v_nome) < 2 then raise exception 'Informe seu nome.' using errcode = '22023'; end if;$a$,
  $b$if not public.fluxo_nome_ok(v_nome) then raise exception 'Informe seu nome completo (nome e sobrenome).' using errcode = '22023'; end if;$b$, 'fluxo_nome_ok');
select pg_temp.trocar('public.chat_iniciar(text,text,text,text,boolean,text,text,text,text,text,jsonb,text)'::regprocedure,
  $a$if char_length(v_tel) not in (10, 11) then raise exception 'Informe um telefone válido com DDD.' using errcode = '22023'; end if;$a$,
  $b$if not public.fluxo_telefone_ok(v_tel) then raise exception 'Informe um celular válido com DDD.' using errcode = '22023'; end if;$b$, 'fluxo_telefone_ok');
select pg_temp.trocar('public.chat_iniciar(text,text,text,text,boolean,text,text,text,text,text,jsonb,text)'::regprocedure,
  $a$if btrim(coalesce(p_email, '')) !~ $a$, $b$if not public.fluxo_email_ok(btrim(coalesce(p_email, ''))) or btrim(coalesce(p_email, '')) !~ $b$, 'fluxo_email_ok');

-- Parte 3: fluxo_aplicar (nome, mãe, celular, e-mail e o nome dentro do passo de contato do "Não sou eu")
select pg_temp.trocar('public.fluxo_aplicar(uuid,text,jsonb)'::regprocedure, $a$when 'dados_contato' then array['celular','telefone','email']$a$, $b$when 'dados_contato' then array['nome','celular','telefone','email']$b$, $m$array['nome','celular','telefone','email']$m$);
select pg_temp.trocar('public.fluxo_aplicar(uuid,text,jsonb)'::regprocedure, $a$elsif k in ('nome', 'mae') and length(x) < 5 then$a$, $b$elsif k in ('nome', 'mae') and not public.fluxo_nome_ok(x) then$b$, 'not public.fluxo_nome_ok(x)');
select pg_temp.trocar('public.fluxo_aplicar(uuid,text,jsonb)'::regprocedure, $a$if length(x) not in (10, 11) then$a$, $b$if not public.fluxo_telefone_ok(x) then$b$, 'not public.fluxo_telefone_ok(x)');
select pg_temp.trocar('public.fluxo_aplicar(uuid,text,jsonb)'::regprocedure, replace($a$x := lower(x);\n        if x !~ $a$, '\n', chr(10)), replace($b$x := lower(x);\n        if not public.fluxo_email_ok(x) then v_err := array_append(v_err, 'o e-mail'::text); continue; end if;\n        if x !~ $b$, '\n', chr(10)), 'not public.fluxo_email_ok(x)');
select pg_temp.trocar('public.fluxo_aplicar(uuid,text,jsonb)'::regprocedure, replace($a$    if cardinality(v_err) > 0 then\n      return jsonb_build_object('ok', false, 'erro', public.fluxo_t('dados_erro'$a$, '\n', chr(10)),
  replace($b$    if p_passo = 'dados_contato' and v_pac ->> 'nome' is null and coalesce((select (f.dados ->> 'nao_sou_eu')::boolean from public.conversa_fluxo f where f.conversa_id = p_conversa), false) and not ('o nome completo' = any(v_err)) then v_err := array_append(v_err, 'o nome completo'::text); end if;\n    if cardinality(v_err) > 0 then\n      return jsonb_build_object('ok', false, 'erro', public.fluxo_t('dados_erro'$b$, '\n', chr(10)), $m$'o nome completo'::text); end if;
    if cardinality(v_err) > 0 then$m$);

-- Parte 4: fluxo_perguntar (o passo de contato do "Não sou eu" pede também o nome completo, sem preencher nada)
select pg_temp.trocar('public.fluxo_perguntar(uuid,text,text)'::regprocedure, $a$v_txt := public.fluxo_t('dados_contato', ctx);$a$, $b$v_txt := public.fluxo_t(case when v_nse then 'nse_dados' else 'dados_contato' end, ctx);$b$, $m$'nse_dados'$m$);
select pg_temp.trocar('public.fluxo_perguntar(uuid,text,text)'::regprocedure, replace($a$'botao', 'Continuar', 'campos', jsonb_build_array(\n      jsonb_build_object('nome', 'celular'$a$, '\n', chr(10)),
  replace($b$'botao', 'Continuar', 'campos', (case when v_nse then jsonb_build_array(jsonb_build_object('nome', 'nome', 'rotulo', 'Nome completo' || (ctx ->> 'de_quem'), 'tipo', 'texto', 'obrigatorio', true)) else '[]'::jsonb end) || jsonb_build_array(\n      jsonb_build_object('nome', 'celular'$b$, '\n', chr(10)), $m$'obrigatorio', true)) else '[]'::jsonb end) || jsonb_build_array($m$);

-- Parte 5: fluxo_proximo ("Não sou eu": nome, celular e e-mail primeiro; depois CPF e nascimento; a mãe vem no passo de identificação, por último)
select pg_temp.trocar('public.fluxo_proximo(uuid)'::regprocedure, replace($a$  -- cpf-primeiro: CPF e data de nascimento válidos são a PRIMEIRA coisa da conversa (antes do menu Exame/Consulta/Outro assunto)\n$a$, '\n', chr(10)),
  replace($b$  -- cpf-primeiro: CPF e data de nascimento válidos são a PRIMEIRA coisa da conversa (antes do menu Exame/Consulta/Outro assunto)\n  if coalesce((d ->> 'nao_sou_eu')::boolean, false) and not coalesce((d ->> 'g_contato')::boolean, false) then return 'dados_contato'; end if;   -- identidade em fases: "não sou eu" = fase 1 (nome, celular, e-mail)\n$b$, '\n', chr(10)), $m$identidade em fases$m$);
