-- public.ia_pre_agendar(p_segredo text, p_conversa uuid, p_dados jsonb, p_pronto boolean)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.ia_pre_agendar(p_segredo text, p_conversa uuid, p_dados jsonb, p_pronto boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_seg text; v_ok boolean;
  v_pac jsonb := '{}'::jsonb; k text; v text;
  campos text[] := array['nome','nome_social','sexo','dt_nasc','mae','cpf','rg','cns','celular','telefone','email',
    'cep','endereco','numero','complemento','bairro','cidade','uf','matricula','validade'];
  r public.pre_agendamentos;
  v_conf jsonb; v_pid uuid; v_ident text; v_p jsonb; v_ct record;
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if v_seg is null or p_segredo is distinct from v_seg then
    raise exception 'Não autorizado.' using errcode = '28000';
  end if;
  select true into v_ok from public.conversas where id = p_conversa;
  if not coalesce(v_ok, false) or p_dados is null or jsonb_typeof(p_dados) <> 'object' then
    return jsonb_build_object('salvo', false);
  end if;

  if jsonb_typeof(p_dados->'paciente') = 'object' then
    foreach k in array campos loop
      v := nullif(btrim(p_dados->'paciente'->>k), '');
      if v is null then continue; end if;
      if k in ('cpf','celular','telefone','cep') then v := regexp_replace(v, '\D', '', 'g'); end if;
      if k = 'uf' then v := upper(left(v, 2)); end if;
      if v <> '' then v_pac := v_pac || jsonb_build_object(k, left(v, 200)); end if;
    end loop;
  end if;

  insert into public.pre_agendamentos as pa (conversa_id, tipo, especialidade, procedimento, plano, unidade, profissional, preferencia_horario, paciente, status, etapa)
  values (p_conversa,
    case when p_dados->>'tipo' in ('consulta','exame') then p_dados->>'tipo' end,
    left(nullif(btrim(p_dados->>'especialidade'), ''), 120), left(nullif(btrim(p_dados->>'procedimento'), ''), 160),
    left(nullif(btrim(p_dados->>'plano'), ''), 120), left(nullif(btrim(p_dados->>'unidade'), ''), 120),
    left(nullif(btrim(p_dados->>'profissional'), ''), 120), left(nullif(btrim(p_dados->>'preferencia_horario'), ''), 200),
    v_pac, case when p_pronto then 'pronto' else 'rascunho' end, case when p_dados->>'etapa' in ('pedido','plano','preferencias','data_hora','dados','confirmacao','pronto') then p_dados->>'etapa' end)
  on conflict (conversa_id) do update set
    tipo = coalesce(excluded.tipo, pa.tipo),
    especialidade = coalesce(excluded.especialidade, pa.especialidade),
    procedimento = coalesce(excluded.procedimento, pa.procedimento),
    plano = coalesce(excluded.plano, pa.plano),
    unidade = coalesce(excluded.unidade, pa.unidade),
    profissional = coalesce(excluded.profissional, pa.profissional),
    preferencia_horario = coalesce(excluded.preferencia_horario, pa.preferencia_horario),
    etapa = coalesce(excluded.etapa, pa.etapa), paciente = pa.paciente || excluded.paciente,
    status = case when pa.status in ('agendado','cancelado') then pa.status
                  when p_pronto then 'pronto' else pa.status end,
    atualizado_em = now()
  returning * into r;

      v_conf := public.paciente_conferir(p_conversa);
        v_pid := nullif(v_conf ->> 'paciente_id', '')::uuid;
          v_ident := case
              when v_pid is null then 'nova'
                  when (v_conf ->> 'dt_nasc_conferida') = 'true' and v_conf ->> 'situacao' = 'parcial' then 'atualizar'
                      when (v_conf ->> 'dt_nasc_conferida') = 'true' then 'conferida'
                          when (v_conf ->> 'dt_nasc_conferida') = 'false' then 'divergente'
                              else 'aguardando' end;
                                if v_ident in ('conferida', 'atualizar') then
                                    update public.pre_agendamentos x set
                                          paciente = coalesce((select jsonb_object_agg(e.key, e.value) from public.pacientes p, jsonb_each(p.dados) e
                                                                     where p.id = v_pid and e.key = any(array['nome_social','sexo','dt_nasc','mae','cpf','rg','cns','celular','telefone','email',
                                                                                                  'cep','endereco','numero','complemento','bairro','cidade','uf'])), '{}'::jsonb) || x.paciente,
                                                                                                        paciente_id = v_pid, identidade = v_ident
                                                                                                            where x.conversa_id = p_conversa;
                                                                                                              else
                                                                                                                  update public.pre_agendamentos x set identidade = v_ident,
                                                                                                                        paciente_id = case when v_ident in ('nova', 'divergente') then null else x.paciente_id end
                                                                                                                            where x.conversa_id = p_conversa;
                                                                                                                              end if;

                                                                                                                                if p_dados ->> 'reaproveitar' in ('ultimo', 'pendente') then perform public.pre_reaproveitar(p_conversa, p_dados ->> 'reaproveitar'); end if;
  select * into r from public.pre_agendamentos where conversa_id = p_conversa;
                                                                                                                                  if r.status in ('pronto', 'agendado') then
                                                                                                                                      select coalesce(c.nome_informado, ct.nome) as nome, ct.telefone into v_ct from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
                                                                                                                                          v_p := r.paciente;
                                                                                                                                              if r.paciente_id is not null then
                                                                                                                                                    update public.pacientes set
                                                                                                                                                            nome = coalesce(nullif(v_p ->> 'nome', ''), nome), nome_norm = public.norm_nome(coalesce(nullif(v_p ->> 'nome', ''), nome)),
                                                                                                                                                                    telefones = (select coalesce(array_agg(distinct t), '{}') from unnest(telefones || array[public.fone_chave(v_p ->> 'celular'), public.fone_chave(v_p ->> 'telefone'), public.fone_chave(v_ct.telefone)]) t where t is not null),
                                                                                                                                                                            email = coalesce(nullif(v_p ->> 'email', ''), email), dt_nasc = coalesce(public.data_ou_nula(v_p ->> 'dt_nasc'), dt_nasc),
                                                                                                                                                                                    cpf = coalesce(nullif(v_p ->> 'cpf', ''), cpf), dados = dados || (v_p - 'matricula' - 'validade'),
                                                                                                                                                                                            validado = true, validado_em = coalesce(validado_em, now()), ultima_visita_em = now(), atualizado_em = now()
                                                                                                                                                                                                  where id = r.paciente_id;
                                                                                                                                                                                                      else
                                                                                                                                                                                                            insert into public.pacientes (nome, nome_norm, telefones, email, dt_nasc, cpf, dados, validado, revisar, origem_conversa)
                                                                                                                                                                                                                  values (coalesce(nullif(v_p ->> 'nome', ''), v_ct.nome), public.norm_nome(coalesce(nullif(v_p ->> 'nome', ''), v_ct.nome)),
                                                                                                                                                                                                                          array_remove(array[public.fone_chave(v_p ->> 'celular'), public.fone_chave(v_p ->> 'telefone'), public.fone_chave(v_ct.telefone)], null),
                                                                                                                                                                                                                                  nullif(v_p ->> 'email', ''), public.data_ou_nula(v_p ->> 'dt_nasc'), nullif(v_p ->> 'cpf', ''), v_p - 'matricula' - 'validade', false,
                                                                                                                                                                                                                                          v_ident = 'divergente' or (nullif(v_p ->> 'cpf', '') is not null and exists (select 1 from public.pacientes o where o.cpf = v_p ->> 'cpf')),
                                                                                                                                                                                                                                                  p_conversa)
                                                                                                                                                                                                                                                        returning id into v_pid;
                                                                                                                                                                                                                                                              update public.pre_agendamentos set paciente_id = v_pid where conversa_id = p_conversa;
                                                                                                                                                                                                                                                                  end if;
                                                                                                                                                                                                                                                                    end if;

                                                                                                                                                                                                                                                                      return jsonb_build_object('salvo', true, 'status', r.status, 'identidade', v_ident);
end $function$;

