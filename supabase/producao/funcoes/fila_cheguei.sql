-- public.fila_cheguei()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_cheguei()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid()); c public.contas_paciente%rowtype; v_nome text; v_senha int;
begin
  if v_uid is null then raise exception 'Entre na sua conta para avisar que chegou.' using errcode = '28000'; end if;
  if coalesce((select valor from public.config where chave = 'fila_autochegada'), 'sim') <> 'sim' then
    raise exception 'Avise a recepção que você chegou.' using errcode = 'P0001';
  end if;
  select * into c from public.contas_paciente where id = v_uid;
  if not found then raise exception 'Só pacientes com conta podem avisar a chegada.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('fila_chegada'));
  update public.fila_chegada set status = 'cancelado', concluido_em = now() where conta_id = v_uid and status in ('aguardando', 'chamado') and public.fila_dia(chegou_em) < public.fila_dia(now());
  if not exists (select 1 from public.fila_chegada where conta_id = v_uid and status in ('aguardando', 'chamado')) then
    select nome into v_nome from public.pacientes where id = c.paciente_id;
    v_nome := coalesce(nullif(btrim(v_nome), ''), nullif(btrim(coalesce((select raw_user_meta_data ->> 'nome' from auth.users where id = v_uid), '')), ''), split_part(coalesce(c.email, 'Paciente'), '@', 1));
    select coalesce(max(senha), 0) + 1 into v_senha from public.fila_chegada where public.fila_dia(chegou_em) = public.fila_dia(now());
    insert into public.fila_chegada (conta_id, paciente_id, nome, senha, origem) values (v_uid, c.paciente_id, left(v_nome, 120), v_senha, 'paciente');
  end if;
  return public.fila_minha_vez();
end $function$;

