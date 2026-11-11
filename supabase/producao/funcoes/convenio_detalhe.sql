-- public.convenio_detalhe(p_operadora text, p_limite integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.convenio_detalhe(p_operadora text, p_limite integer DEFAULT 80)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ch text := public.convenio_chave(p_operadora); v_part boolean := public.convenio_chave(p_operadora) ~ '^PARTICULAR'; r jsonb;
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  with par as (select distinct on (procedimento_id) procedimento_id, valor, confianca, amostras, visto_em, ultima_marcacao from public.catalogo_preco
               where fonte = 'particular' and status = 'ativo' order by procedimento_id, case confianca when 'alta' then 0 when 'media' then 1 else 2 end, visto_em desc),
  cv as (select distinct on (procedimento_id) procedimento_id, valor, confianca, tabela, visto_em from public.catalogo_preco
         where fonte = 'convenio' and status = 'ativo' and public.convenio_chave(operadora) = v_ch order by procedimento_id, case confianca when 'alta' then 0 when 'media' then 1 else 2 end, visto_em desc),
  obs as (select distinct on (o.procedimento_norm) o.procedimento_norm, o.valor_tipico, o.amostras, o.janela_fim from public.preco_observado o
          where public.convenio_chave(o.operadora) = v_ch and o.valor_tipico is not null order by o.procedimento_norm, o.atualizado_em desc),
  mud as (select m.chave, max(m.detectada_em) quando, (array_agg(m.antes order by m.detectada_em desc))[1] antes, (array_agg(m.depois order by m.detectada_em desc))[1] depois
          from public.catalogo_mudanca m where m.tipo = 'preco' and m.evento = 'alterado' and m.detectada_em >= now() - interval '30 days' group by m.chave),
  base as (select p.id, p.nome, p.modalidade, coalesce(p.demanda_90d, 0) demanda from public.catalogo_procedimento p
           where p.ativo and exists (select 1 from public.catalogo_agenda a where a.procedimento_id = p.id and a.vig_fim >= current_date and a.profissional !~* 'teste')
             and (v_part or exists (select 1 from cv where cv.procedimento_id = p.id))
           order by coalesce(p.demanda_90d, 0) desc, p.nome limit greatest(1, least(coalesce(p_limite, 80), 300)))
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'exame', b.nome, 'modalidade', b.modalidade, 'demanda_90d', b.demanda,
      'valor_convenio', cv.valor, 'confianca_convenio', cv.confianca, 'tabela', cv.tabela,
      'valor_particular', par.valor, 'confianca_particular', par.confianca, 'amostras_particular', par.amostras, 'particular_visto_em', par.visto_em,
      'ultimo_valor_marcacao', obs.valor_tipico, 'ultimo_valor_amostras', obs.amostras, 'ultimo_valor_ate', obs.janela_fim,
      'mudou_em', mud.quando, 'mudou_de', mud.antes, 'mudou_para', mud.depois) order by b.demanda desc, b.nome), '[]'::jsonb)
  into r
  from base b left join par on par.procedimento_id = b.id left join cv on cv.procedimento_id = b.id
    left join obs on obs.procedimento_norm = public.norm_nome(b.nome) left join mud on mud.chave = 'particular|' || b.id;
  return r;
end $function$;

