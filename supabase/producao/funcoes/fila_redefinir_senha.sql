-- public.fila_redefinir_senha(p_id uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_redefinir_senha(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.fila_chegada%rowtype; v_conta uuid; v_email text; v_senha text;
begin
  perform public.fila_equipe_ok();
  select * into r from public.fila_chegada where id = p_id for update;
  if r.id is null then raise exception 'Essa pessoa não está na fila.' using errcode = 'P0002'; end if;
  v_conta := r.conta_id;
  if v_conta is null and coalesce(r.email, '') <> '' then
    select id into v_conta from public.contas_paciente where lower(btrim(email)) = lower(r.email) limit 1;
  end if;
  if v_conta is null then raise exception 'Essa pessoa ainda não tem conta. Use "Criar conta".' using errcode = 'P0002'; end if;
  select email into v_email from public.contas_paciente where id = v_conta;
  if v_email is null then raise exception 'Essa conta não é de paciente.' using errcode = '42501'; end if;
  v_senha := 'csi' || lpad((abs(('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 7))::bit(28)::int) % 10000)::text, 4, '0');
  update auth.users set encrypted_password = extensions.crypt(v_senha, extensions.gen_salt('bf')), updated_at = now() where id = v_conta;
  update auth.sessions set not_after = now() where user_id = v_conta and (not_after is null or not_after > now());
  update public.contas_paciente set senha_provisoria = true, identidade_conferida_em = coalesce(identidade_conferida_em, now()) where id = v_conta;
  if r.conta_id is null and not exists (select 1 from public.fila_chegada where conta_id = v_conta and status in ('aguardando', 'chamado')) then
    update public.fila_chegada set conta_id = v_conta where id = r.id;
  end if;
  update public.fila_chegada set pede_senha = false where id = r.id;
  return jsonb_build_object('ok', true, 'email', v_email, 'senha', v_senha);
end $function$;

