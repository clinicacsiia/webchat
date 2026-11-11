-- public.jornada_pendencia_resolver(p_chave text, p_resolvida boolean, p_nota text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_pendencia_resolver(p_chave text, p_resolvida boolean, p_nota text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_nota text := nullif(trim(coalesce(p_nota, '')), '');
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if not public.jornada_admin() then raise exception 'Só o administrador resolve pendências.'; end if;
  if p_resolvida and (v_nota is null or char_length(v_nota) < 5) then raise exception 'Escreva o que ficou decidido (mínimo 5 letras).'; end if;
  update public.jornada_pendencia
     set resolvida_em = case when p_resolvida then now() else null end,
         resolvida_por = case when p_resolvida then auth.uid() else null end,
         resolucao = case when p_resolvida then left(v_nota, 1000) else null end
   where chave = p_chave;
  if not found then raise exception 'Pendência não encontrada.'; end if;
  return jsonb_build_object('ok', true);
end;
$function$;

