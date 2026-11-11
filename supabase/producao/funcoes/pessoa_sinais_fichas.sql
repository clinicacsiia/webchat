-- public.pessoa_sinais_fichas(a jsonb, b jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pessoa_sinais_fichas(a jsonb, b jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare s text[] := '{}'; k text[] := '{}'; v_aprox boolean := false;
begin
  if a is null or b is null or not public.nome_confere(a ->> 'nome', b ->> 'nome') then
    return jsonb_build_object('nome', false, 'sinais', '[]'::jsonb, 'conflitos', '[]'::jsonb, 'total', 0);
  end if;
  s := array['nome'];
  if a ->> 'fone' is not null and a ->> 'fone' = b ->> 'fone' then s := array_append(s, 'telefone'::text); end if;
  if a ->> 'email' is not null and a ->> 'email' = b ->> 'email' then s := array_append(s, 'email'::text); end if;
  if a ->> 'nasc' is not null and a ->> 'nasc' = b ->> 'nasc' then s := array_append(s, 'nascimento'::text); end if;
  if a ->> 'conta' is not null and a ->> 'conta' = b ->> 'conta' then s := array_append(s, 'conta'::text); end if;
  if a ->> 'nasc' is not null and b ->> 'nasc' is not null and a ->> 'nasc' <> b ->> 'nasc' then
    if public.pessoa_nasc_parecida(a ->> 'nasc', b ->> 'nasc') then v_aprox := true; else k := array_append(k, 'nascimento'::text); end if;
  end if;
  if a ->> 'conta' is not null and b ->> 'conta' is not null and a ->> 'conta' <> b ->> 'conta' then k := array_append(k, 'conta'::text); end if;
  if a ->> 'tipo' <> b ->> 'tipo' then k := array_append(k, 'tipo'::text); end if;
  return jsonb_build_object('nome', true, 'sinais', to_jsonb(s), 'conflitos', to_jsonb(k), 'total', cardinality(s), 'nascimento_parecido', v_aprox);
end $function$;

