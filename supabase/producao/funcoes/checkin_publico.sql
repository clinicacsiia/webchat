-- public.checkin_publico(p_nome text, p_email text, p_telefone text, p_ajuda_senha boolean)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.checkin_publico(p_nome text, p_email text, p_telefone text, p_ajuda_senha boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_nome text := regexp_replace(btrim(coalesce(p_nome, '')), '\s+', ' ', 'g'); v_email text := lower(btrim(coalesce(p_email, '')));
        v_fone text := public.fone_digitos(p_telefone); v_max int; v_senha int; v_conta boolean; r public.fila_chegada%rowtype;
begin
  if char_length(v_nome) not between 5 and 120 or position(' ' in v_nome) = 0 then raise exception 'Digite o nome completo.' using errcode = '22023'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 200 then raise exception 'Digite um e-mail válido.' using errcode = '22023'; end if;
  if v_fone is null then raise exception 'Digite o celular com DDD.' using errcode = '22023'; end if;
  select exists (select 1 from public.contas_paciente cp where lower(btrim(cp.email)) = v_email and public.fone_chave(cp.telefone) = public.fone_chave(v_fone)) into v_conta;
  if v_conta and not coalesce(p_ajuda_senha, false) then
    return jsonb_build_object('situacao', 'conta_existente', 'email', v_email);
  end if;
  perform pg_advisory_xact_lock(hashtext('fila_chegada'));
  select * into r from public.fila_chegada where status in ('aguardando', 'chamado') and public.fila_dia(chegou_em) = public.fila_dia(now())
     and lower(email) = v_email and public.fone_chave(telefone) = public.fone_chave(v_fone) order by chegou_em limit 1;
  if r.id is not null then
    if coalesce(p_ajuda_senha, false) and not r.pede_senha then update public.fila_chegada set pede_senha = true where id = r.id; r.pede_senha := true; end if;
    return public.fila_situacao_linha(r) || jsonb_build_object('ticket', r.ticket);
  end if;
  select coalesce(nullif(valor, '')::int, 300) into v_max from public.config where chave = 'checkin_sem_login_max_dia';
  if (select count(*) from public.fila_chegada where conta_id is null and origem = 'paciente' and public.fila_dia(chegou_em) = public.fila_dia(now())) >= coalesce(v_max, 300) then
    raise exception 'Muitos check-ins agora. Avise a recepção.' using errcode = '54000';
  end if;
  select coalesce(max(senha), 0) + 1 into v_senha from public.fila_chegada where public.fila_dia(chegou_em) = public.fila_dia(now());
  insert into public.fila_chegada (nome, senha, origem, email, telefone, pede_senha)
  values (v_nome, v_senha, 'paciente', v_email, v_fone, v_conta and coalesce(p_ajuda_senha, false)) returning * into r;
  return public.fila_situacao_linha(r) || jsonb_build_object('ticket', r.ticket);
end $function$;

