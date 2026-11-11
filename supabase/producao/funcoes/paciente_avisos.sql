-- public.paciente_avisos()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.paciente_avisos()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.pessoa_equipe();
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'conversa_id', a.conversa_id, 'tipo', a.tipo, 'detalhe', a.detalhe, 'criado_em', a.criado_em,
                    'nome', public.pessoa_ficha(a.conversa_id) ->> 'nome') order by a.criado_em desc)
                     from public.paciente_aviso a where a.resolvido_em is null), '[]'::jsonb);
end $function$;

