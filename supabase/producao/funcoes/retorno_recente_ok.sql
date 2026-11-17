-- public.retorno_recente_ok(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.retorno_recente_ok(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_dias int; pa public.pre_agendamentos; v_pref text; v_med text[]; v_procs int[]; v_esp text[];
  v_chave text; v_pront text; d jsonb; v_cpf text; v_nasc date; r record; v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  if coalesce((select valor from public.config where chave = 'retorno_dias_modo'), 'nao') <> 'sim' then return jsonb_build_object('bloqueia', false, 'motivo', 'desligado'); end if;
  v_dias := coalesce(nullif((select valor from public.config where chave = 'retorno_dias_limite'), '')::int, 30);
  if v_dias < 1 then return jsonb_build_object('bloqueia', false, 'motivo', 'desligado'); end if;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if pa.tipo is distinct from 'consulta' then return jsonb_build_object('bloqueia', false, 'motivo', 'nao_e_consulta'); end if;
  if coalesce((select jsonb_typeof(f.dados -> 'remarcando') = 'object' from public.conversa_fluxo f where f.conversa_id = p_conversa), false) then
    return jsonb_build_object('bloqueia', false, 'motivo', 'remarcando');
  end if;
  select array_agg(distinct i.procedimento_id) into v_procs from public.pre_agendamento_itens i
    where i.conversa_id = p_conversa and i.ativo and i.modalidade = 'CONSULTA' and i.procedimento_id is not null;
  if v_procs is null then return jsonb_build_object('bloqueia', false, 'motivo', 'sem_consulta'); end if;
  select public.norm_nome(c.medico_preferido) into v_pref from public.conversas c where c.id = p_conversa;
  if v_pref is not null then v_med := array[v_pref];
  else select coalesce(array_agg(distinct public.norm_nome(m)) filter (where public.norm_nome(m) is not null), '{}') into v_med from unnest(coalesce(public.fluxo_medicos(p_conversa), '{}'::text[])) m;
  end if;
  select coalesce(array_agg(distinct public.norm_nome(a.especialidade)) filter (where public.norm_nome(a.especialidade) is not null), '{}') into v_esp
    from public.catalogo_agenda a
    where a.procedimento_id = any (v_procs) and a.vig_fim >= v_hoje
      and (cardinality(v_med) = 0 or public.norm_nome(a.profissional) = any (v_med));
  if cardinality(v_esp) = 0 then return jsonb_build_object('bloqueia', false, 'motivo', 'sem_especialidade'); end if;
  begin
    d := public.klingo_dados_conversa(p_conversa); v_cpf := d ->> 'cpf'; v_nasc := (d ->> 'nascimento')::date;
    if v_cpf is not null and v_nasc is not null then v_chave := public.klingo_hash(v_cpf || '|' || v_nasc::text); end if;
  exception when others then v_chave := null;
  end;
  select v.prontuario into v_pront from public.paciente_klingo_vinculo v where v.conversa_id = p_conversa and v.situacao = 'confere' and v.prontuario is not null;
  if v_chave is null and v_pront is null then return jsonb_build_object('bloqueia', false, 'motivo', 'sem_identificacao'); end if;
  select c.atendido_em, x.esp_nome into r
    from public.consulta_feita c
    cross join lateral (
      select min(initcap(lower(a.especialidade))) as esp_nome
      from public.catalogo_agenda a join public.catalogo_procedimento p on p.id = a.procedimento_id and p.classe = 'CONSULTAS'
      where public.norm_nome(a.profissional) = public.norm_nome(c.profissional) and public.norm_nome(a.especialidade) = any (v_esp)) x
    where (c.chave = v_chave or c.prontuario = v_pront) and c.atendido_em > v_hoje - v_dias and c.atendido_em <= v_hoje and x.esp_nome is not null
    order by c.atendido_em desc limit 1;
  if r.atendido_em is null then return jsonb_build_object('bloqueia', false, 'motivo', 'sem_atendimento_recente'); end if;
  return jsonb_build_object('bloqueia', true, 'motivo', 'retorno_recente', 'especialidade', r.esp_nome, 'ultimo_em', r.atendido_em, 'dias_desde', v_hoje - r.atendido_em, 'limite', v_dias);
end $function$;

