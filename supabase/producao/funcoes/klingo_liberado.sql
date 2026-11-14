-- public.klingo_liberado(p_conversa uuid, p_proc integer, p_tipo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_liberado(p_conversa uuid, p_proc integer, p_tipo text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if public.klingo_cfg('klingo_so_liberados', 'nao') <> 'sim' then return true; end if;
  if not public.klingo_ativo(p_conversa, 'klingo_api_horarios') then return true; end if;   -- o filtro acompanha a API de HORÁRIOS (não a marcação): fora dela a lista é a de sempre
  if p_tipo = 'consulta' then
    return exists (select 1 from public.klingo_especialidade e where e.liberada_api and p_proc = any (e.procedimentos));
  end if;
  -- exame: só some se o Klingo foi consultado há menos de 7 dias e NÃO tinha horário; exame ainda não consultado continua aparecendo
  return not exists (select 1 from public.klingo_proc_api a where a.procedimento_id = p_proc and a.vazio_em > now() - interval '7 days'
                       and (a.com_horario_em is null or a.com_horario_em < a.vazio_em));
end $function$;

