-- public.pre_marcacao_atender(p_id uuid, p_fila text, p_obs text DEFAULT NULL::text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.pre_marcacao_atender(p_id uuid, p_fila text, p_obs text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()) in ('admin', 'atendente'), false) is false then
    raise exception 'Sem permissão para as pré-marcações.' using errcode = '42501';
  end if;
  if p_fila not in ('novo', 'em_contato', 'resolvido', 'descartado') then raise exception 'fila_invalida' using errcode = '22023'; end if;
  update public.pre_marcacao
     set fila = p_fila, obs = coalesce(left(p_obs, 2000), obs),
         atendido_por = case when p_fila = 'novo' then null else (select auth.uid()) end,
         atendido_em = case when p_fila = 'novo' then null else now() end,
         atualizado_em = now()
   where id = p_id;
end $function$;

