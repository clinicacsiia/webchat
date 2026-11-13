-- public.klingo_conferir_avisos()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_conferir_avisos()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_novos integer; v_fechados integer;
begin
  with prob as (
    select k.conversa_id, 'klingo_conflito'::text as tipo, k.m, x.campo, (k.paciente_tipo = 'filho') as filho
      from public.klingo_conferencia k cross join lateral unnest(k.conflito) as x(campo)
     where k.conversa_id is not null and k.status_klingo = 'Aberta' and k.marcado_em >= (now() at time zone 'America/Sao_Paulo')::date - 30
    union all
    select k.conversa_id, 'klingo_dado_faltando', k.m, x.campo, (k.paciente_tipo = 'filho')
      from public.klingo_conferencia k cross join lateral unnest(k.falta_no_klingo) as x(campo)
     where k.conversa_id is not null and k.status_klingo = 'Aberta' and k.marcado_em >= (now() at time zone 'America/Sao_Paulo')::date - 30),
  agg as (
    select p.conversa_id, p.tipo,
           jsonb_build_object('marcacoes', jsonb_agg(distinct p.m order by p.m), 'campos', jsonb_agg(distinct p.campo order by p.campo), 'filho', bool_or(p.filho)) as detalhe
      from prob p join public.conversas c on c.id = p.conversa_id and not c.teste
     group by p.conversa_id, p.tipo),
  ins as (
    insert into public.paciente_aviso (conversa_id, tipo, detalhe)
    select a.conversa_id, a.tipo, a.detalhe from agg a
     where not exists (select 1 from public.paciente_aviso r where r.conversa_id = a.conversa_id and r.tipo = a.tipo and r.resolvido_em is not null and r.detalhe = a.detalhe)
    on conflict (conversa_id, tipo) where resolvido_em is null do update set detalhe = excluded.detalhe
    returning 1),
  fim as (
    update public.paciente_aviso a set resolvido_em = now()
     where a.tipo in ('klingo_conflito', 'klingo_dado_faltando') and a.resolvido_em is null
       and not exists (select 1 from agg where agg.conversa_id = a.conversa_id and agg.tipo = a.tipo)
    returning 1)
  select (select count(*) from ins), (select count(*) from fim) into v_novos, v_fechados;
  return jsonb_build_object('avisos_criados_ou_atualizados', v_novos, 'avisos_fechados_sozinhos', v_fechados);
end $function$;

