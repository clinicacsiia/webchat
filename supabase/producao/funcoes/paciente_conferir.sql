-- public.paciente_conferir(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.paciente_conferir(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ct record; b record; v_dt text; v_conf boolean; v_t int; v_m int; v_sit text; v_pac record;
begin
  -- NOVO (login): conversa aberta por conta de paciente (atendimento "proprio") cujo cadastro foi vinculado: a identidade já foi provada
  -- pelo login, então cadastro e histórico valem sem perguntar a data de nascimento. Cadastro em revisão não serve de base.
  select p.id, p.validado, p.ultima_visita_em into v_pac
    from public.conversas c
    join public.contas_paciente cp on cp.id = c.conta_id
    join public.pacientes p on p.id = cp.paciente_id and not p.revisar
   where c.id = p_conversa and c.paciente_tipo = 'proprio';
  if found then
    return jsonb_build_object('situacao', 'completo', 'paciente_id', v_pac.id, 'batem', jsonb_build_array('conta'), 'diferem', '[]'::jsonb,
      'validado', v_pac.validado, 'dt_nasc_conferida', true, 'ultima_visita_em', v_pac.ultima_visita_em::date, 'conta', true);
  end if;

  -- convidado (sem login) nunca reaproveita cadastro nem histórico. Ausente ou diferente de 'sim' = fechado.
  if coalesce((select valor from public.config where chave = 'reaproveitar_cadastro_convidado'), 'nao') <> 'sim' then
    return jsonb_build_object('situacao', 'novo');
  end if;

  select coalesce(c.nome_informado, ct.nome) as nome, ct.telefone, nullif(btrim((case when c.nome_informado is not null then c.email_informado else ct.email end)), '') as email into v_ct
  from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
  if not found then return jsonb_build_object('situacao', 'novo'); end if;
  if (select c.paciente_tipo from public.conversas c where c.id = p_conversa) = 'filho' then
    v_ct.nome := (select coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), c.paciente_nome) from public.conversas c
                  left join public.pre_agendamentos pa on pa.conversa_id = c.id where c.id = p_conversa);
    if v_ct.nome is null then return jsonb_build_object('situacao', 'novo'); end if;
  end if;

  select q.* into b from (
    select p.id, p.email as p_email, p.validado, p.dt_nasc, p.ultima_visita_em, p.atualizado_em,
           public.nome_confere(v_ct.nome, p.nome) as n_ok,
           coalesce(public.fone_chave(v_ct.telefone) = any(p.telefones), false) as t_ok,
           (v_ct.email is not null and p.email is not null and lower(v_ct.email) = lower(p.email)) as e_ok,
           (v_ct.email is not null and p.email is not null) as e_cmp
    from public.pacientes p
    where p.origem_conversa is distinct from p_conversa
      and not p.revisar
      and (public.fone_chave(v_ct.telefone) = any(p.telefones) or public.nome_confere(v_ct.nome, p.nome)
           or (v_ct.email is not null and lower(v_ct.email) = lower(p.email)))) q
  order by (q.n_ok::int + q.t_ok::int + q.e_ok::int) desc, q.validado desc, q.atualizado_em desc limit 1;
  if not found then return jsonb_build_object('situacao', 'novo'); end if;

  v_t := 2 + b.e_cmp::int;
  v_m := b.n_ok::int + b.t_ok::int + b.e_ok::int;
  v_sit := case when b.n_ok and b.t_ok and (b.p_email is null or b.e_ok) then 'completo' else 'novo' end;
  if v_sit = 'novo' then return jsonb_build_object('situacao', 'novo'); end if;

  select paciente ->> 'dt_nasc' into v_dt from public.pre_agendamentos where conversa_id = p_conversa;
  v_conf := case when public.data_ou_nula(v_dt) is not null and b.dt_nasc is not null then public.data_ou_nula(v_dt) = b.dt_nasc else null end;
  return jsonb_build_object('situacao', v_sit, 'paciente_id', b.id,
    'batem', to_jsonb(array_remove(array[case when b.n_ok then 'nome' end, case when b.t_ok then 'telefone' end, case when b.e_ok then 'email' end], null)),
    'diferem', to_jsonb(array_remove(array[case when not b.n_ok then 'nome' end, case when not b.t_ok then 'telefone' end, case when b.e_cmp and not b.e_ok then 'email' end], null)),
    'validado', b.validado, 'dt_nasc_conferida', v_conf, 'ultima_visita_em', b.ultima_visita_em::date);
end $function$;

