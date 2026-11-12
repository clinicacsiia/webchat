-- Autoatendimento com a API do Klingo — Parte 9: "Voltar e corrigir" conhece o passo novo (CPF + nascimento). Escrito em 12/11/2026.
--
-- FLUXOGRAMA: a paciente toca em "Voltar e corrigir" no plano -> chat_voltar ensaia as formas de voltar na ordem (agora com a 11, "refazer CPF e nascimento", logo antes de voltar ao médico/exame)
--   -> fluxo_voltar_passo(11) marca cpf_nasc_refazer -> fluxo_proximo devolve "cpf_nasc" -> ao responder, fluxo_aplicar apaga a marca.
-- Versão 1.0 — 12/11/2026 / Mudança: primeira versão. Sem isto, voltar do plano pulava direto para o exame e perguntava o CPF de novo depois.
-- Para voltar atrás: recolocar chat_voltar, fluxo_voltar_passo, fluxo_proximo e fluxo_aplicar como estão em supabase/producao/funcoes/ no git anterior a esta parte.

create or replace function pg_temp.trocar(t text, velho text, novo text) returns text language plpgsql as $t$
begin
  if position(novo in t) > 0 then return t; end if;   -- já aplicado: a migração pode ser repetida sem estragar
  if (length(t) - length(replace(t, velho, ''))) / greatest(length(velho), 1) <> 1 then raise exception 'trecho nao encontrado exatamente uma vez: %', left(velho, 60); end if;
  return replace(t, velho, novo);
end $t$;
do $do$ declare d text;
begin
  d := pg_get_functiondef('public.chat_voltar(uuid, text)'::regprocedure);
  d := pg_temp.trocar(d, $a$  for i in 1..10 loop
$a$, $a$  foreach i in array array[1, 2, 3, 4, 5, 6, 11, 7, 8, 9, 10] loop   -- klingo-auto: a 11 (CPF e nascimento) vem logo antes do médico/exame
$a$);
  execute d;
  d := pg_get_functiondef('public.fluxo_voltar_passo(uuid, integer)'::regprocedure);
  d := pg_temp.trocar(d, $a$  when 10 then
$a$, $a$  when 11 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "cpf_nasc_refazer": true}');   -- klingo-auto
  when 10 then
$a$);
  execute d;
  d := pg_get_functiondef('public.fluxo_proximo(uuid)'::regprocedure);
  d := pg_temp.trocar(d, $a$ or public.fluxo_ler_data(pa.paciente ->> 'dt_nasc') is null then return 'cpf_nasc'; end if;$a$,
    $a$ or public.fluxo_ler_data(pa.paciente ->> 'dt_nasc') is null or coalesce((d ->> 'cpf_nasc_refazer')::boolean, false) then return 'cpf_nasc'; end if;$a$);
  execute d;
  d := pg_get_functiondef('public.fluxo_aplicar(uuid, text, jsonb)'::regprocedure);
  d := pg_temp.trocar(d, $a$|| jsonb_build_object('cpf', x, 'dt_nasc', to_char(v_dt, 'DD/MM/YYYY'))));$a$, $a$|| jsonb_build_object('cpf', x, 'dt_nasc', to_char(v_dt, 'DD/MM/YYYY')), 'cpf_nasc_refazer', null));$a$);
  execute d;
end $do$;
