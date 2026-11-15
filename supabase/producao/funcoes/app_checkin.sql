-- public.app_checkin(p_token text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_checkin(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s record; a public.app_paciente%rowtype; r public.fila_chegada%rowtype;
  v_nome text; v_email text; v_fone text; v_max int; v_senha int;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select * into a from public.app_paciente where id = s.o_pac;
  if not found then return public.app_erro_json('sessao'); end if;

  v_nome := left(coalesce(nullif(regexp_replace(btrim(coalesce(a.nome, '')), '\s+', ' ', 'g'), ''), 'Paciente'), 120);
  v_email := nullif(lower(btrim(coalesce(a.email, ''))), '');
  v_fone := public.fone_digitos(a.telefone);

  perform pg_advisory_xact_lock(hashtext('fila_chegada'));
  select * into r from public.fila_chegada
   where status in ('aguardando', 'chamado') and public.fila_dia(chegou_em) = public.fila_dia(now())
     and lower(btrim(nome)) = lower(v_nome) and public.fone_chave(telefone) is not distinct from public.fone_chave(v_fone)
   order by chegou_em limit 1;
  if r.id is not null then
    return jsonb_build_object('ok', true) || public.fila_situacao_linha(r) || jsonb_build_object('ticket', r.ticket);
  end if;

  select coalesce(nullif(valor, '')::int, 300) into v_max from public.config where chave = 'checkin_sem_login_max_dia';
  if (select count(*) from public.fila_chegada where conta_id is null and origem = 'paciente' and public.fila_dia(chegou_em) = public.fila_dia(now())) >= coalesce(v_max, 300) then
    raise exception 'Muitos check-ins agora. Avise a recepção.' using errcode = '54000';
  end if;
  select coalesce(max(senha), 0) + 1 into v_senha from public.fila_chegada where public.fila_dia(chegou_em) = public.fila_dia(now());
  insert into public.fila_chegada (nome, senha, origem, email, telefone, pede_senha)
  values (v_nome, v_senha, 'paciente', v_email, v_fone, false) returning * into r;
  return jsonb_build_object('ok', true) || public.fila_situacao_linha(r) || jsonb_build_object('ticket', r.ticket);
end $function$;

