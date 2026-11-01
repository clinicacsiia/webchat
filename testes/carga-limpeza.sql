-- Limpeza do teste de carga (testes/carga.mjs).
-- Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
--
-- Apaga SÓ os contatos criados pelo robô: nome "TESTE DE CARGA nnn" E e-mail "carga-...@example.invalid"
-- (domínio .invalid nunca existe de verdade, então não pega paciente real).
-- Conversas, mensagens, segredos, fluxo, pré-agendamentos e itens saem junto (ON DELETE CASCADE a partir de contatos -> conversas).
-- Rode no SQL Editor do Supabase. Primeiro o SELECT (conferência), depois o DELETE.

-- 1) Conferência: deve listar só contatos de teste.
select count(*) as contatos_de_teste,
       (select count(*) from public.conversas c where c.contato_id in (select id from public.contatos where nome like 'TESTE DE CARGA %' and email like 'carga-%@example.invalid')) as conversas_de_teste
from public.contatos
where nome like 'TESTE DE CARGA %' and email like 'carga-%@example.invalid';

-- 2) Exclusão (tire o comentário depois de conferir o número acima).
-- delete from public.contatos where nome like 'TESTE DE CARGA %' and email like 'carga-%@example.invalid';

-- 3) Sobras que NÃO caem em cascata (pacientes criados pelo motor ficam com origem_conversa nula; incidentes da Sentinela idem):
-- select id, nome from public.pacientes where nome like 'TESTE DE CARGA %';
-- delete from public.pacientes where nome like 'TESTE DE CARGA %';
