-- public.painel_app_contas_antigas()
-- Pode executar: authenticated
CREATE OR REPLACE FUNCTION public.painel_app_contas_antigas()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê as contas antigas.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'celular', c.telefone, 'email', c.email, 'criado_em', c.criado_em,
      'ultimo_acesso_em', c.ultimo_acesso_em, 'filhos_no_historico', (select count(*) from public.app_conta_antiga_historico_filhos(c.id))) order by c.criado_em)
    from public.contas_paciente c where not exists (select 1 from public.app_paciente a where a.conta_antiga_id = c.id)), '[]'::jsonb);
end $function$;

