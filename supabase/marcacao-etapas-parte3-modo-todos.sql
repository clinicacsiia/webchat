-- FLUXOGRAMA: entrada (painel > Configurações > Entrada do paciente > "Tela nova de marcação") -> validação (marcacao_etapas_modo: nao | piloto | teste | todos | sim; 'todos' = tela do teste para todos)
--   -> lógica (marcacao_etapas_pode(telefone): 'sim' e 'todos' = todos; 'piloto' e 'teste' = só os telefones da lista) -> saída (o chat abre a tela correspondente)
-- Versão 1.0 — 25/11/2026 / Mudança: 'todos' (aplicada como migração marcacao_etapas_p3_modo_todos). ROLLBACK: update public.config set valor = 'nao' where chave = 'marcacao_etapas_modo'; (a função da parte 2 também serve).
create or replace function public.marcacao_etapas_pode(p_telefone text) returns boolean
language plpgsql stable security definer set search_path = '' as $function$
declare v_modo text; v_tel text; v_lista text;
begin
  select valor into v_modo from public.config where chave = 'marcacao_etapas_modo';
  if v_modo in ('sim', 'todos') then return true; end if;
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
