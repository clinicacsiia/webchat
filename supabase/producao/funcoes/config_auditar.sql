-- public.config_auditar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.config_auditar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_chave text; v_antes text; v_depois text; v_oculto boolean; v_orig text;
begin
  if tg_op = 'DELETE' then v_chave := old.chave; v_antes := old.valor; v_depois := null;
  elsif tg_op = 'INSERT' then v_chave := new.chave; v_antes := null; v_depois := new.valor;
  else
    if new.valor is not distinct from old.valor then return new; end if;
    v_chave := new.chave; v_antes := old.valor; v_depois := new.valor;
  end if;
  v_oculto := v_chave ~* '(segredo|token|senha|url|vapid|chave_|_key)';
  v_orig := coalesce(nullif(current_setting('app.origem', true), ''), case when auth.uid() is not null then 'painel:' || auth.uid()::text else 'sql:' || current_user::text end);
  insert into public.config_auditoria (chave, valor_antes, valor_depois, operacao, origem, justificativa, versao)
  values (v_chave, case when v_oculto and v_antes is not null then '(oculto)' else left(v_antes, 300) end, case when v_oculto and v_depois is not null then '(oculto)' else left(v_depois, 300) end,
          lower(tg_op), left(v_orig, 120), left(nullif(current_setting('app.justificativa', true), ''), 500), coalesce(nullif(current_setting('app.versao', true), ''), 'webchat-v2.0'));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $function$;

