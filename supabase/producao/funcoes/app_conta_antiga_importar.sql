-- public.app_conta_antiga_importar(p_conta uuid, p_pac uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_conta_antiga_importar(p_conta uuid, p_pac uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer := 0;
begin
  insert into public.app_conversa (paciente_id, conversa_id, pessoa_nome, eu)
  select p_pac, c.id,
         case when coalesce(c.paciente_tipo, 'proprio') = 'proprio' then a.nome else coalesce(nullif(btrim(c.paciente_nome), ''), 'Filho(a)') end,
         coalesce(c.paciente_tipo, 'proprio') = 'proprio'
    from public.conversas c cross join public.app_paciente a
   where c.conta_id = p_conta and a.id = p_pac
  on conflict (paciente_id, conversa_id) do nothing;
  get diagnostics n = row_count;
  update public.app_conversa ac set visto_em = now(),
         visto_sig = coalesce((select e ->> 'sig' from jsonb_array_elements(public.app_pedido_dados(ac.paciente_id, ac.conversa_id)) e limit 1), md5(''))
   where ac.paciente_id = p_pac and ac.visto_sig is null;
  return n;
end $function$;

