-- public.conversas_evento_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.conversas_evento_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  begin
    if tg_op = 'INSERT' then
      insert into public.conversa_evento (conversa_id, tipo, em, detalhe) values (new.id, 'criada', coalesce(new.criado_em, now()), jsonb_build_object('unidade', new.unidade_inicial));
    else
      if new.agente_id is distinct from old.agente_id then
        insert into public.conversa_evento (conversa_id, tipo, de_agente, para_agente, por)
        values (new.id, case when old.agente_id is null then 'assumida' when new.agente_id is null then 'devolvida' else 'transferida' end, old.agente_id, new.agente_id, (select auth.uid()));
      end if;
      if new.status is distinct from old.status then
        if new.status = 'encerrada' then
          insert into public.conversa_evento (conversa_id, tipo, motivo, por, detalhe)
          values (new.id, case when new.encerramento_origem = 'inatividade' then 'autoencerrada' else 'encerrada' end, new.motivo_encerramento, new.encerrada_por, jsonb_build_object('origem', new.encerramento_origem));
        elsif old.status = 'encerrada' then
          insert into public.conversa_evento (conversa_id, tipo, por) values (new.id, 'reaberta', (select auth.uid()));
        end if;
      end if;
      if old.primeiro_humano_em is null and new.primeiro_humano_em is not null then
        insert into public.conversa_evento (conversa_id, tipo, em) values (new.id, 'primeiro_humano', new.primeiro_humano_em);
      end if;
    end if;
  exception when others then null;
  end;
  return null;
end $function$;

