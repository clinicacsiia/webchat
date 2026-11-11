-- public.painel_indicadores_jornada_v2(p_de date, p_ate date, p_unidade text, p_incluir_teste boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_indicadores_jornada_v2(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ate date := least(coalesce(p_ate, (now() at time zone 'America/Sao_Paulo')::date), (now() at time zone 'America/Sao_Paulo')::date);
  v_de date;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
  v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;

  with sal as (select valor as v from public.config where chave = 'ia_segredo'),
  cv as (
    select c.id, pu.pessoa, c.criado_em, c.primeiro_humano_em, public.pessoa_ficha(c.id) ->> 'nome' as nome,
           case when length(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g')) >= 8
                then encode(sha256(convert_to(right(regexp_replace(ct.telefone, '\D', '', 'g'), 8) || coalesce((select v from sal), ''), 'UTF8')), 'hex') end as fh
      from public.conversas c
      join public.contatos ct on ct.id = c.contato_id
      join public.painel_conversa_pessoa_un() pu on pu.conversa_id = c.id
     where (p_incluir_teste or not c.teste)
       and (v_un is null or pu.chaves is null or cardinality(pu.chaves) = 0 or v_un = any (pu.chaves))),
  pf as (
    select pessoa, min(criado_em) as pri, (min(primeiro_humano_em) at time zone 'America/Sao_Paulo')::date as dia
      from cv where primeiro_humano_em is not null group by pessoa
    having (min(primeiro_humano_em) at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
  lig as (
    select cv.pessoa, p.prontuario, false as por_marcacao
      from cv join public.jornada_paciente p on p.fone_chave = cv.fh and public.nome_confere(p.nome, cv.nome)
    union
    select cv.pessoa, c.paciente_chave, true
      from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id
              join public.jornada_exame e on e.marcacao_id = any (pa.klingo_marcacoes)
              join public.jornada_card c on c.id = e.card_id),
  ex as (
    select distinct pf.pessoa, e.id as exame, e.status
      from pf join lig on lig.pessoa = pf.pessoa
              join public.jornada_card c on c.paciente_chave = lig.prontuario
              join public.jornada_exame e on e.card_id = c.id
     where e.status <> 'pedido' and (lig.por_marcacao or e.agendado_em >= pf.pri)),
  pp as (
    select pessoa,
           bool_or(status = 'atendido') as atendido,
           bool_or(status = 'faltou') as faltou,
           bool_or(status in ('cancelado', 'remarcado')) as cancrem,
           bool_or(status in ('agendado', 'confirmado')) as pendente
      from ex group by pessoa),
  t as (
    select pf.dia, pf.pessoa, (pp.pessoa is not null) as marcou, coalesce(pp.atendido, false) as atendido,
           coalesce(pp.faltou, false) as faltou, coalesce(pp.cancrem, false) as cancrem, coalesce(pp.pendente, false) as pendente
      from pf left join pp on pp.pessoa = pf.pessoa),
  d as (
    select dia, count(*) as pessoas, count(*) filter (where marcou) as marcaram,
           count(*) filter (where atendido) as atendidos, count(*) filter (where faltou) as faltaram,
           count(*) filter (where cancrem) as cancelaram_remarcaram, count(*) filter (where pendente) as por_vir
      from t group by dia)
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'unidade', v_un, 'gerado_em', now(),
    'total', (select jsonb_build_object('pessoas', coalesce(sum(pessoas), 0), 'marcaram', coalesce(sum(marcaram), 0),
                'atendidos', coalesce(sum(atendidos), 0), 'faltaram', coalesce(sum(faltaram), 0), 'cancelaram_remarcaram', coalesce(sum(cancelaram_remarcaram), 0),
                'por_vir', coalesce(sum(por_vir), 0)) from d),
    'por_dia', coalesce((select jsonb_agg(jsonb_build_object('dia', d.dia, 'pessoas', d.pessoas, 'marcaram', d.marcaram, 'atendidos', d.atendidos,
                'faltaram', d.faltaram, 'cancelaram_remarcaram', d.cancelaram_remarcaram, 'por_vir', d.por_vir) order by d.dia) from d), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $function$;

