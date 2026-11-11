-- public.conta_paciente_adotar_conversas(p_itens jsonb)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_paciente_adotar_conversas(p_itens jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid()); v_cp record; v_email text; v_tel text; v_n int := 0; it jsonb; v_id uuid;
begin
  select * into v_cp from public.contas_paciente where id = v_uid;
  if v_uid is null or not found then raise exception 'Entre na sua conta para guardar as conversas.' using errcode = '42501'; end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' then return 0; end if;
  select lower(btrim(u.email)), public.fone_chave(coalesce(nullif(btrim(v_cp.telefone), ''), u.raw_user_meta_data ->> 'telefone')) into v_email, v_tel from auth.users u where u.id = v_uid;
  for it in select * from jsonb_array_elements(p_itens) limit 30 loop
    begin v_id := (it ->> 'id')::uuid; exception when others then continue; end;
    update public.conversas c set conta_id = v_uid
      from public.conversa_segredo s, public.contatos ct
     where c.id = v_id and s.conversa_id = c.id and s.token = (it ->> 'token') and ct.id = c.contato_id and c.conta_id is null
       and ((v_email is not null and v_email <> '' and (lower(btrim(coalesce(c.email_informado, ''))) = v_email or lower(btrim(coalesce(ct.email, ''))) = v_email))
            or (v_tel is not null and public.fone_chave(ct.telefone) = v_tel));
    if found then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $function$;

