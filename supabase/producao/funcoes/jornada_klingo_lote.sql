-- public.jornada_klingo_lote(p_linhas jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_klingo_lote(p_linhas jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r         jsonb;
  v_hoje    date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ident   boolean := coalesce((select valor from public.config where chave = 'jornada_identidade_klingo'), 'sim') = 'sim';
  v_para    timestamptz;
  v_dia     date;
  v_unid    text;
  v_status  text;
  v_id      bigint;
  n_ok      integer := 0;
  n_pula    integer := 0;
  n_cards   integer := 0;
  n_mudou   integer := 0;
  n_linha   integer;
begin
  perform set_config('jornada.sem_aviso', '1', true);
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then
    raise exception 'O lote precisa ser uma lista.';
  end if;
  for r in select x from jsonb_array_elements(p_linhas) x loop
    if coalesce(r ->> 'm', '') = '' or coalesce(r ->> 'p', '') = '' or coalesce(r ->> 'd', '') !~ '^\d{4}-\d{2}-\d{2}' then
      n_pula := n_pula + 1;
      continue;
    end if;
    v_para := (r ->> 'd')::timestamp at time zone 'America/Sao_Paulo';
    v_dia := (r ->> 'd')::timestamp::date;
    v_unid := public.jornada_unidade_curta(r ->> 'u');
    v_status := public.jornada_status_exame(r ->> 's', r ->> 't', r ->> 'r', r ->> 'c', v_dia, v_hoje);

    insert into public.jornada_paciente as p (prontuario, nome, fone_chave)
    values (r ->> 'p', case when v_ident then nullif(trim(r ->> 'n'), '') end, nullif(r ->> 'f', ''))
    on conflict (prontuario) do update
      set nome = coalesce(excluded.nome, p.nome), fone_chave = coalesce(excluded.fone_chave, p.fone_chave), atualizado_em = now()
      where (p.nome, p.fone_chave) is distinct from (coalesce(excluded.nome, p.nome), coalesce(excluded.fone_chave, p.fone_chave));

    select id into v_id from public.jornada_card where paciente_chave = r ->> 'p' and data_ref = v_dia and unidade = v_unid;
    if v_id is null then
      insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna)
      values (r ->> 'p', v_dia, v_unid, public.jornada_coluna_do_card(array[v_status]))
      on conflict (paciente_chave, data_ref, unidade) do nothing
      returning id into v_id;
      if v_id is not null then
        insert into public.jornada_evento (card_id, tipo, origem, para_coluna, detalhe) values (v_id, 'criado', 'klingo', public.jornada_coluna_do_card(array[v_status]), jsonb_build_object('marcacao', r ->> 'm'));
        n_cards := n_cards + 1;
      else
        select id into v_id from public.jornada_card where paciente_chave = r ->> 'p' and data_ref = v_dia and unidade = v_unid;
      end if;
    end if;

    insert into public.jornada_exame as e (card_id, marcacao_id, atendimento_id, procedimento, operadora, unidade, agendado_em, agendado_para, status, confirm_status, cancelamento_motivo)
    values (v_id, 'm' || (r ->> 'm'), nullif(r ->> 'a', ''), coalesce(nullif(trim(r ->> 'x'), ''), 'Procedimento não informado'), nullif(trim(r ->> 'o'), ''), v_unid,
            case when coalesce(r ->> 'e', '') ~ '^\d{4}-\d{2}-\d{2}' then (r ->> 'e')::timestamp at time zone 'America/Sao_Paulo' end, v_para,
            v_status, nullif(trim(r ->> 'c'), ''), nullif(trim(r ->> 'r'), ''))
    on conflict (marcacao_id) do update
      set card_id = excluded.card_id, atendimento_id = excluded.atendimento_id, procedimento = excluded.procedimento, operadora = excluded.operadora, unidade = excluded.unidade,
          agendado_em = excluded.agendado_em, agendado_para = excluded.agendado_para, status = excluded.status, confirm_status = excluded.confirm_status,
          cancelamento_motivo = excluded.cancelamento_motivo, atualizado_em = now()
      where (e.card_id, e.atendimento_id, e.procedimento, e.operadora, e.unidade, e.agendado_em, e.agendado_para, e.status, e.confirm_status, e.cancelamento_motivo)
            is distinct from (excluded.card_id, excluded.atendimento_id, excluded.procedimento, excluded.operadora, excluded.unidade, excluded.agendado_em, excluded.agendado_para,
                              excluded.status, excluded.confirm_status, excluded.cancelamento_motivo);
    get diagnostics n_linha = row_count;
    n_mudou := n_mudou + n_linha;
    n_ok := n_ok + 1;
  end loop;
  return jsonb_build_object('lidas', n_ok, 'puladas', n_pula, 'cartoes_criados', n_cards, 'alteradas', n_mudou);
end;
$function$;

