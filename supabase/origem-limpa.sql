-- FLUXOGRAMA: entrada (parâmetro ?origem= do link, às vezes colado com formatação markdown, ex.: 'qrcode**](https://...?origem=qrcode)') -> validação (só letras, números, - e _; no máximo 40 caracteres; o que sobra depois do primeiro caractere inválido é descartado) -> lógica (função origem_limpa; chat_iniciar passa a gravar o valor limpo, partindo da definição que está no banco; contatos antigos são corrigidos) -> saída (contatos.origem só com valor limpo ou nulo)
-- Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial (bug "Coluna Origem" do relatório de teste do painel).
--
-- Aplicar em PARTES (o Supabase expira a migração em 60 s): parte 1 = seção 1; parte 2 = seção 2; parte 3 = seção 3.
-- ROLLBACK: a definição anterior de chat_iniciar está em fase7-motor.sql (seção 14) menos o bloco do n8n (saida-n8n.sql). Os valores
-- sujos antigos não são guardados em outro lugar; a limpeza só encurta o texto até o primeiro caractere inválido.

-- ===== 1. Função de limpeza =====
create or replace function public.origem_limpa(p_origem text) returns text
language sql immutable set search_path to '' as $$
  select nullif(left((regexp_match(btrim(coalesce(p_origem, '')), '^[A-Za-z0-9_-]+'))[1], 40), '')
$$;

-- ===== 2. chat_iniciar grava a origem limpa (e só ela) =====
-- Parte da definição que está no banco (a função é a porta de entrada de todo paciente; não se reescreve à mão). Idempotente.
do $$
declare d text; novo text;
begin
  d := pg_get_functiondef('public.chat_iniciar(text,text,text,text,boolean,text,text,text,text,text,jsonb,text)'::regprocedure);
  if d like '%origem_limpa%' then return; end if;
  novo := replace(d, 'nullif(left(btrim(coalesce(p_origem, '''')), 100), '''')', 'public.origem_limpa(p_origem)');
  if novo = d or novo not like '%origem_limpa%' then raise exception 'chat_iniciar: não reconheci onde a origem é gravada; nada foi alterado'; end if;
  execute novo;
end $$;

-- ===== 3. Registros antigos =====
update public.contatos set origem = public.origem_limpa(origem) where origem is distinct from public.origem_limpa(origem);
