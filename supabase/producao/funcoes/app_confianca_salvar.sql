-- public.app_confianca_salvar(p_token text, p_nome text, p_telefone text, p_relacao text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_confianca_salvar(p_token text, p_nome text, p_telefone text, p_relacao text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')); v_meu text;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select telefone into v_meu from public.app_paciente where id = s.o_pac;
  if length(v_nome) < 2 or length(v_nome) > 120 then return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Informe o nome do contato.'); end if;
  if v_tel !~ '^[1-9]{2}9[0-9]{8}$' then return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Celular inválido. Use DDD + 9 dígitos.'); end if;
  if v_tel = v_meu then return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Use um número diferente do seu.'); end if;
  if coalesce(p_relacao, '') not in ('Cônjuge', 'Pai/Mãe', 'Avó/Avô', 'Irmão(ã)', 'Outro') then return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Escolha a relação.'); end if;
  if exists (select 1 from public.app_contato_confianca where responsavel_id = s.o_pac and telefone = v_tel and removido_em is null) then
    update public.app_contato_confianca set nome = v_nome, relacao = p_relacao where responsavel_id = s.o_pac and telefone = v_tel and removido_em is null;
  else
    if (select count(*) from public.app_contato_confianca where responsavel_id = s.o_pac and removido_em is null) >= 5 then
      return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Limite de 5 números de confiança.');
    end if;
    insert into public.app_contato_confianca (responsavel_id, nome, telefone, relacao, codigo) values (s.o_pac, v_nome, v_tel, p_relacao, public.app_confianca_gerar_codigo());
  end if;
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $function$;

