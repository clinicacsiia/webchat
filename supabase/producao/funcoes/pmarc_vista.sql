-- public.pmarc_vista(p_id uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_vista(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p public.pmarc_pessoa; v_tok text; v_nome text; v_faltam jsonb := '[]'::jsonb;
begin
  select * into p from public.pmarc_pessoa where id = p_id;
  if not found then return null; end if;
  if p.conversa_id is not null then select token into v_tok from public.conversa_segredo where conversa_id = p.conversa_id; end if;
  v_nome := coalesce(nullif(btrim(p.informado ->> 'nome'), ''), nullif(btrim(p.nome), ''), '');
  if public.pmarc_telefone(coalesce(p.informado ->> 'celular', p.celular, p.telefone)) is null then v_faltam := v_faltam || '"celular"'::jsonb; end if;
  if coalesce(nullif(btrim(p.informado ->> 'email'), ''), nullif(btrim(p.email), '')) is null then v_faltam := v_faltam || '"email"'::jsonb; end if;
  if p.nascimento is null and coalesce(p.informado ->> 'nascimento', '') = '' then v_faltam := v_faltam || '"nascimento"'::jsonb; end if;
  if not p.tem_cpf and coalesce(p.informado ->> 'cpf', '') = '' then v_faltam := v_faltam || '"cpf"'::jsonb; end if;
  return jsonb_build_object(
    'ok', true, 'codigo', p.codigo,
    'primeiro_nome', initcap(split_part(lower(v_nome), ' ', 1)),
    'resposta', p.resposta, 'respondeu', p.respondeu_em is not null,
    'itens', public.pmarc_itens(p.chave), 'faltam', v_faltam,
    'aviso', public.pmarc_texto('previsao_marcacao_aviso'), 'final', public.pmarc_texto('previsao_marcacao_final'),
    'conversa', case when p.conversa_id is not null and v_tok is not null then jsonb_build_object('id', p.conversa_id, 'token', v_tok) end);
end $function$;

