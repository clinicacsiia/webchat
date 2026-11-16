-- public.app_laudos_a_checar(p_pac uuid, p_max integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_laudos_a_checar(p_pac uuid, p_max integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(t.marcacao_id), '[]'::jsonb)
    from (select l.marcacao_id
            from public.app_laudo l
            join public.app_laudos_pessoas(p_pac) p on p.pessoa = l.pessoa and p.ih = l.ident_hash
            join public.app_laudo_pessoa lp on lp.paciente_id = l.paciente_id and lp.pessoa = l.pessoa and lp.ident_hash = l.ident_hash and lp.situacao = 'confere'
           where l.paciente_id = p_pac
             and (l.data_exame is null or l.data_exame >= current_date - 400)
             and (l.checado_em is null or l.checado_em < now() - interval '15 minutes')
             and (l.estado <> 'aguardando' or l.data_exame is null or l.data_exame >= current_date - 45 or l.checado_em is null or l.checado_em < now() - interval '1 day')
           order by (l.checado_em is null) desc, l.data_exame desc nulls last, l.marcacao_id desc
           limit greatest(least(coalesce(p_max, 6), 10), 1)) t
$function$;

