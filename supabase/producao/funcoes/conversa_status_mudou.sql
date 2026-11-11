-- public.conversa_status_mudou()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.conversa_status_mudou()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_nome text; v_txt text;
begin
  if new.status is distinct from old.status then
    if new.status = 'em_atendimento' and new.agente_id is not null then
      select nome into v_nome from public.agentes where id = new.agente_id;
      insert into public.mensagens (conversa_id, autor, texto)
      values (new.id, 'sistema', coalesce(v_nome, 'Um atendente') || ' entrou na conversa.');
    elsif new.status = 'encerrada' then
      if new.encerramento_origem = 'inatividade' and coalesce((select valor from public.config where chave = 'despedida_inatividade_ativa'), 'nao') = 'sim'
         and nullif(btrim(coalesce((select valor from public.config where chave = 'despedida_inatividade_texto'), '')), '') is not null then
        select valor into v_txt from public.config where chave = 'despedida_inatividade_texto';
        insert into public.mensagens (conversa_id, autor, texto) values (new.id, 'sistema', btrim(v_txt));
      elsif new.encerramento_origem = 'paciente' then
        null;
      else
        perform public.despedida_publicar(new.id, new.encerrada_em);
      end if;
      insert into public.conversa_encerramento (conversa_id, encerrada_em, motivo, origem, por)
      values (new.id, new.encerrada_em, new.motivo_encerramento, new.encerramento_origem, new.encerrada_por)
      on conflict (conversa_id, encerrada_em) do nothing;
    end if;
  end if;
  return new;
end $function$;

