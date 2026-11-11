-- public.conversa_valida_agendado_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.conversa_valida_agendado_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v jsonb; v_txt text;
begin
  if new.status = 'encerrada' and old.status is distinct from 'encerrada' then
    if new.motivo_encerramento = 'agendado'
       and coalesce((select public.papel_atual()), '') <> ''
       and coalesce((select valor from public.config where chave = 'encerramento_valida_agendado'), 'nao') = 'sim' then
      begin
        v := public.agendamento_valido_para_encerrar(new.id);
        insert into public.conversa_agendado_conferencia (conversa_id, situacao, fonte, codigo, exame_em, encerrada_em, verificada_em, tentativas, aviso_texto, avisada_em, push_em)
        values (new.id, case when coalesce((v ->> 'ok')::boolean, false) then 'confirmado' else 'verificando' end, v ->> 'fonte', v ->> 'codigo',
                nullif(v ->> 'ate', '')::timestamptz, now(), now(), 1, null, null, null)
        on conflict (conversa_id) do update set situacao = excluded.situacao, fonte = excluded.fonte, codigo = excluded.codigo, exame_em = excluded.exame_em,
          encerrada_em = excluded.encerrada_em, verificada_em = excluded.verificada_em, tentativas = 1, aviso_texto = null, avisada_em = null, push_em = null;
      exception when others then null;
      end;
    end if;
  elsif old.status = 'encerrada' and new.status is distinct from 'encerrada' then
    select aviso_texto into v_txt from public.conversa_agendado_conferencia where conversa_id = new.id;
    if found then
      delete from public.conversa_agendado_conferencia where conversa_id = new.id;
      if v_txt is not null and new.alerta_agenda = v_txt then new.alerta_agenda := null; end if;
    end if;
  end if;
  return new;
end $function$;

