-- public.klingo_dados_conversa(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_dados_conversa(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pa public.pre_agendamentos; c public.conversas; ct public.contatos; v_cpf text; v_nasc date; v_i public.klingo_identidade; v_procs integer[]; v_n integer; v_proc integer;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select * into c from public.conversas where id = p_conversa;
  select * into ct from public.contatos where id = c.contato_id;
  v_cpf := regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g');
  v_nasc := public.fluxo_ler_data(pa.paciente ->> 'dt_nasc');
  if public.fluxo_cpf_ok(v_cpf) and v_nasc is not null then
    select * into v_i from public.klingo_identidade where chave = public.klingo_hash(v_cpf || '|' || v_nasc::text);
  end if;
  select array_agg(i.procedimento_id order by i.id) into v_procs from public.pre_agendamento_itens i,
    lateral generate_series(1, i.quantidade) g where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  v_n := coalesce(cardinality(v_procs), 0); v_proc := v_procs[1];
  return jsonb_build_object(
    'tipo', pa.tipo, 'plano', pa.plano, 'pre_agendamento_id', pa.id, 'status', pa.status, 'procedimentos', coalesce(to_jsonb(v_procs), '[]'::jsonb), 'n_procedimentos', v_n, 'procedimento', v_proc,
    'cpf', case when public.fluxo_cpf_ok(v_cpf) then v_cpf end, 'nascimento', v_nasc,
    'nome', nullif(btrim(pa.paciente ->> 'nome'), ''), 'sexo', nullif(btrim(pa.paciente ->> 'sexo'), ''), 'mae', nullif(btrim(pa.paciente ->> 'mae'), ''),
    'celular', coalesce(nullif(regexp_replace(coalesce(pa.paciente ->> 'celular', ''), '\D', '', 'g'), ''), regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g')),
    'email', nullif(btrim(pa.paciente ->> 'email'), ''),
    'teste', coalesce(c.teste, false),
    'identidade', case when v_i.id is null then null else jsonb_build_object('situacao', v_i.situacao, 'tipo', v_i.tipo, 'klingo_id', v_i.klingo_id, 'plano_id', v_i.plano_id, 'conferido_em', v_i.conferido_em) end);
end $function$;

