-- public.app_conta_antiga_unir(p_token text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_conta_antiga_unir(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  cp public.contas_paciente%rowtype; p public.pacientes%rowtype; a public.app_paciente%rowtype; s record;
  v_mesma boolean; v_cpf text; v_email text; n integer;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  select * into cp from public.contas_paciente where id = (select auth.uid()) for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'sem_conta', 'mensagem', 'Entre com o e-mail e a senha da sua conta antiga.'); end if;
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select * into a from public.app_paciente where id = s.o_pac for update;
  if not found then return public.app_erro_json('sessao'); end if;
  if a.conta_antiga_id = cp.id then
    return jsonb_build_object('ok', true, 'ja_unida', true, 'conversas', public.app_conta_antiga_importar(cp.id, a.id));
  end if;
  if a.conta_antiga_id is not null or exists (select 1 from public.app_paciente x where x.conta_antiga_id = cp.id) then
    return jsonb_build_object('ok', false, 'erro', 'ja_ligada', 'mensagem', 'Esta conta já está ligada a outro acesso rápido. Fale com a recepção.');
  end if;
  if cp.paciente_id is not null then select * into p from public.pacientes where id = cp.paciente_id; end if;
  v_mesma := (nullif(lower(btrim(coalesce(a.email, ''))), '') is not null and lower(btrim(coalesce(a.email, ''))) = lower(btrim(coalesce(cp.email, ''))))
          or exists (select 1 from unnest(array[cp.telefone] || coalesce(p.telefones, '{}'::text[])) x
                      where x is not null and public.fone_chave(x) is not null and public.fone_chave(x) = public.fone_chave(a.telefone));
  if not v_mesma then
    return jsonb_build_object('ok', false, 'erro', 'outra_pessoa', 'mensagem', 'O celular do seu PIN não é o desta conta antiga. Fale com a recepção para juntar os dois.');
  end if;
  v_cpf := case when a.cpf is null and regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g') ~ '^[0-9]{11}$' and public.fluxo_cpf_ok(regexp_replace(p.cpf, '\D', '', 'g')) then regexp_replace(p.cpf, '\D', '', 'g') end;
  v_email := case when a.email is null and lower(btrim(coalesce(cp.email, ''))) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then lower(btrim(cp.email)) end;
  update public.app_paciente set conta_antiga_id = cp.id, cpf = coalesce(cpf, v_cpf), email = coalesce(email, v_email),
         paciente_sugerido_id = coalesce(paciente_sugerido_id, cp.paciente_id), atualizado_em = now()
   where id = a.id;
  n := public.app_conta_antiga_importar(cp.id, a.id);
  perform public.app_evento_gravar(a.id, 'conta_antiga_unida');
  return jsonb_build_object('ok', true, 'ja_unida', false, 'conversas', n);
end $function$;

