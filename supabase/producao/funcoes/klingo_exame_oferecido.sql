-- public.klingo_exame_oferecido(p_proc integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_exame_oferecido(p_proc integer)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p public.klingo_proc_api; v_tem boolean; v_ult timestamptz; v_h int;
begin
  if public.klingo_cfg('klingo_exames_so_api', 'nao') <> 'sim' then return true; end if;
  if not exists (select 1 from public.klingo_exame_api) then return true; end if;
  if not exists (select 1 from public.klingo_exame_api where id = p_proc) then return false; end if;
  select * into p from public.klingo_proc_api where procedimento_id = p_proc;
  if not found then return false; end if;
  v_tem := p.com_horario_em is not null and (p.vazio_em is null or p.com_horario_em >= p.vazio_em);
  if v_tem then return true; end if;
  v_ult := greatest(p.com_horario_em, p.vazio_em);
  v_h := greatest(1, coalesce(nullif(public.klingo_cfg('klingo_exames_vencimento_h', '6'), '')::int, 6));
  return v_ult < now() - make_interval(hours => v_h);
end $function$;

