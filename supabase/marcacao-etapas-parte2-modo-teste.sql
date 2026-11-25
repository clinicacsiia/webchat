-- FLUXOGRAMA: entrada (o chat lê `chat_config()`; `marcacao_etapas_modo` = 'teste' abre a tela do ambiente de teste v20261125a ligada ao motor real)
--   -> validação (marcacao_etapas_pode(telefone): 'teste' funciona como 'piloto', só os telefones da lista `marcacao_etapas_telefones`)
--   -> lógica (a tela do teste junta as respostas; integracao-real.js entrega ao motor na ordem dele)
--   -> saída (marcação real pelo motor) | ROLLBACK: update public.config set valor = 'nao' where chave = 'marcacao_etapas_modo';  (ou recriar a função da parte 1)
-- Versão 1.0 — 25/11/2026 / Mudança: 'teste' vale como 'piloto' em marcacao_etapas_pode (aplicada em 25/11/2026, migração marcacao_etapas_p2_modo_teste).
create or replace function public.marcacao_etapas_pode(p_telefone text) returns boolean
language plpgsql stable security definer set search_path = '' as $function$
declare v_modo text; v_tel text; v_lista text;
begin
  select valor into v_modo from public.config where chave = 'marcacao_etapas_modo';
  if v_modo = 'sim' then return true; end if;
  if v_modo is distinct from 'piloto' and v_modo is distinct from 'teste' then return false; end if;
  v_tel := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  if char_length(v_tel) in (12, 13) and left(v_tel, 2) = '55' then v_tel := substr(v_tel, 3); end if;
  if char_length(v_tel) not in (10, 11) then return false; end if;
  select valor into v_lista from public.config where chave = 'marcacao_etapas_telefones';
  return exists (
    select 1 from unnest(string_to_array(coalesce(v_lista, ''), ',')) t(x)
    where case when char_length(regexp_replace(t.x, '\D', '', 'g')) in (12, 13) and left(regexp_replace(t.x, '\D', '', 'g'), 2) = '55'
               then substr(regexp_replace(t.x, '\D', '', 'g'), 3) else regexp_replace(t.x, '\D', '', 'g') end = v_tel);
end $function$;
