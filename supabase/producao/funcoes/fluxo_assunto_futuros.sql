-- public.fluxo_assunto_futuros(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_assunto_futuros(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_hist jsonb; r jsonb := '[]'::jsonb; u jsonb; i int := 0; x text;
begin
  v_hist := public.paciente_historico_para_ia(p_conversa);
  if not coalesce((v_hist ->> 'liberado')::boolean, false) then return r; end if;
  for u in select value from jsonb_array_elements(coalesce(v_hist -> 'ultimas', '[]'::jsonb)) loop
    if coalesce((u ->> 'futuro')::boolean, false) and jsonb_array_length(coalesce(u -> 'exames', '[]'::jsonb)) > 0 then
      select string_agg(initcap(lower(coalesce(e ->> 'exame', e ->> 'modalidade'))) || coalesce(' (' || (e ->> 'lado') || ')', ''), ' + ')
        into x from jsonb_array_elements(u -> 'exames') e;
      r := r || jsonb_build_object('idx', i, 'rotulo', x || ' — ' || (u ->> 'quando'), 'item', x || ' de ' || (u ->> 'quando'));
    end if;
    i := i + 1;
  end loop;
  return r;
end $function$;

