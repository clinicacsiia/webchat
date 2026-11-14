-- public.disponibilidade_compativel(r disponibilidade_pedido, p_data date, p_hora text, p_unidade text, p_prof text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_compativel(r public.disponibilidade_pedido, p_data date, p_hora text, p_unidade text, p_prof text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select p_data >= (now() at time zone 'America/Bahia')::date and (p_data + p_hora::time) > (now() at time zone 'America/Bahia')
     and p_data between r.data_ini and r.data_fim + case when r.datas_alternativas then 7 else 0 end
     and extract(dow from p_data)::smallint = any (r.dias_semana)
     and case r.turno when 'manha' then p_hora < '12:00' when 'tarde' then p_hora >= '12:00' and p_hora < '18:00' when 'noite' then p_hora >= '18:00' else true end
     and (r.hora_ini is null or p_hora >= r.hora_ini) and (r.hora_fim is null or p_hora <= r.hora_fim)
     and (r.unidade is null or r.aceita_outras_unidades or public.norm_nome(p_unidade) = public.norm_nome(r.unidade))
     and (r.profissional_preferido is null or r.aceita_outros_profissionais or public.klingo_prof_confere(p_prof, r.profissional_preferido))
$function$;

