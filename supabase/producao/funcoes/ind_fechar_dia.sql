-- public.ind_fechar_dia(p_dia date)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ind_fechar_dia(p_dia date)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_hoje date := (now() at time zone 'America/Sao_Paulo')::date; v_resumo jsonb;
begin
  if p_dia is null or p_dia >= v_hoje then raise exception 'Só se fecha um dia que já terminou.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('ind_fechar_dia'));
  if exists (select 1 from public.ind_fechamento f where f.dia = p_dia) then return false; end if;
  insert into public.ind_pessoa_dia (dia, pessoa, teste, unidades, contatos, entrou, reentradas, transferencias)
    select dia, pessoa, teste, unidades, contatos, entrou, reentradas, transferencias from public.ind_calc_pessoas(p_dia, p_dia);
  insert into public.ind_conclusao_dia (dia, ordem, pessoa, teste, unidades, origem, motivo, cruzou, mais24, reencerrada)
    select dia, row_number() over (order by pessoa, origem, motivo)::integer, pessoa, teste, unidades, origem, motivo, cruzou, mais24, reencerrada from public.ind_calc_conclusoes(p_dia, p_dia);
  insert into public.ind_semhumano_dia (dia, ordem, pessoa, teste, unidades)
    select dia, row_number() over (order by pessoa)::integer, pessoa, teste, unidades from public.ind_calc_semhumano(p_dia, p_dia);
  select jsonb_build_object(
    'pessoas', (select count(distinct pessoa) from public.ind_pessoa_dia where dia = p_dia and entrou and not teste),
    'reentradas', (select coalesce(sum(reentradas), 0) from public.ind_pessoa_dia where dia = p_dia and not teste),
    'concluidas', (select count(*) from public.ind_conclusao_dia where dia = p_dia and not teste),
    'sem_humano', (select count(*) from public.ind_semhumano_dia where dia = p_dia and not teste)) into v_resumo;
  insert into public.ind_fechamento (dia, resumo) values (p_dia, v_resumo);
  return true;
end $function$;

