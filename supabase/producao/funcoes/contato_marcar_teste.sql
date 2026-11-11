-- public.contato_marcar_teste(p_contato uuid, p_teste boolean, p_motivo text, p_conversas boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.contato_marcar_teste(p_contato uuid, p_teste boolean, p_motivo text DEFAULT NULL::text, p_conversas boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n integer; r record; v_c integer := 0;
begin
  if not coalesce((select auth.uid()) = any (public.teste_ids('teste_marcadores')), false) then
    raise exception 'Somente a TI marca ou desmarca contato de teste.' using errcode = '42501';
  end if;
  update public.contatos set teste = coalesce(p_teste, false), teste_motivo = case when coalesce(p_teste, false) then coalesce(nullif(btrim(p_motivo), ''), 'teste da TI') end where id = p_contato;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'Contato não encontrado.' using errcode = '22023'; end if;
  if p_conversas and coalesce(p_teste, false) then
    for r in select id from public.conversas where contato_id = p_contato and not teste and not teste_manual loop
      perform public.conversa_marcar_teste_interno(r.id, 'contato de teste'); v_c := v_c + 1;
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'teste', coalesce(p_teste, false), 'conversas_marcadas', v_c);
end $function$;

