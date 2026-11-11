-- public.pessoa_unir_grupos(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pessoa_unir_grupos(p_conversa uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; v_g uuid; v_n integer := 0;
begin
  select grupo_id into v_g from public.conversa_grupo where conversa_id = p_conversa;
  if v_g is null then return 0; end if;
  for r in select distinct g2.grupo_id as outro
             from public.conversa_grupo g2, lateral (select public.pessoa_sinais(p_conversa, g2.conversa_id) as s) x
            where g2.grupo_id <> v_g and (x.s ->> 'total')::int >= 3 and jsonb_array_length(x.s -> 'conflitos') = 0
  loop
    if exists (select 1 from public.conversa_grupo m1 join public.conversa_grupo m2 on m2.grupo_id = r.outro
                where m1.grupo_id = v_g
                  and (coalesce((public.pessoa_sinais(m1.conversa_id, m2.conversa_id) ->> 'nome')::boolean, false) is not true
                       or jsonb_array_length(public.pessoa_sinais(m1.conversa_id, m2.conversa_id) -> 'conflitos') > 0
                       or exists (select 1 from public.conversa_grupo_recusa x where x.a = least(m1.conversa_id, m2.conversa_id) and x.b = greatest(m1.conversa_id, m2.conversa_id))))
    then continue; end if;
    update public.conversa_grupo set grupo_id = v_g where grupo_id = r.outro;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $function$;

