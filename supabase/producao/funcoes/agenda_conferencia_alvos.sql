-- public.agenda_conferencia_alvos(p_lento boolean, p_so_ver boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_conferencia_alvos(p_lento boolean DEFAULT false, p_so_ver boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_alvos jsonb; v_dias jsonb; v_hoje date := (now() at time zone 'America/Bahia')::date;
begin
  select coalesce(jsonb_agg(t.alvo order by t.primeiro), '[]'::jsonb) into v_alvos from (
    select jsonb_build_object(
        'id', pa.id, 'status', pa.status, 'conf', pa.conferencia_status,
        'fones', (select coalesce(jsonb_agg(distinct q.f), '[]'::jsonb) from (
                    select right(regexp_replace(x, '\D', '', 'g'), 8) as f
                    from unnest(array[pa.paciente ->> 'celular', pa.paciente ->> 'telefone', ct.telefone]) x
                    where length(regexp_replace(coalesce(x, ''), '\D', '', 'g')) >= 8) q),
        'nomes', (select coalesce(jsonb_agg(distinct q.n), '[]'::jsonb) from (
                    select public.norm_nome(x) as n from unnest(array[pa.paciente ->> 'nome', c.nome_informado, ct.nome]) x) q where q.n is not null),
        'procs', (select coalesce(jsonb_agg(distinct public.norm_nome(i.procedimento)), '[]'::jsonb)
                  from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and public.norm_nome(i.procedimento) is not null),
        'slots', (select jsonb_agg(jsonb_build_object('idx', s.ord - 1, 'data', s.e ->> 'data', 'hora', s.e ->> 'hora',
                         'prof', coalesce(public.norm_nome(s.e ->> 'profissional'), ''), 'unidade', coalesce(public.norm_nome(s.e ->> 'unidade'), ''),
                         'chegada', coalesce((s.e ->> 'chegada')::boolean, false), 'min', coalesce((s.e ->> 'min')::int, 30)) order by s.ord)
                  from jsonb_array_elements(pa.escolha_horario) with ordinality s(e, ord))
      ) as alvo,
      (select min((e ->> 'data')::date) from jsonb_array_elements(pa.escolha_horario) e) as primeiro
    from public.pre_agendamentos pa
    join public.conversas c on c.id = pa.conversa_id
    join public.contatos ct on ct.id = c.contato_id
    where jsonb_typeof(pa.escolha_horario) = 'array' and jsonb_array_length(pa.escolha_horario) > 0
      and (   (pa.status = 'pronto' and (p_lento or pa.atualizado_em > now() - interval '6 hours'))
           or (pa.status = 'rascunho' and pa.atualizado_em > now() - case when p_lento then interval '7 days' else interval '3 hours' end)
           or (pa.status = 'agendado' and p_lento and pa.conferencia_status in ('confirmado','sumiu','remarcado')))
      and exists (select 1 from jsonb_array_elements(pa.escolha_horario) e where (e ->> 'data')::date >= v_hoje - 1)
  ) t;

  select coalesce(jsonb_agg(d order by d), '[]'::jsonb) into v_dias from (
    select distinct (s ->> 'data') as d from jsonb_array_elements(v_alvos) a, jsonb_array_elements(a -> 'slots') s) q;

  if jsonb_array_length(v_alvos) = 0 then return jsonb_build_object('dias', '[]'::jsonb, 'alvos', '[]'::jsonb); end if;
  if p_so_ver then
    if exists (select 1 from public.agenda_ocupacao_meta where id = 1 and coalesce(conferindo_ate, '-infinity') > now()) then
      return jsonb_build_object('dias', '[]'::jsonb, 'alvos', '[]'::jsonb);
    end if;
  else
    update public.agenda_ocupacao_meta set conferindo_ate = now() + case when p_lento then interval '100 seconds' else interval '45 seconds' end
      where id = 1 and coalesce(conferindo_ate, '-infinity') <= now();
    if not found then return jsonb_build_object('dias', '[]'::jsonb, 'alvos', '[]'::jsonb); end if;
  end if;
  return jsonb_build_object('dias', v_dias, 'alvos', v_alvos);
end $function$;

