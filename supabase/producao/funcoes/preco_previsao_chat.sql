-- public.preco_previsao_chat(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.preco_previsao_chat(p_conversa uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_plano text; v_pn text; v_part boolean;
  r record; v_lo numeric; v_hi numeric; v_k int;
  v_n int := 0; v_total numeric := 0; v_multi boolean := false; v_linhas text := '';
begin
  select pa.plano into v_plano from public.pre_agendamentos pa where pa.conversa_id = p_conversa order by pa.atualizado_em desc limit 1;
  v_pn := public.norm_chave(v_plano);
  if v_pn is null then return null; end if;
  v_part := v_pn like 'PARTICULAR%';
  if not v_part and length(v_pn) < 3 then return null; end if;

  if exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is null) then return null; end if;

  for r in
    select i.procedimento_id, coalesce(max(i.procedimento), '') as nome,
           greatest(sum(coalesce(i.quantidade, 1) * coalesce(public.preco_fator_lado(i.lado, p.nome), 1)), 1)::int as qtd,
           bool_or(i.lado = 'A' and public.preco_fator_lado(i.lado, p.nome) = 2) as dois_lados,
           bool_or(i.lado = 'A' and public.preco_fator_lado(i.lado, p.nome) is null) as lado_duvida
      from public.pre_agendamento_itens i
      join public.catalogo_procedimento p on p.id = i.procedimento_id
     where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null
     group by i.procedimento_id order by min(i.id)
  loop
    if r.lado_duvida then return null; end if;     -- "os dois lados" num exame em que não dá para saber se cobra por lado: o atendente confirma
    select min(rv.valor), max(rv.valor), count(*) into v_lo, v_hi, v_k
      from public.catalogo_preco_revisao rv
     where rv.procedimento_id = r.procedimento_id and rv.ligado
       and ((v_part and rv.opn = 'PARTICULAR')
         or (not v_part and rv.opn <> 'PARTICULAR' and (strpos(v_pn, rv.opn) > 0 or strpos(rv.opn, v_pn) > 0)));
    if v_k = 0 or v_lo is distinct from v_hi then return null; end if;
    v_n := v_n + 1; v_total := v_total + v_lo * r.qtd;
    if r.qtd > 1 then v_multi := true; end if;
    v_linhas := v_linhas || '• ' || r.nome
      || case when r.dois_lados then ' (dois lados, ' || r.qtd || 'x ' || public.preco_brl(v_lo) || ')' when r.qtd > 1 then ' (' || r.qtd || 'x ' || public.preco_brl(v_lo) || ')' else '' end
      || ': ' || public.preco_brl(v_lo * r.qtd) || E'\n';
  end loop;
  if v_n = 0 then return null; end if;

  return public.fluxo_t('preco_previsao', jsonb_build_object('plano', btrim(v_plano), 'itens', rtrim(v_linhas, E'\n'),
           'total', case when v_n > 1 or v_multi then E'Total previsto: ' || public.preco_brl(v_total) || E'\n' else '' end));
exception when others then
  return null;
end $function$;

