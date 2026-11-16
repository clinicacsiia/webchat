-- public.particular_valor_obter(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.particular_valor_obter(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_plano text; v_pid int := public.particular_plano_id(); r record; v_p numeric; v_tot numeric := 0; v_itens jsonb := '[]'::jsonb;
  v_falta text[] := '{}'; v_n int := 0; v_sem_proc boolean;
begin
  select pa.plano into v_plano from public.pre_agendamentos pa where pa.conversa_id = p_conversa;
  if public.norm_chave(v_plano) is null or public.norm_chave(v_plano) not like 'PARTICULAR%' then return jsonb_build_object('particular', false, 'completo', false); end if;
  v_sem_proc := exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is null);
  for r in
    select i.procedimento_id, coalesce(max(i.procedimento), max(p.nome), '') as nome,
           greatest(sum(coalesce(i.quantidade, 1) * coalesce(public.preco_fator_lado(i.lado, p.nome), 1)), 1)::int as qtd,
           bool_or(i.lado = 'A' and public.preco_fator_lado(i.lado, p.nome) is null) as lado_duvida
      from public.pre_agendamento_itens i
      join public.catalogo_procedimento p on p.id = i.procedimento_id
     where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null
     group by i.procedimento_id order by min(i.id)
  loop
    v_n := v_n + 1;
    select k.valor into v_p from public.klingo_preco_api k
     where k.procedimento_id = r.procedimento_id and k.plano_id = v_pid and k.valor > 0 and k.consultado_em > now() - interval '12 hours';
    if v_p is null or r.lado_duvida then v_falta := v_falta || r.nome;
    else
      v_tot := v_tot + v_p * r.qtd;
      v_itens := v_itens || jsonb_build_object('nome', r.nome, 'qtd', r.qtd, 'unitario', v_p, 'subtotal', v_p * r.qtd);
    end if;
  end loop;
  return jsonb_build_object('particular', true, 'completo', v_n > 0 and cardinality(v_falta) = 0 and not v_sem_proc,
                            'total', v_tot, 'itens', v_itens, 'faltando', to_jsonb(v_falta), 'plano_id', v_pid);
end $function$;

