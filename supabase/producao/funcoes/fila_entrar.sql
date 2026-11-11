-- public.fila_entrar(p_nome text, p_email text, p_telefone text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_entrar(p_nome text, p_email text, p_telefone text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_nome text := btrim(coalesce(p_nome, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_paciente uuid;
  v_atendimento uuid;
  v_fone text := public.fone_chave(p_telefone);
begin
  perform public.fila_exige_staff();
  if char_length(v_nome) not between 3 and 120 then
    raise exception 'Informe o nome completo do paciente.' using errcode = '22023';
  end if;
  if char_length(v_email) > 200 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'E-mail inválido.' using errcode = '22023';
  end if;

  select p.id into v_paciente from public.pacientes p
   where lower(p.email) = v_email and public.nome_confere(p.nome, v_nome)
   order by p.ultima_visita_em desc limit 1;

  if v_paciente is null then
    insert into public.pacientes (nome, nome_norm, telefones, email)
    values (v_nome, coalesce(public.norm_nome(v_nome), upper(v_nome)),
            case when v_fone is null then '{}'::text[] else array[v_fone] end, v_email)
    returning id into v_paciente;
  else
    update public.pacientes set ultima_visita_em = now(), atualizado_em = now(),
           telefones = case when v_fone is null or v_fone = any(telefones) then telefones else telefones || v_fone end
     where id = v_paciente;
  end if;

  begin
    insert into public.atendimentos (paciente_id, email_informado) values (v_paciente, v_email) returning id into v_atendimento;
  exception when unique_violation then
    raise exception 'Este paciente já está na fila ou em atendimento.' using errcode = '23505';
  end;

  perform public.fila_avisar_n8n(v_atendimento);
  return jsonb_build_object('atendimento_id', v_atendimento, 'paciente_id', v_paciente);
end $function$;

