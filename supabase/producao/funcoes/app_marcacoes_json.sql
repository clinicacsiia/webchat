-- public.app_marcacoes_json(p_pac uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_marcacoes_json(p_pac uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'grupo', m.grupo, 'pessoa_id', coalesce(m.filho_id::text, 'eu'), 'pessoa_nome', m.pessoa_nome,
    'pessoa_nascimento', m.pessoa_nascimento, 'exame', m.exame, 'data', m.data_preferida, 'turno', m.turno, 'obs', m.obs, 'status', m.status, 'criado_em', m.criado_em)
    order by m.criado_em desc, m.id), '[]'::jsonb)
  from (select * from public.app_marcacao where responsavel_id = p_pac and status <> 'cancelada' order by criado_em desc limit 100) m $function$;

