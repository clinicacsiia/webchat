-- public.ind_fechar_pendentes()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ind_fechar_pendentes()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_hoje date := (now() at time zone 'America/Sao_Paulo')::date; v_d date; v_n integer := 0;
begin
  if coalesce((select valor from public.config where chave = 'indicadores_fechar'), 'nao') <> 'sim' then return 0; end if;
  v_d := coalesce((select max(f.dia) + 1 from public.ind_fechamento f), (select min((c.criado_em at time zone 'America/Sao_Paulo')::date) from public.conversas c));
  while v_d is not null and v_d < v_hoje loop
    if public.ind_fechar_dia(v_d) then v_n := v_n + 1; end if;
    v_d := v_d + 1;
  end loop;
  return v_n;
end $function$;

