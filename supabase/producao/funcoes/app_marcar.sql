-- public.app_marcar(p_token text, p_pessoas jsonb, p_exame text, p_data text, p_turno text, p_obs text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_marcar(p_token text, p_pessoas jsonb, p_exame text, p_data text, p_turno text, p_obs text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; a public.app_paciente%rowtype; v_data date := public.app_data(p_data); v_grupo uuid := gen_random_uuid(); v_obs text := nullif(btrim(coalesce(p_obs, '')), '');
        v_exame text := btrim(coalesce(p_exame, '')); e text; f public.app_filho%rowtype; v_vistos text[] := '{}';
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if jsonb_typeof(coalesce(p_pessoas, 'null'::jsonb)) <> 'array' or jsonb_array_length(p_pessoas) not between 1 and 11 then
    return jsonb_build_object('ok', false, 'erro', 'pessoas', 'mensagem', 'Escolha para quem é a marcação.');
  end if;
  if length(v_exame) not between 1 and 80 then return jsonb_build_object('ok', false, 'erro', 'exame', 'mensagem', 'Escolha o exame ou a consulta.'); end if;
  if v_data is null or v_data < public.app_hoje() or v_data > public.app_hoje() + 730 then return jsonb_build_object('ok', false, 'erro', 'data', 'mensagem', 'Escolha uma data a partir de hoje.'); end if;
  if coalesce(p_turno, '') not in ('Qualquer horário', 'Manhã', 'Tarde') then return jsonb_build_object('ok', false, 'erro', 'turno', 'mensagem', 'Escolha o turno.'); end if;
  if v_obs is not null and length(v_obs) > 500 then return jsonb_build_object('ok', false, 'erro', 'obs', 'mensagem', 'A observação pode ter até 500 letras.'); end if;
  select * into a from public.app_paciente where id = s.o_pac;
  if (select count(distinct grupo) from public.app_marcacao where responsavel_id = a.id and status = 'solicitada') >= 30 then
    return jsonb_build_object('ok', false, 'erro', 'limite', 'mensagem', 'Você já tem 30 solicitações aguardando. Cancele alguma ou fale com a clínica.');
  end if;
  for e in select jsonb_array_elements_text(p_pessoas) loop
    if e = any (v_vistos) then continue; end if;
    v_vistos := v_vistos || e;
    if e = 'eu' then
      insert into public.app_marcacao (grupo, responsavel_id, filho_id, pessoa_nome, pessoa_nascimento, exame, data_preferida, turno, obs)
      values (v_grupo, a.id, null, a.nome, a.nascimento, v_exame, v_data, p_turno, v_obs);
    elsif e ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into f from public.app_filho where id = e::uuid and responsavel_id = a.id and removido_em is null;
      if not found then raise exception 'pessoa_invalida' using errcode = 'P0001'; end if;
      insert into public.app_marcacao (grupo, responsavel_id, filho_id, pessoa_nome, pessoa_nascimento, exame, data_preferida, turno, obs)
      values (v_grupo, a.id, f.id, f.nome, f.nascimento, v_exame, v_data, p_turno, v_obs);
    else
      raise exception 'pessoa_invalida' using errcode = 'P0001';
    end if;
  end loop;
  update public.app_paciente set ultima_selecao = p_pessoas where id = a.id;
  return jsonb_build_object('ok', true, 'grupo', v_grupo, 'perfil', public.app_perfil_json(a.id));
exception when sqlstate 'P0001' then
  if sqlerrm = 'pessoa_invalida' then return jsonb_build_object('ok', false, 'erro', 'pessoas', 'mensagem', 'Pessoa não encontrada no seu cadastro.'); end if;
  raise;
end $function$;

