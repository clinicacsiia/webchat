-- public.paciente_klingo_ligar_pendentes()
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.paciente_klingo_ligar_pendentes()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; v_n integer := 0;
begin
  for r in select c.id from public.conversas c
            where c.criado_em > now() - interval '30 days'
              and not exists (select 1 from public.pessoa_klingo_vinculo v where v.conversa_id = any (public.pessoa_membros(c.id)))
              and not exists (select 1 from public.paciente_aviso a where a.conversa_id = c.id and a.tipo in ('klingo_ligado', 'klingo_varios'))
            order by c.criado_em desc limit 200 loop
    begin v_n := v_n + public.paciente_klingo_ligar(r.id); exception when others then null; end;
  end loop;
  return v_n;
end $function$;

