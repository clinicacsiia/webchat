-- public.klingo_horarios_motivo(p_conversa uuid, p_motivo text, p_detalhe text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_horarios_motivo(p_conversa uuid, p_motivo text, p_detalhe text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_motivo is null then
    delete from public.klingo_horarios_falha where conversa_id = p_conversa;
    update public.conversas set alerta_agenda = null where id = p_conversa and alerta_agenda = 'Sem horário no Klingo';
  else
    insert into public.klingo_horarios_falha (conversa_id, motivo, detalhe, em)
    values (p_conversa, left(btrim(p_motivo), 60), left(nullif(btrim(coalesce(p_detalhe, '')), ''), 200), now())
    on conflict (conversa_id) do update set motivo = excluded.motivo, detalhe = excluded.detalhe, em = excluded.em;
    if p_motivo = 'api_sem_horario' then
      update public.conversas set alerta_agenda = 'Sem horário no Klingo' where id = p_conversa and alerta_agenda is null and encerrada_em is null;
    end if;
  end if;
exception when foreign_key_violation then null;
end $function$;

