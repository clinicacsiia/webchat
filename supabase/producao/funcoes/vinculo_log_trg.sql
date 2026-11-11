-- public.vinculo_log_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.vinculo_log_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  begin
    insert into public.vinculo_log (por, acao, prontuario, conversa_id, antes, depois)
    values ((select auth.uid()), case tg_op when 'INSERT' then 'vinculado' when 'UPDATE' then 'alterado' else 'desfeito' end,
            coalesce(new.prontuario, old.prontuario), coalesce(new.conversa_id, old.conversa_id),
            case when tg_op in ('UPDATE', 'DELETE') then jsonb_build_object('conversa_id', old.conversa_id, 'por', old.por, 'em', old.em) end,
            case when tg_op in ('INSERT', 'UPDATE') then jsonb_build_object('conversa_id', new.conversa_id, 'por', new.por, 'em', new.em) end);
  exception when others then null;
  end;
  return null;
end $function$;

