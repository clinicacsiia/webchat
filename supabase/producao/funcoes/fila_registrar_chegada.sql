-- public.fila_registrar_chegada(p_nome text, p_conta uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_registrar_chegada(p_nome text, p_conta uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_senha int; v_id uuid; v_pac uuid; v_nome text := left(btrim(coalesce(p_nome, '')), 120);
begin
  perform public.fila_equipe_ok();
  if p_conta is not null then
    select paciente_id into v_pac from public.contas_paciente where id = p_conta;
    if not found then raise exception 'Conta de paciente não encontrada.' using errcode = 'P0002'; end if;
    if v_nome = '' then v_nome := coalesce((select nome from public.pacientes where id = v_pac), (select split_part(email, '@', 1) from public.contas_paciente where id = p_conta), ''); end if;
    if exists (select 1 from public.fila_chegada where conta_id = p_conta and status in ('aguardando', 'chamado') and public.fila_dia(chegou_em) = public.fila_dia(now())) then
      raise exception 'Essa pessoa já está na fila.' using errcode = 'P0001';
    end if;
  end if;
  if v_nome = '' then raise exception 'Informe o nome de quem chegou.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('fila_chegada'));
  select coalesce(max(senha), 0) + 1 into v_senha from public.fila_chegada where public.fila_dia(chegou_em) = public.fila_dia(now());
  insert into public.fila_chegada (conta_id, paciente_id, nome, senha, origem) values (p_conta, v_pac, v_nome, v_senha, 'recepcao') returning id into v_id;
  return v_id;
end $function$;

