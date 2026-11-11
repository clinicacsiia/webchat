-- public.paciente_aviso_resolver(p_id bigint, p_aplicar boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.paciente_aviso_resolver(p_id bigint, p_aplicar boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a record; c jsonb;
begin
  perform public.pessoa_equipe();
  select * into a from public.paciente_aviso where id = p_id and resolvido_em is null;
  if not found then return jsonb_build_object('ok', true); end if;
  if p_aplicar and a.tipo = 'dado_diferente' then
    c := a.detalhe -> 'campos';
    update public.pacientes set
      email = coalesce(nullif(c -> 'email' ->> 'novo', ''), email),
      dt_nasc = coalesce(public.data_ou_nula(c -> 'dt_nasc' ->> 'novo'), dt_nasc),
      telefones = case when c ? 'telefone' then array_append(telefones, c -> 'telefone' ->> 'novo') else telefones end,
      atualizado_em = now()
     where id = (a.detalhe ->> 'paciente_id')::uuid;
  end if;
  update public.paciente_aviso set resolvido_em = now(), resolvido_por = (select auth.uid()) where id = p_id;
  return jsonb_build_object('ok', true, 'aplicado', p_aplicar and a.tipo = 'dado_diferente');
end $function$;

