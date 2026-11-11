-- public.fluxo_ctx(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_ctx(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c record; v_nome text; v_pac text; v_filho boolean;
begin
  select coalesce(nullif(btrim(cv.nome_informado), ''), ct.nome) as nome, cv.paciente_tipo, cv.paciente_nome, cv.irmaos, cv.irmaos_modo
    into c from public.conversas cv join public.contatos ct on ct.id = cv.contato_id where cv.id = p_conversa;
  v_nome := initcap(lower(split_part(btrim(coalesce(c.nome, '')), ' ', 1)));
  v_filho := c.paciente_tipo = 'filho';
  v_pac := initcap(lower(split_part(btrim(coalesce(c.paciente_nome, '')), ' ', 1)));
  if v_filho and v_pac = '' then v_pac := 'seu filho(a)'; end if;
  return jsonb_build_object('nome', v_nome, 'paciente', v_pac, 'filho', v_filho,
    'quem', case when v_filho then v_pac else 'você' end,
    'de_quem', case when v_filho then ' de ' || v_pac else '' end,
    'para_quem', case when v_filho then ' para ' || v_pac else '' end,
    'irmao', coalesce(initcap(lower(split_part(btrim(c.irmaos ->> 0), ' ', 1))), ''));
end $function$;

