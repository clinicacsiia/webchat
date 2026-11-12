-- public.klingo_oferta_gravar(p_conversa uuid, p_procedimento integer, p_plano integer, p_ofertas jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_oferta_gravar(p_conversa uuid, p_procedimento integer, p_plano integer, p_ofertas jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n integer;
begin
  delete from public.klingo_oferta where conversa_id = p_conversa;
  insert into public.klingo_oferta (conversa_id, chave, procedimento, plano, data, hora, profissional, profissional_id, unidade, unidade_id, ordem_chegada, expira_em)
  select p_conversa, left(o ->> 'chave', 120), p_procedimento, p_plano, (o ->> 'data')::date, left(o ->> 'hora', 5), left(o ->> 'profissional', 120), left(o ->> 'profissional_id', 20),
         left(o ->> 'unidade', 120), left(o ->> 'unidade_id', 20), coalesce((o ->> 'ordem_chegada')::boolean, false), now() + interval '30 minutes'
    from jsonb_array_elements(case when jsonb_typeof(p_ofertas) = 'array' then p_ofertas else '[]'::jsonb end) o
   where (o ->> 'data') ~ '^\d{4}-\d{2}-\d{2}$' and (o ->> 'hora') ~ '^\d{2}:\d{2}' and nullif(o ->> 'chave', '') is not null
  on conflict (conversa_id, chave) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $function$;

