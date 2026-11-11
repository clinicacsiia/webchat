-- public.conversa_antes_update()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.conversa_antes_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.status is distinct from old.status then
    new.encerrada_em := case when new.status = 'encerrada' then now() else null end;
    if old.status = 'encerrada' and new.status = 'aguardando' then
      new.ia_ativa := true; new.triagem_resumo := null; new.triagem_urgencia := null;
    end if;
    if new.status = 'encerrada' then new.cliente_aguarda_desde := null; end if;
  end if;
  if old.ia_ativa and not new.ia_ativa and new.status <> 'encerrada' then
    new.cliente_aguarda_desde := now();
  end if;
  if new.status = 'encerrada' and old.status is distinct from 'encerrada' then
    if coalesce((select public.papel_atual()), '') <> '' then
      if new.motivo_encerramento is null
         and coalesce((select valor from public.config where chave = 'encerramento_exige_motivo'), 'nao') = 'sim' then
        raise exception 'MOTIVO_OBRIGATORIO: escolha o motivo do encerramento (se a lista não aparecer, atualize a página do painel).' using errcode = 'P0001';
      end if;
      new.encerrada_por := (select auth.uid());
      new.encerramento_origem := 'equipe';
    else
      new.encerramento_origem := coalesce(new.encerramento_origem, 'sistema');
    end if;
  elsif old.status = 'encerrada' and new.status is distinct from 'encerrada' then
    new.motivo_encerramento := null; new.encerrada_por := null; new.encerramento_origem := null;
  end if;
  return new;
end $function$;

