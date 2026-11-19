-- public.ind_equipe_klingo_periodo(p_de date, p_ate date, p_un text, p_teste boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ind_equipe_klingo_periodo(p_de date, p_ate date, p_un text, p_teste boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v jsonb;
begin
  with
  kc as (
    select coalesce(k.via_api, false) as robo,
           (k.status_klingo = 'Cancelada') as cancelada,
           coalesce(nullif(btrim(k.origem), ''), 'sem_origem') as origem
      from public.klingo_conferencia k
      left join public.conversas c on c.id = k.conversa_id
     where k.marcado_em between p_de and p_ate
       and (p_un is null or coalesce(public.unidade_chave(k.unidade), 'sem') = p_un)
       and (p_teste or c.teste is not true)),
  cv as (
    select c.id,
           (select count(*) from public.klingo_conferencia k where k.conversa_id = c.id) as n_marc,
           coalesce((select bool_or(coalesce(k.via_api, false)) from public.klingo_conferencia k where k.conversa_id = c.id), false) as robo
      from public.conversas c
     where c.motivo_encerramento = 'agendado'
       and (c.encerrada_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
       and (p_teste or not c.teste)
       and (p_un is null or coalesce(c.unidade_responsavel, c.unidade_inicial, 'sem') = p_un))
  select jsonb_build_object(
    'klingo', jsonb_build_object(
      'total', (select count(*) from kc),
      'robo', (select count(*) from kc where robo),
      'equipe', (select count(*) from kc where not robo),
      'canceladas', (select count(*) from kc where cancelada),
      'por_origem', coalesce((select jsonb_object_agg(o.origem, o.n) from (select origem, count(*) as n from kc where not robo group by origem) o), '{}'::jsonb)),
    'encerradas', jsonb_build_object(
      'agendado', (select count(*) from cv),
      'com_marcacao', (select count(*) from cv where n_marc > 0),
      'equipe', (select count(*) from cv where n_marc > 0 and not robo),
      'robo', (select count(*) from cv where n_marc > 0 and robo),
      'sem_marcacao', (select count(*) from cv where n_marc = 0))
  ) into v;
  return v;
end $function$;

