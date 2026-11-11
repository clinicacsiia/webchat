-- public.agenda_medica_painel()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.agenda_medica_painel()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (select public.papel_atual()) is null or (select public.papel_atual()) not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(q) order by q.bloqueado desc, q.nome) from (
    with base as (
      select public.norm_nome(a.profissional) as chave, a.profissional as nome
      from public.catalogo_agenda a join public.catalogo_procedimento p on p.id = a.procedimento_id
      where p.classe = 'CONSULTAS' and a.vig_fim >= current_date and a.profissional !~* '(teste|^eletro)' and coalesce(a.especialidade, '') !~* 'anestesi'
      union
      select b.profissional, b.nome from public.profissional_bloqueio b
    ), prof as (select chave, min(nome) as nome from base group by chave)
    select pr.nome,
      (b.profissional is not null) as bloqueado, b.motivo, b.bloqueado_em, b.bloqueado_por_nome,
      (select string_agg(distinct initcap(lower(a.especialidade)), ' / ') from public.catalogo_agenda a
        where public.norm_nome(a.profissional) = pr.chave and a.vig_fim >= current_date and a.especialidade is not null) as especialidade,
      (select max(a.vig_fim) from public.catalogo_agenda a where public.norm_nome(a.profissional) = pr.chave) as vigencia_ate,
      (select string_agg(g.un || ': ' || g.dias, ' | ' order by g.un) from (
          select regexp_replace(d.unidade, '^CLÍNICA DE SAÚDE E IMAGEM - ', '') as un,
                 string_agg(d.txt, '; ' order by d.dia_num, d.hora_ini) as dias
          from (select distinct a.unidade, a.dia_num, a.hora_ini,
                       (array['dom','seg','ter','qua','qui','sex','sáb'])[a.dia_num + 1] || ' ' || left(a.hora_ini, 5) || '–' || left(a.hora_fim, 5) as txt
                from public.catalogo_agenda a join public.catalogo_procedimento p on p.id = a.procedimento_id
                where public.norm_nome(a.profissional) = pr.chave and a.vig_fim >= current_date and p.classe = 'CONSULTAS') d
          group by 1) g) as grade,
      (select count(*) from (
          select distinct h.data, h.hora, h.unidade
          from (select distinct a.procedimento_id as pid from public.catalogo_agenda a join public.catalogo_procedimento p on p.id = a.procedimento_id
                 where public.norm_nome(a.profissional) = pr.chave and p.classe = 'CONSULTAS' and a.vig_fim >= current_date) pp
          cross join lateral public.agenda_horarios(array[pp.pid], current_date, current_date + 14, null, pr.nome, null, '[]'::jsonb, 0) h) z) as livres_14d,
      (select count(*) from public.pre_agendamentos pa join public.conversas c on c.id = pa.conversa_id
        where pa.status not in ('agendado', 'cancelado') and c.status <> 'encerrada'
          and (public.norm_nome(pa.profissional) = pr.chave or public.norm_nome(c.medico_preferido) = pr.chave
               or exists (select 1 from jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e where public.norm_nome(e ->> 'profissional') = pr.chave))) as em_andamento
    from prof pr left join public.profissional_bloqueio b on b.profissional = pr.chave) q), '[]'::jsonb);
end $function$;

