-- FLUXOGRAMA: entrada (decisão do dono, 19/11/2026: apagar a assinatura biométrica) -> validação (recusa se alguma tabela do módulo tiver linha ou algum paciente tiver perfil biométrico)
--   -> lógica (apaga as 4 funções, as 2 tabelas e as 2 colunas só do módulo; a fila de chegada e a máquina de estados de `atendimentos` ficam) -> saída (módulo biométrico inexistente; 0 linhas perdidas)
-- Versão 1.0 — 19/11/2026 / Mudança: primeira versão. Dado biométrico é dado sensível (LGPD, art. 11); o módulo nunca foi usado (0 registros, 0 perfis, 0 atendimentos conferidos na produção em 19/11/2026).
-- ATENÇÃO: este arquivo tem `drop`. O conector do Supabase pede confirmação e expira em 60 s: aplicar em 3 partes (PARTE 1, PARTE 2, PARTE 3), cada uma como uma migração.
-- NÃO MEXE: `atendimentos` (colunas documento_texto, documento_hash, tentativas_falhas, bloqueado_em e o estado 'assinatura_pendente') e as funções fila_estado, fila_listar, fila_emitir_token, fila_reenviar_link:
--   continuam existindo, sem nenhum caminho que as preencha (a tabela tem 0 linhas). Tirar isso exigiria reescrever 5 funções da fila sem ganho de proteção de dados.
-- REVERSÃO: não há dado a recuperar. Para recriar a estrutura vazia, rodar a parte de assinatura de supabase/fila-biometria.sql (histórico; não recomendado).

-- ===== PARTE 1: guarda + funções =====
do $$
declare v_n bigint;
begin
  if to_regclass('public.registro_assinaturas') is not null then
    execute 'select count(*) from public.registro_assinaturas' into v_n;
    if v_n > 0 then raise exception 'registro_assinaturas tem linhas: nada foi apagado.'; end if;
  end if;
  if to_regclass('public.assinatura_tentativas') is not null then
    execute 'select count(*) from public.assinatura_tentativas' into v_n;
    if v_n > 0 then raise exception 'assinatura_tentativas tem linhas: nada foi apagado.'; end if;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pacientes' and column_name = 'perfil_biometrico_historico') then
    execute 'select count(*) from public.pacientes where perfil_biometrico_historico is not null and perfil_biometrico_historico <> ''{}''::jsonb' into v_n;
    if v_n > 0 then raise exception 'há paciente com perfil biométrico: nada foi apagado.'; end if;
  end if;
end $$;
drop function if exists public.assinatura_contexto(text, text, text);
drop function if exists public.assinatura_registrar(text, text, text, jsonb, jsonb, text, text);
drop function if exists public.fila_chamar_assinatura(uuid, text);
drop function if exists public.fila_cancelar_assinatura(uuid);

-- ===== PARTE 2: tabelas vazias do módulo =====
drop table if exists public.assinatura_tentativas;
drop table if exists public.registro_assinaturas;

-- ===== PARTE 3: colunas biométricas de pacientes =====
alter table public.pacientes drop column if exists perfil_biometrico_historico;
alter table public.pacientes drop column if exists assinatura_papel_path;
