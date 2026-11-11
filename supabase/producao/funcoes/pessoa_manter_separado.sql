-- public.pessoa_manter_separado(p_ids_a uuid[], p_ids_b uuid[])
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.pessoa_manter_separado(p_ids_a uuid[], p_ids_b uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare x uuid; y uuid;
begin
  perform public.pessoa_equipe();
  foreach x in array p_ids_a loop
    foreach y in array p_ids_b loop
      if x <> y then
        insert into public.conversa_grupo_recusa (a, b, por) values (least(x, y), greatest(x, y), (select auth.uid()))
          on conflict (a, b) do update set por = excluded.por, em = now();
      end if;
    end loop;
  end loop;
  foreach y in array p_ids_b loop perform public.pessoa_separar(y); end loop;
  return jsonb_build_object('ok', true);
end $function$;

