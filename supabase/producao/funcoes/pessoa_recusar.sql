-- public.pessoa_recusar(p_a uuid, p_b uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.pessoa_recusar(p_a uuid, p_b uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.pessoa_equipe();
  if p_a is null or p_b is null or p_a = p_b then raise exception 'Escolha duas conversas diferentes.' using errcode = '22023'; end if;
  insert into public.conversa_grupo_recusa (a, b, por) values (least(p_a, p_b), greatest(p_a, p_b), (select auth.uid())) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $function$;

