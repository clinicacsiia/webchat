-- public.jornada_klingo_pode_mover(p_atual text, p_alvo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_klingo_pode_mover(p_atual text, p_alvo text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  a public.jornada_coluna%rowtype;
  b public.jornada_coluna%rowtype;
  o_atendimento integer;
  o_chegou integer;
begin
  select * into a from public.jornada_coluna where id = p_atual;
  select * into b from public.jornada_coluna where id = p_alvo;
  if a.id is null or b.id is null or b.origem <> 'klingo' or a.id = b.id then
    return false;
  end if;
  select ordem into o_atendimento from public.jornada_coluna where id = 'em_atendimento';
  select ordem into o_chegou from public.jornada_coluna where id = 'chegou';

  if b.etapa = 'excecao' then
    if a.etapa = 'excecao' then
      return false;
    end if;
    return a.ordem < case b.id when 'faltou' then o_chegou else o_atendimento end;
  end if;

  if a.etapa = 'excecao' then
    return true;
  end if;

  if a.id in ('a_confirmar', 'confirmado') and b.id in ('a_confirmar', 'confirmado') then
    return true;
  end if;

  return b.ordem > a.ordem;
end;
$function$;

