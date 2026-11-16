-- public.painel_app_codigos()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_app_codigos()
 RETURNS jsonb
 LANGUAGE plpgsql STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê os códigos.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'finalidade', c.finalidade, 'celular', c.telefone, 'nome', c.nome, 'email', c.email, 'codigo', c.codigo, 'criado_em', c.criado_em, 'expira_em', c.expira_em,
      'digitado', c.validado_em is not null, 'tentativas', c.tentativas, 'envio_erro', c.envio_erro,
      'envio', case when c.envio = 'pendente' and c.criado_em < now() - interval '2 minutes' then 'erro' else c.envio end) order by c.criado_em desc)
    from public.app_codigo_email c where c.usado_em is null and c.descartado_em is null and c.expira_em > now()), '[]'::jsonb);
end $function$;

