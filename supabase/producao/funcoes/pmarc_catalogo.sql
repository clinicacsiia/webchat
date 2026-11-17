-- public.pmarc_catalogo(p_busca text, p_tipo text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.pmarc_catalogo(p_busca text DEFAULT NULL::text, p_tipo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_busca text := nullif(btrim(public.norm_nome(left(coalesce(p_busca, ''), 60))), ''); v_tipo text := nullif(btrim(coalesce(p_tipo, '')), ''); v_itens jsonb;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  if v_tipo is not null and v_tipo not in ('consulta', 'exame', 'outro') then v_tipo := null; end if;
  -- os "feitos" são contados UMA vez (agrupados por nome) e ligados ao catálogo por junção; a versão com subconsulta por procedimento passava de 60 s na produção
  with feitos as (
    select public.norm_nome(e.procedimento) as n, count(*) as c from public.jornada_exame e
     where e.status = 'atendido' and e.agendado_para >= now() - interval '30 days' and e.agendado_para < now() group by 1
  ), com_agenda as (
    select distinct a.procedimento_id from public.catalogo_agenda a where a.vig_fim >= current_date and a.profissional !~* 'teste'
  ), k as (
    select p.id, p.modalidade, public.pmarc_tipo_proc(p.modalidade) as tipo, coalesce(p.demanda_90d, 0) as demanda,
      case when p.modalidade = 'CONSULTA' and public.norm_nome(p.nome) in ('CONSULTA', 'CONSULTA MEDICA') then btrim('Consulta ' || coalesce(initcap(lower(p.especialidade)), '')) else p.nome end as nome,
      public.norm_nome(p.nome) || case when p.modalidade = 'CONSULTA' then '|' || public.norm_nome(coalesce(p.especialidade, '')) else '' end as chave,
      (ca.procedimento_id is not null) as agenda, coalesce(f.c, 0) as feitos
    from public.catalogo_procedimento p
    left join com_agenda ca on ca.procedimento_id = p.id
    left join feitos f on f.n = public.norm_nome(p.nome)
    where p.ativo
      and public.norm_nome(p.nome) !~ 'ACRESCENTAR|\mPCTE\M|PACOTE|\mCONTRASTE\M|RECONSTRUCAO|PLANEJAMENTO|PUNCAO|BIOPSIA|DRENAGEM|AMNIOCENTESE|RADIOCIRURGIA|SEDACAO|ADICIONAL'
      and (v_tipo is null or public.pmarc_tipo_proc(p.modalidade) = v_tipo)
  ), x as (
    select distinct on (k.chave) k.id, k.nome, k.modalidade, k.tipo, k.agenda, k.feitos, k.demanda
    from k
    where (k.feitos > 0 and k.modalidade <> 'CONSULTA' or (k.modalidade = 'CONSULTA' and k.agenda))
      and (v_busca is null or public.norm_nome(k.nome) like '%' || replace(replace(v_busca, '%', ''), '_', '') || '%')
    order by k.chave, k.agenda desc, k.demanda desc, k.id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'tipo', x.tipo, 'modalidade', x.modalidade, 'agenda', x.agenda) order by x.feitos desc, x.demanda desc, x.nome), '[]'::jsonb) into v_itens from x;
  return jsonb_build_object('ok', true, 'itens', v_itens);
end $function$;

