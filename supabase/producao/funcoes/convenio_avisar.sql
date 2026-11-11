-- public.convenio_avisar(p_conversa uuid, p_operadora text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.convenio_avisar(p_conversa uuid, p_operadora text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c public.convenio_config; n int; m text;
begin
  if public.convenio_chave(p_operadora) ~ '^(|PARTICULAR.*)$' then return; end if;
  select * into c from public.convenio_config where operadora = public.convenio_chave(p_operadora);
  if not found then return; end if;
  m := public.convenio_msg(p_operadora, 'aviso');
  if m is not null then perform public.fluxo_dizer(p_conversa, m); end if;
  if c.um_por_vez then
    select count(*) into n from public.pre_agendamento_itens where conversa_id = p_conversa and ativo;
    if n > 1 then
      perform public.fluxo_dizer(p_conversa, public.convenio_msg(p_operadora, 'varios'));
      perform public.fluxo_nota(p_conversa, 'Convênio ' || initcap(lower(btrim(p_operadora))) || ' faz um exame por vez e o pedido tem ' || n || ' exames: combinar a ordem com o paciente');
    end if;
  end if;
end $function$;

