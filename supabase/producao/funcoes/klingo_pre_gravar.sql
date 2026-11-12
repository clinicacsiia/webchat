-- public.klingo_pre_gravar(p_op uuid, p_cpf text, p_nasc date, p_klingo_id text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_pre_gravar(p_op uuid, p_cpf text, p_nasc date, p_klingo_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g');
begin
  if p_klingo_id !~ '^[0-9]+$' then raise exception 'id de pré-cadastro inválido' using errcode = '22023'; end if;
  -- o id fica na operação ANTES de tudo: se a gravação abaixo falhar, o pré-cadastro criado não se perde
  update public.klingo_operacao set detalhe = detalhe || jsonb_build_object('registro_id', p_klingo_id) where id = p_op;
  begin
    insert into public.klingo_identidade (chave, cpf_hash, tipo, klingo_id, situacao, criado_pela_operacao)
    values (public.klingo_hash(v_cpf || '|' || p_nasc::text), public.klingo_hash(v_cpf), 'pre', p_klingo_id, 'pre_cadastro', p_op)
    on conflict (chave) do update set tipo = 'pre', klingo_id = excluded.klingo_id, situacao = 'pre_cadastro', criado_pela_operacao = p_op, conferido_em = now();
  exception when unique_violation then null;
  end;
  perform public.klingo_medir('pre_cadastro_criado');
end $function$;

