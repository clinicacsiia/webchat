-- public.chat_opcoes_inicio()
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_opcoes_inicio()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'chave', u.chave, 'catalogo', u.catalogo, 'rotulo', u.rotulo, 'descricao', u.descricao, 'fluxo', u.fluxo,
    'medicos', coalesce((select jsonb_agg(jsonb_build_object('nome', m.nome, 'especialidade', m.especialidade) order by m.nome)
                         from public.unidade_medicos(u.chave) m), '[]'::jsonb)
  ) order by u.ordem), '[]'::jsonb)
  from public.unidade_config u where u.ativo;
$function$;

