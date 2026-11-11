-- public.convenio_msg(p_operadora text, p_tipo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.convenio_msg(p_operadora text, p_tipo text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c public.convenio_config; t text;
begin
  select * into c from public.convenio_config where operadora = public.convenio_chave(p_operadora);
  t := case p_tipo
    when 'inativo' then case when c.suspenso_em is not null then (select valor from public.config where chave = 'convenio_suspenso_texto')
                             else coalesce(nullif(btrim(c.mensagem_inativo), ''), public.fluxo_t('convenio_inativo')) end
    when 'varios' then coalesce(nullif(btrim(c.msg_varios), ''), public.fluxo_t('convenio_varios'))
    when 'aviso' then nullif(btrim(c.aviso), '')
  end;
  if t is null then return null; end if;
  return replace(t, '{convenio}', initcap(lower(btrim(p_operadora))));
end $function$;

