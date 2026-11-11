-- public.jornada_atribuir_card(p_card bigint, p_responsavel uuid, p_versao integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_atribuir_card(p_card bigint, p_responsavel uuid, p_versao integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.jornada_card%rowtype;
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if not public.jornada_pode() then raise exception 'Sem permissão para a Jornada.'; end if;
  select * into c from public.jornada_card where id = p_card for update;
  if not found then raise exception 'Card não encontrado.'; end if;
  if c.versao <> p_versao then raise exception 'CONFLITO: o card foi alterado por outra pessoa. Atualize a tela e tente de novo.'; end if;
  if p_responsavel is not null and not exists (select 1 from public.agentes where id = p_responsavel and ativo and papel in ('admin', 'atendente')) then
    raise exception 'Pessoa não encontrada.';
  end if;
  update public.jornada_card set responsavel = p_responsavel, versao = versao + 1, atualizado_em = now() where id = c.id;
  insert into public.jornada_evento (card_id, tipo, origem, usuario, detalhe) values (c.id, 'atribuido', 'pessoa', auth.uid(), jsonb_build_object('responsavel', p_responsavel));
  return jsonb_build_object('ok', true, 'versao', c.versao + 1);
end;
$function$;

