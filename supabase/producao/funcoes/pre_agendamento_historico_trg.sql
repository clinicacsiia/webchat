-- public.pre_agendamento_historico_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pre_agendamento_historico_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_pid uuid;
begin
  if new.status in ('rascunho', 'pronto', 'cancelado') and old.status = 'agendado' then
    update public.paciente_historico set cancelado = true where pre_agendamento_id = new.id;
    return new;
  end if;
  if new.status is distinct from 'agendado' or old.status = 'agendado' then return new; end if;
  v_pid := new.paciente_id;
  if v_pid is null then
    select p.id into v_pid from public.pacientes p
      join public.conversas c on c.id = new.conversa_id join public.contatos ct on ct.id = c.contato_id
      where public.fone_chave(ct.telefone) = any(p.telefones) and public.nome_confere(coalesce(c.nome_informado, ct.nome), p.nome) and (p.email is null or lower(p.email) = lower(coalesce(nullif(btrim((case when c.nome_informado is not null then c.email_informado else ct.email end)), ''), '')))
      order by p.atualizado_em desc limit 1;
  end if;
  if v_pid is null then return new; end if;
  insert into public.paciente_historico as h (paciente_id, pre_agendamento_id, conversa_id, ocorreu_em, unidade, profissional, plano, exames, horarios, origem, cancelado)
  values (v_pid, new.id, new.conversa_id,
    (select min((e ->> 'data')::date + (e ->> 'hora')::time) from jsonb_array_elements(case when jsonb_typeof(new.escolha_horario) = 'array' then new.escolha_horario else '[]'::jsonb end) e),
    coalesce(new.unidade, new.escolha_horario -> 0 ->> 'unidade'), coalesce(new.profissional, new.escolha_horario -> 0 ->> 'profissional'), new.plano,
    coalesce((select jsonb_agg(jsonb_build_object('modalidade', i.modalidade, 'regiao', i.regiao, 'parte_do_corpo', i.regiao_nome, 'lado', i.lado,
                'procedimento_id', i.procedimento_id, 'exame', i.procedimento, 'quantidade', i.quantidade) order by i.id)
              from public.pre_agendamento_itens i where i.conversa_id = new.conversa_id and i.ativo), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('data', e ->> 'data', 'hora', e ->> 'hora', 'unidade', e ->> 'unidade', 'profissional', e ->> 'profissional') order by e ->> 'data', e ->> 'hora')
              from jsonb_array_elements(case when jsonb_typeof(new.escolha_horario) = 'array' then new.escolha_horario else '[]'::jsonb end) e), '[]'::jsonb),
    case when new.agendado_auto_em is not null then 'automatico' else 'manual' end, false)
  on conflict (pre_agendamento_id) do update set
    paciente_id = excluded.paciente_id, ocorreu_em = excluded.ocorreu_em, unidade = excluded.unidade, profissional = excluded.profissional, plano = excluded.plano,
    exames = excluded.exames, horarios = excluded.horarios, origem = excluded.origem, cancelado = false;
  return new;
end $function$;

