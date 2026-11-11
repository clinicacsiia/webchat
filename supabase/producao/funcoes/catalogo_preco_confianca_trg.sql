-- public.catalogo_preco_confianca_trg()
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.catalogo_preco_confianca_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.fonte = 'convenio' then
    new.confianca := case when coalesce(new.tabela, '') !~* 'cbhpm' and new.valor >= 10 then 'alta' else 'baixa' end;
  end if;
  return new;
end $function$;

