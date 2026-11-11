-- public.agendado_vigiar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agendado_vigiar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r record; v jsonb; v_ok boolean; v_cod text; v_ate timestamptz; v_txt text;
  v_prazo integer := coalesce((select case when valor ~ '^\d+$' then valor::integer end from public.config where chave = 'agendado_conferir_prazo_min'), 120);
  v_confirmadas integer := 0; v_avisos integer := 0; v_push integer := 0; v_url text; v_seg text; v_erro text;
begin
  if not pg_try_advisory_xact_lock(hashtext('agendado_vigiar')) then return jsonb_build_object('pulou', true); end if;
  v_prazo := greatest(v_prazo, 1);

  for r in
    select k.*, c.status as conv_status, c.motivo_encerramento from public.conversa_agendado_conferencia k
      join public.conversas c on c.id = k.conversa_id
     where k.situacao <> 'concluido'
     order by k.encerrada_em limit 200
  loop
    begin
      if r.conv_status <> 'encerrada' or coalesce(r.motivo_encerramento, '') <> 'agendado' then
        update public.conversa_agendado_conferencia set situacao = 'concluido' where conversa_id = r.conversa_id;
        continue;
      end if;
      if r.situacao = 'confirmado' and (r.fonte is distinct from 'klingo' or r.exame_em is null or r.exame_em < now() - interval '1 day') then
        update public.conversa_agendado_conferencia set situacao = 'concluido' where conversa_id = r.conversa_id;
        continue;
      end if;
      if r.situacao = 'problema' and r.encerrada_em < now() - interval '7 days' then
        update public.conversa_agendado_conferencia set situacao = 'concluido' where conversa_id = r.conversa_id;
        continue;
      end if;

      v := public.agendamento_valido_para_encerrar(r.conversa_id);
      v_ok := coalesce((v ->> 'ok')::boolean, false); v_cod := v ->> 'codigo'; v_ate := nullif(v ->> 'ate', '')::timestamptz; v_txt := null;

      if v_ok then
        if r.situacao in ('verificando', 'problema') then
          update public.conversa_agendado_conferencia set situacao = 'confirmado', fonte = v ->> 'fonte', codigo = null, exame_em = v_ate, aviso_texto = null,
            verificada_em = now(), tentativas = tentativas + 1 where conversa_id = r.conversa_id;
          if r.aviso_texto is not null then
            update public.conversas set alerta_agenda = null where id = r.conversa_id and alerta_agenda = r.aviso_texto;
          end if;
          v_confirmadas := v_confirmadas + 1;
        else
          if v_ate is not null and v_ate <> r.exame_em and r.exame_em > now() then
            v_txt := 'O agendamento mudou no Klingo: agora é em ' || to_char(v_ate at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24:MI') || '. Avise o paciente se for preciso.';
          end if;
          update public.conversa_agendado_conferencia set exame_em = coalesce(v_ate, exame_em), verificada_em = now(), tentativas = tentativas + 1 where conversa_id = r.conversa_id;
        end if;
      else
        if r.situacao = 'verificando' and now() - r.encerrada_em >= make_interval(mins => v_prazo) then
          v_txt := case v_cod
            when 'AGENDADO_AGENDA_INDISPONIVEL' then 'Encerrada como Agendado, mas não consegui conferir a agenda (a leitura do Klingo está com problema). Confira no Klingo.'
            when 'AGENDADO_AMBIGUO' then 'Encerrada como Agendado, mas há mais de um paciente possível no Klingo. Confira qual é o agendamento.'
            else 'Encerrada como Agendado, mas não achei o agendamento no Klingo. Confira se o horário foi marcado.' end;
        elsif r.situacao = 'confirmado' and v_cod = 'AGENDADO_SEM_AGENDAMENTO' and r.exame_em > now() + interval '2 hours' then
          v_txt := 'O agendamento mudou no Klingo: o exame não está mais agendado (cancelado ou remarcado?). Confira com o paciente.';
        end if;
        update public.conversa_agendado_conferencia set codigo = v_cod, verificada_em = now(), tentativas = tentativas + 1 where conversa_id = r.conversa_id;
      end if;

      if v_txt is not null then
        update public.conversa_agendado_conferencia set situacao = 'problema', aviso_texto = left(v_txt, 300), avisada_em = now(), push_em = null where conversa_id = r.conversa_id;
        update public.conversas set alerta_agenda = left(v_txt, 300), atualizado_em = now() where id = r.conversa_id;
        v_avisos := v_avisos + 1;
      end if;
    exception when others then
      v_erro := coalesce(v_erro || '; ', '') || left(sqlerrm, 80);
    end;
  end loop;

  begin
    if public.horario_trabalho_agora() then
      with alvo as (
        select conversa_id from public.conversa_agendado_conferencia where situacao = 'problema' and avisada_em is not null and push_em is null),
      marca as (
        update public.conversa_agendado_conferencia k set push_em = now() from alvo where k.conversa_id = alvo.conversa_id returning k.conversa_id)
      select count(distinct (array(select m from unnest(public.pessoa_membros(conversa_id)) m order by m))[1]) into v_push from marca;
      if v_push > 0 then
        select valor into v_url from public.config where chave = 'equipe_push_url';
        v_seg := public.fila_aviso_segredo();
        if coalesce(v_url, '') <> '' and coalesce(v_seg, '') <> '' then
          perform net.http_post(url := v_url, body := jsonb_build_object('tipo', 'agenda', 'quantidade', v_push),
                                headers := jsonb_build_object('Content-Type', 'application/json', 'x-fila-aviso-segredo', v_seg));
        end if;
      end if;
    end if;
  exception when others then
    v_erro := coalesce(v_erro || '; ', '') || 'push: ' || left(sqlerrm, 80);
  end;
  return jsonb_build_object('confirmadas', v_confirmadas, 'avisos', v_avisos, 'push', v_push, 'erro', v_erro);
end $function$;

