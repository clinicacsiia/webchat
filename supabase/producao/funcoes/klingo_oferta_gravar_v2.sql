-- public.klingo_oferta_gravar_v2(p_conversa uuid, p_procedimento integer, p_plano integer, p_ofertas jsonb, p_sombra boolean, p_substituir boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_oferta_gravar_v2(p_conversa uuid, p_procedimento integer, p_plano integer, p_ofertas jsonb, p_sombra boolean DEFAULT false, p_substituir boolean DEFAULT true)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n integer;
begin
  if coalesce(p_substituir, true) then delete from public.klingo_oferta where conversa_id = p_conversa and sombra = coalesce(p_sombra, false); end if;
  insert into public.klingo_oferta (conversa_id, chave, procedimento, plano, data, hora, profissional, profissional_id, unidade, unidade_id, ordem_chegada, expira_em, sombra)
  select p_conversa, left(o ->> 'chave', 120), p_procedimento, p_plano, (o ->> 'data')::date, left(o ->> 'hora', 5), left(o ->> 'profissional', 120), left(o ->> 'profissional_id', 20),
         left(o ->> 'unidade', 120), left(o ->> 'unidade_id', 20), coalesce((o ->> 'ordem_chegada')::boolean, false), now() + interval '30 minutes', coalesce(p_sombra, false)
    from jsonb_array_elements(case when jsonb_typeof(p_ofertas) = 'array' then p_ofertas else '[]'::jsonb end) o
   where (o ->> 'data') ~ '^\d{4}-\d{2}-\d{2}$' and (o ->> 'hora') ~ '^\d{2}:\d{2}' and nullif(o ->> 'chave', '') is not null
  on conflict (conversa_id, chave) do update set sombra = excluded.sombra, expira_em = excluded.expira_em;
  get diagnostics v_n = row_count;
  return v_n;
end $function$;

