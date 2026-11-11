-- public.pessoa_klingo_confirmar(p_prontuario text, p_conversa uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.pessoa_klingo_confirmar(p_prontuario text, p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.pessoa_equipe();
  if not exists (select 1 from public.jornada_paciente where prontuario = p_prontuario) then raise exception 'Paciente não encontrado na Jornada.' using errcode = '22023'; end if;
  if not exists (select 1 from public.conversas where id = p_conversa) then raise exception 'Conversa não encontrada.' using errcode = '22023'; end if;
  insert into public.pessoa_klingo_vinculo (prontuario, conversa_id, por) values (p_prontuario, p_conversa, (select auth.uid()))
  on conflict (prontuario) do update set conversa_id = excluded.conversa_id, por = excluded.por, em = now();
  return jsonb_build_object('ok', true);
end $function$;

