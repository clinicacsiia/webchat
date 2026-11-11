-- public.horario_trabalho_agora(p_em timestamp with time zone)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.horario_trabalho_agora(p_em timestamp with time zone DEFAULT now())
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c jsonb; l timestamp;
begin
  select valor::jsonb into c from public.config where chave = 'horario_trabalho';
  if c is null then return public.fluxo_equipe_online(); end if;
  l := p_em at time zone coalesce(c ->> 'fuso', 'America/Sao_Paulo');
  return (c -> 'dias') @> to_jsonb(extract(isodow from l)::int)
     and l::time >= (c ->> 'inicio')::time and l::time < (c ->> 'fim')::time;
exception when others then
  return public.fluxo_equipe_online();
end $function$;

