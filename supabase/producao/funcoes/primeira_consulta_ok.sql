-- public.primeira_consulta_ok(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.primeira_consulta_ok(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_lista text[]; v_pref text; v_jogo text[]; pa public.pre_agendamentos; v_pront text; v_chave text; d jsonb; v_cpf text; v_nasc date;
begin
  if coalesce((select valor from public.config where chave = 'primeira_consulta_modo'), 'nao') <> 'sim' then return jsonb_build_object('bloqueia', false, 'motivo', 'desligado'); end if;
  select coalesce(array_agg(public.norm_nome(x)) filter (where public.norm_nome(x) is not null), '{}') into v_lista
    from unnest(string_to_array(coalesce((select valor from public.config where chave = 'primeira_consulta_medicas'), ''), ';')) x;
  if cardinality(v_lista) = 0 then return jsonb_build_object('bloqueia', false, 'motivo', 'sem_medica_na_lista'); end if;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if pa.tipo is distinct from 'consulta' then return jsonb_build_object('bloqueia', false, 'motivo', 'nao_e_consulta'); end if;
  select public.norm_nome(c.medico_preferido) into v_pref from public.conversas c where c.id = p_conversa;
  if v_pref is not null then
    v_jogo := case when v_pref = any (v_lista) then array[v_pref] else '{}'::text[] end;
  else
    select coalesce(array_agg(n) filter (where n = any (v_lista)), '{}') into v_jogo
      from (select public.norm_nome(m) as n from unnest(coalesce(public.fluxo_medicos(p_conversa), '{}'::text[])) m) t;
  end if;
  if cardinality(v_jogo) = 0 then return jsonb_build_object('bloqueia', false, 'motivo', 'medica_nao_controlada'); end if;
  if coalesce((select f.dados ->> 'primeira_liberada' = 'true' from public.conversa_fluxo f where f.conversa_id = p_conversa), false) then
    return jsonb_build_object('bloqueia', false, 'motivo', 'liberada');
  end if;
  begin
    d := public.klingo_dados_conversa(p_conversa); v_cpf := d ->> 'cpf'; v_nasc := (d ->> 'nascimento')::date;
    if v_cpf is not null and v_nasc is not null then v_chave := public.klingo_hash(v_cpf || '|' || v_nasc::text); end if;
  exception when others then v_chave := null;
  end;
  if v_chave is not null then
    if exists (select 1 from public.primeira_consulta_liberada l where l.chave = v_chave) then return jsonb_build_object('bloqueia', false, 'motivo', 'liberada'); end if;
    if exists (select 1 from public.consulta_feita c where c.chave = v_chave and public.norm_nome(c.profissional) = any (v_jogo)) then return jsonb_build_object('bloqueia', false, 'motivo', 'tem_historico'); end if;
  end if;
  -- reserva: atendimento guardado só pelo prontuário (leitura do #14359) e o vínculo CPF + nascimento da conversa
  select v.prontuario into v_pront from public.paciente_klingo_vinculo v where v.conversa_id = p_conversa and v.situacao = 'confere' and v.prontuario is not null;
  if v_pront is not null and exists (select 1 from public.consulta_feita c where c.prontuario = v_pront and public.norm_nome(c.profissional) = any (v_jogo)) then
    return jsonb_build_object('bloqueia', false, 'motivo', 'tem_historico');
  end if;
  return jsonb_build_object('bloqueia', true, 'motivo', case when v_chave is null and v_pront is null then 'sem_vinculo' else 'sem_historico' end, 'medicas', to_jsonb(v_jogo));
end $function$;

