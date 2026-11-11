-- public.paciente_klingo(p_conversa uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.paciente_klingo(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_sal text; v_ids uuid[]; v jsonb;
begin
  perform public.pessoa_equipe();
  select valor into v_sal from public.config where chave = 'ia_segredo';
  v_ids := public.pessoa_membros(p_conversa);
  with quem as (
    select distinct encode(sha256(convert_to(right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) || coalesce(v_sal, ''), 'UTF8')), 'hex') as fh,
           public.pessoa_ficha(c.id) ->> 'nome' as nome
      from public.conversas c join public.contatos ct on ct.id = c.contato_id
     where c.id = any (v_ids) and length(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g')) >= 8
  ), pac as (
    select jp.prontuario, jp.nome from public.jornada_paciente jp join quem q on jp.fone_chave = q.fh and public.nome_confere(jp.nome, q.nome)
    union
    select jp.prontuario, jp.nome from public.pessoa_klingo_vinculo vk join public.jornada_paciente jp on jp.prontuario = vk.prontuario where vk.conversa_id = any (v_ids)
  )
  select jsonb_build_object(
    'pacientes', (select coalesce(jsonb_agg(jsonb_build_object('prontuario', p.prontuario, 'nome', p.nome)), '[]'::jsonb) from pac p),
    'exames', (select coalesce(jsonb_agg(jsonb_build_object('exame', x.procedimento, 'status', x.status, 'quando', x.agendado_para, 'unidade', x.unidade) order by x.agendado_para desc nulls last), '[]'::jsonb)
                 from (select e.procedimento, e.status, e.agendado_para, e.unidade from public.jornada_exame e join public.jornada_card c on c.id = e.card_id
                        where c.paciente_chave in (select prontuario from pac) order by e.agendado_para desc nulls last limit 60) x))
    into v;
  return v;
end $function$;

