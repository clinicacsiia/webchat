-- public.conta_paciente_perfil(p_nome text, p_telefone text, p_aceite boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_paciente_perfil(p_nome text, p_telefone text, p_aceite boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_nome text := btrim(coalesce(p_nome, '')); v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
begin
  if (select auth.uid()) is null or not exists (select 1 from public.contas_paciente where id = (select auth.uid())) then
    raise exception 'Entre na sua conta para salvar os dados.' using errcode = '42501';
  end if;
  if char_length(v_nome) not between 2 and 120 then raise exception 'Informe o seu nome.' using errcode = '22023'; end if;
  if char_length(v_tel) in (12, 13) and left(v_tel, 2) = '55' then v_tel := substr(v_tel, 3); end if;
  if char_length(v_tel) not in (10, 11) then raise exception 'Informe um telefone válido com DDD.' using errcode = '22023'; end if;
  update public.contas_paciente set nome = v_nome, telefone = v_tel,
         aceitou_lgpd_em = coalesce(aceitou_lgpd_em, case when coalesce(p_aceite, false) then now() end)
   where id = (select auth.uid());
  return public.conta_paciente_resumo();
end $function$;

