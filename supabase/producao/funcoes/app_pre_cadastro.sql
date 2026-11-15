-- public.app_pre_cadastro(p_telefone text, p_nome text, p_nascimento text, p_filhos jsonb)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_pre_cadastro(p_telefone text, p_nome text, p_nascimento text, p_filhos jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_nasc date := public.app_data(p_nascimento); v_filhos jsonb := coalesce(p_filhos, '[]'::jsonb); v_f jsonb; v_i integer := 0; v_fd date; v_falta jsonb := '[]'::jsonb;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if v_tel !~ '^[1-9]{2}9[0-9]{8}$' then return jsonb_build_object('ok', false, 'erro', 'celular', 'mensagem', 'Celular inválido. Use DDD + 9 dígitos.'); end if;
  if exists (select 1 from public.app_paciente where telefone = v_tel) then return jsonb_build_object('ok', true, 'situacao', 'tem_pin'); end if;
  if not public.app_nome_ok(v_nome) then return jsonb_build_object('ok', false, 'erro', 'nome', 'mensagem', 'Digite nome e sobrenome completos.'); end if;
  if v_nasc is null or v_nasc > public.app_hoje() or v_nasc < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'nascimento', 'mensagem', 'Data de nascimento inválida.'); end if;
  if public.app_idade(v_nasc) < 18 then return jsonb_build_object('ok', false, 'erro', 'menor', 'mensagem', 'O cadastro principal precisa ser de um maior de 18 anos.'); end if;
  if jsonb_typeof(v_filhos) <> 'array' or jsonb_array_length(v_filhos) > 10 then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Lista de filhos inválida (no máximo 10).'); end if;
  if public.app_cpf_historico(v_tel, v_nome, v_nasc, 'proprio') is null then v_falta := v_falta || jsonb_build_object('pessoa', 'eu'); end if;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_fd := public.app_data(v_f ->> 'nascimento');
    if jsonb_typeof(v_f) <> 'object' or not public.app_nome_ok(v_f ->> 'nome') then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Informe nome e sobrenome do filho(a).'); end if;
    if v_fd is null or v_fd > public.app_hoje() or v_fd < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Data de nascimento do filho(a) inválida.'); end if;
    if public.app_cpf_historico(v_tel, v_f ->> 'nome', v_fd, 'filho') is null then v_falta := v_falta || jsonb_build_object('pessoa', 'filho', 'indice', v_i); end if;
    v_i := v_i + 1;
  end loop;
  return jsonb_build_object('ok', true, 'situacao', 'novo', 'falta', v_falta);
end $function$;

