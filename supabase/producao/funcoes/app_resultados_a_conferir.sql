-- public.app_resultados_a_conferir(p_limite integer)
-- Pode executar: ninguém pela API (só o dono/gatilhos/rotinas)
CREATE OR REPLACE FUNCTION public.app_resultados_a_conferir(p_limite integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v jsonb;
begin
  insert into public.app_resultado (paciente_id, conversa_id, exame_id)
  select ac.paciente_id, ac.conversa_id, e.id
    from public.app_conversa ac
    join public.jornada_card jc on jc.conversa_id = ac.conversa_id
    join public.jornada_exame e on e.card_id = jc.id
   where e.status = 'atendido' and e.agendado_para > now() - interval '90 days'
  on conflict (paciente_id, conversa_id, exame_id) do nothing;
  with alvo as (
    select r.id, e.atendimento_id, jc.paciente_chave as prontuario,
           coalesce(case when ac.eu then ap.nascimento end, (select f.nascimento from public.app_filho f where f.responsavel_id = ap.id and f.removido_em is null
                                                              and public.app_norm(f.nome) = public.app_norm(ac.pessoa_nome) limit 1)) as nascimento
      from public.app_resultado r
      join public.app_conversa ac on ac.paciente_id = r.paciente_id and ac.conversa_id = r.conversa_id
      join public.app_paciente ap on ap.id = r.paciente_id
      join public.jornada_exame e on e.id = r.exame_id
      join public.jornada_card jc on jc.id = e.card_id
     where r.estado = 'aguardando' and e.atendimento_id is not null and e.agendado_para > now() - interval '90 days'
       and jc.paciente_chave !~ '^(conv|manual):' and (r.conferido_em is null or r.conferido_em < now() - interval '30 minutes')
     order by r.conferido_em nulls first limit greatest(1, least(coalesce(p_limite, 30), 60))
  ), marca as (
    update public.app_resultado r set conferido_em = now() from alvo where r.id = alvo.id returning r.id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', alvo.id, 'atendimento', alvo.atendimento_id, 'prontuario', alvo.prontuario, 'nascimento', alvo.nascimento)) filter (where alvo.nascimento is not null), '[]'::jsonb)
    into v from alvo;
  return v;
end $function$;

