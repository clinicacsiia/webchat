-- public.app_pendencias_lista(p_pac uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_pendencias_lista(p_pac uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(t.x order by t.ord, t.x ->> 'nome'), '[]'::jsonb) from (
    select 1 as ord, jsonb_build_object('id', 'eu:cpf', 'pessoa', 'eu', 'nome', a.nome, 'campo', 'cpf', 'opcional', false,
             'pergunta', 'Qual é o seu CPF? Assim o chat não pergunta de novo.') as x
      from public.app_paciente a where a.id = p_pac and a.cpf is null
    union all
    select 2, jsonb_build_object('id', 'eu:email', 'pessoa', 'eu', 'nome', a.nome, 'campo', 'email', 'opcional', true,
             'pergunta', 'Qual é o seu e-mail? (opcional, para a clínica falar com você)')
      from public.app_paciente a where a.id = p_pac and a.email is null
    union all
    select 3, jsonb_build_object('id', f.id::text || ':cpf', 'pessoa', f.id, 'nome', f.nome, 'campo', 'cpf', 'opcional', false,
             'pergunta', 'Qual é o CPF de ' || split_part(f.nome, ' ', 1) || '? (se a criança não tiver, o do responsável)')
      from public.app_filho f where f.responsavel_id = p_pac and f.removido_em is null and f.cpf is null
  ) t $function$;

