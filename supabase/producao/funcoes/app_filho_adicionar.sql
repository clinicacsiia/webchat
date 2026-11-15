-- public.app_filho_adicionar(p_token text, p_nome text, p_nascimento text, p_mesmo_nome_confirmado boolean)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_filho_adicionar(p_token text, p_nome text, p_nascimento text, p_mesmo_nome_confirmado boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; a public.app_paciente%rowtype; v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')); v_nasc date := public.app_data(p_nascimento); v_c jsonb;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if not public.app_nome_ok(v_nome) then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Informe nome e sobrenome do filho(a).'); end if;
  if v_nasc is null or v_nasc > public.app_hoje() or v_nasc < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Data de nascimento inválida.'); end if;
  select * into a from public.app_paciente where id = s.o_pac;
  v_c := public.app_filho_conflito(a.nome, a.nascimento, v_nome, v_nasc, p_mesmo_nome_confirmado);
  if v_c is not null then return v_c; end if;
  if not exists (select 1 from public.app_filho where responsavel_id = s.o_pac and removido_em is null and nascimento = v_nasc and public.app_norm(nome) = public.app_norm(v_nome)) then
    if (select count(*) from public.app_filho where responsavel_id = s.o_pac and removido_em is null) >= 10 then
      return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Limite de 10 filhos. Fale com a clínica para cadastrar mais.');
    end if;
    insert into public.app_filho (responsavel_id, nome, nascimento) values (s.o_pac, v_nome, v_nasc);
  end if;
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $function$;

