-- public.app_laudos_lista(p_pac uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_laudos_lista(p_pac uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('ok', true,
    'pessoas', (select coalesce(jsonb_agg(jsonb_build_object('nome', p.nome, 'eu', p.eu,
                  'situacao', case when p.cpf is null then 'sem_cpf' when lp.ident_hash is not distinct from p.ih then coalesce(lp.situacao, 'pendente') else 'pendente' end) order by p.ord, p.criado, p.pessoa), '[]'::jsonb)
                  from public.app_laudos_pessoas(p_pac) p left join public.app_laudo_pessoa lp on lp.paciente_id = p_pac and lp.pessoa = p.pessoa),
    'itens', (select coalesce(jsonb_agg(jsonb_build_object('id', l.marcacao_id, 'pessoa', p.nome, 'eu', p.eu, 'nome', l.procedimento, 'data', l.data_exame, 'unidade', l.unidade,
                  'estado', l.estado, 'checado_em', l.checado_em) order by l.data_exame desc nulls last, l.marcacao_id desc), '[]'::jsonb)
                from public.app_laudo l
                join public.app_laudos_pessoas(p_pac) p on p.pessoa = l.pessoa and p.ih = l.ident_hash
                join public.app_laudo_pessoa lp on lp.paciente_id = l.paciente_id and lp.pessoa = l.pessoa and lp.ident_hash = l.ident_hash and lp.situacao = 'confere'
               where l.paciente_id = p_pac
                 and (l.estado <> 'aguardando' or (l.data_exame >= current_date - 30 and coalesce(l.procedimento, '') !~* '^\s*(consulta|retorno)')))   -- sem laudo ainda: só o recente e só o que não é consulta
  )
$function$;

