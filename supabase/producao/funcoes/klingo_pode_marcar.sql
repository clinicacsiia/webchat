-- public.klingo_pode_marcar(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_pode_marcar(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pa public.pre_agendamentos; d jsonb; e jsonb; o public.klingo_oferta; v_id jsonb; v_pl jsonb; v_novo boolean := false; v_rem boolean := false;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if not public.klingo_ativo(p_conversa, 'klingo_api_marcar') then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  v_rem := coalesce((select jsonb_typeof(f.dados -> 'remarcando') = 'object' from public.conversa_fluxo f where f.conversa_id = p_conversa), false);
  if pa.id is null or (pa.status = 'agendado' and not v_rem) then return jsonb_build_object('ok', false, 'motivo', 'ja_agendado'); end if;
  if v_rem and (pa.agendado_origem is distinct from 'chat_api' or not public.klingo_ativo(p_conversa, 'klingo_api_pos')) then return jsonb_build_object('ok', false, 'motivo', 'remarcar_desligado'); end if;
  d := public.klingo_dados_conversa(p_conversa);
  if (d ->> 'n_procedimentos')::int <> 1 then return jsonb_build_object('ok', false, 'motivo', 'varios_procedimentos'); end if;
  if jsonb_typeof(pa.escolha_horario) <> 'array' or jsonb_array_length(pa.escolha_horario) <> 1 then return jsonb_build_object('ok', false, 'motivo', 'horario_nao_unico'); end if;
  e := pa.escolha_horario -> 0;
  select * into o from public.klingo_oferta where conversa_id = p_conversa and chave = e ->> 'klingo_chave' and expira_em > now() - interval '20 minutes';
  if o.id is null then return jsonb_build_object('ok', false, 'motivo', 'sem_oferta_da_api'); end if;
  if o.procedimento is distinct from (d ->> 'procedimento')::int
     and not exists (select 1 from public.klingo_especialidade e where (d ->> 'procedimento')::int = any (e.procedimentos) and o.procedimento = any (e.procedimentos)) then
    return jsonb_build_object('ok', false, 'motivo', 'oferta_de_outro_procedimento');
  end if;
  if d ->> 'cpf' is null or d ->> 'nascimento' is null or d ->> 'nome' is null or d ->> 'sexo' is null then return jsonb_build_object('ok', false, 'motivo', 'dados_incompletos'); end if;
  v_id := d -> 'identidade';
  if v_id is not null and jsonb_typeof(v_id) = 'object' then
    if v_id ->> 'situacao' in ('divergente', 'sem_id_definitivo') then return jsonb_build_object('ok', false, 'motivo', 'cadastro_divergente'); end if;
    if v_id ->> 'situacao' = 'nao_encontrado' then v_novo := true; end if;
  end if;
  if v_novo and not public.klingo_ativo(p_conversa, 'klingo_api_pre_cadastro') then return jsonb_build_object('ok', false, 'motivo', 'paciente_novo'); end if;
  v_pl := public.klingo_plano_resolver(pa.plano, nullif(v_id ->> 'plano_id', '')::int);
  if (v_pl ->> 'plano_id') is null and not (v_id is null or v_id ->> 'situacao' is null) then return jsonb_build_object('ok', false, 'motivo', coalesce(v_pl ->> 'motivo', 'sem_plano')); end if;
  if (v_pl ->> 'plano_id') is not null and (v_pl ->> 'plano_id')::int is distinct from o.plano and (v_pl ->> 'via') = 'padrao' and o.plano <> (v_pl ->> 'plano_id')::int and v_id is not null then
    return jsonb_build_object('ok', false, 'motivo', 'plano_mudou_depois_da_oferta');
  end if;
  if pa.tipo = 'exame' and public.norm_nome(pa.plano) <> 'PARTICULAR' and public.klingo_cfg('klingo_api_exame_convenio', 'nao') <> 'sim' then
    return jsonb_build_object('ok', false, 'motivo', 'exame_com_convenio');
  end if;
  return jsonb_build_object('ok', true, 'novo', v_novo, 'remarcar', v_rem);
end $function$;

