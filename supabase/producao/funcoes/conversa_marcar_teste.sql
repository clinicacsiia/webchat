-- public.conversa_marcar_teste(p_conversa uuid, p_teste boolean, p_motivo text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conversa_marcar_teste(p_conversa uuid, p_teste boolean, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n integer;
begin
  if not coalesce((select auth.uid()) = any (public.teste_ids('teste_marcadores')), false) then
    raise exception 'Somente a TI marca ou desmarca conversa de teste.' using errcode = '42501';
  end if;
  perform set_config('app.teste_via_funcao', '1', true);
  update public.conversas set teste = coalesce(p_teste, false), teste_manual = not coalesce(p_teste, false),
         teste_motivo = case when coalesce(p_teste, false) then coalesce(nullif(btrim(p_motivo), ''), 'marcada pela TI') end
   where id = p_conversa;
  get diagnostics v_n = row_count;
  perform set_config('app.teste_via_funcao', '', true);
  if v_n = 0 then raise exception 'Conversa não encontrada.' using errcode = '22023'; end if;
  insert into public.conversa_evento (conversa_id, tipo, por, motivo) values (p_conversa, case when coalesce(p_teste, false) then 'teste_marcado' else 'teste_desmarcado' end, (select auth.uid()), nullif(btrim(p_motivo), ''));
  return jsonb_build_object('ok', true, 'teste', coalesce(p_teste, false));
end $function$;

