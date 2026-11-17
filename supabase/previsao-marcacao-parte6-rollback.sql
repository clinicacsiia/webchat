-- Desfaz previsao-marcacao-parte6-unidades.sql (rodar no editor SQL: tem `drop`).
-- 1) apagar a função nova; 2) voltar pmarc_disponibilidade e pmarc_catalogo às versões de supabase/previsao-marcacao-parte5-escolha.sql (rodar de novo o trecho dessas duas funções).
drop function if exists public.pmarc_unidades(integer);
