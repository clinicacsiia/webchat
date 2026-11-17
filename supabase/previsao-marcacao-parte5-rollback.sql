-- Desfaz previsao-marcacao-parte5-escolha.sql (rodar no editor SQL: tem `drop`). Não mexe em tabela nenhuma; os pedidos já anotados ficam em pmarc_pessoa.informado.
drop function if exists public.pmarc_pedido(text, jsonb);
drop function if exists public.pmarc_disponibilidade(integer, jsonb);
drop function if exists public.pmarc_catalogo(text, text);
drop function if exists public.pmarc_tipo_proc(text);
