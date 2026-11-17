-- public.painel_pmarc_resumo()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_pmarc_resumo()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê a previsão.' using errcode = '42501'; end if;
  return (
    select jsonb_build_object(
      'ligado', public.pmarc_ligada(),
      'total', count(*), 'sem_celular', count(*) filter (where x.sem_cel),
      'link_enviado', count(*) filter (where x.link_enviado_em is not null),
      'abriram', count(*) filter (where x.primeiro_acesso_em is not null),
      'responderam', count(*) filter (where x.resposta is not null),
      'nao_sei', count(*) filter (where x.resposta = 'nao_sei'),
      'com_conversa', count(*) filter (where x.conversa_id is not null))
    from (
      select p.*, (public.pmarc_telefone(p.celular) is null and public.pmarc_telefone(p.telefone) is null and public.pmarc_telefone(p.informado ->> 'celular') is null) as sem_cel
      from public.pmarc_pessoa p
      where p.origem = 'espontaneo' or p.conversa_id is not null
         or exists (select 1 from public.jornada_card c join public.jornada_exame e on e.card_id = c.id
                     where c.paciente_chave = p.chave and e.status in ('agendado', 'confirmado') and e.agendado_para >= now() - interval '3 hours')
    ) x);
end $function$;

