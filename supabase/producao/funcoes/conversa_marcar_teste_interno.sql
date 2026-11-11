-- public.conversa_marcar_teste_interno(p_conversa uuid, p_motivo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.conversa_marcar_teste_interno(p_conversa uuid, p_motivo text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n integer;
begin
  perform set_config('app.teste_via_funcao', '1', true);
  update public.conversas set teste = true, teste_motivo = coalesce(teste_motivo, p_motivo) where id = p_conversa and not teste and not teste_manual;
  get diagnostics v_n = row_count;
  perform set_config('app.teste_via_funcao', '', true);
  if v_n > 0 then insert into public.conversa_evento (conversa_id, tipo, motivo) values (p_conversa, 'teste_marcado', p_motivo); end if;
end $function$;

