-- FLUXOGRAMA: entrada (a página previsao/index.html, tela "Pedir uma previsão": a pessoa escolhe o exame ou a consulta, diz o turno ou um horário "a partir de" / "até", ou NÃO escolhe nada e só vê a disponibilidade)
--   -> validação (interruptor `previsao_marcacao_modo`; tipos e horários conferidos; limite global de consultas; NADA aqui barra a pessoa: sem preferência vale)
--   -> lógica (lista de exames/consultas = catálogo ativo que tem agenda; disponibilidade PREVISTA = grade do Klingo menos a ocupação lida dos relatórios #7 e #47, a mesma conta de `agenda_horarios`; é previsão, NÃO reserva e NÃO é horário confirmado)
--   -> saída (jsonb com a lista / os horários previstos; o pedido vira mensagem na conversa com a equipe, robô DESLIGADO) | ROLLBACK: previsao-marcacao-parte5-rollback.sql
-- Versão 1.0 — 17/11/2026 / Mudança: primeira versão (a página de Previsão só mostrava as marcações que já existiam; faltava escolher o exame/consulta e o horário e ver a disponibilidade).
--
-- Três funções abertas ao `anon` (a pessoa não tem login nem PIN, igual às outras `pmarc_*`):
--   pmarc_catalogo(p_busca, p_tipo)                 -> lista de exames, consultas e outros com agenda
--   pmarc_disponibilidade(p_procedimento, p_dados)  -> horários previstos filtrados por turno / a partir de / até / até o dia / unidade
--   pmarc_pedido(p_codigo, p_dados)                 -> anota o pedido de previsão e avisa a equipe (conversa)
-- Nenhuma tabela nova e nenhuma função existente é alterada. Os horários não trazem dado de paciente.

create or replace function public.pmarc_tipo_proc(p_modalidade text) returns text
language sql immutable set search_path = '' as $$
  select case when p_modalidade = 'CONSULTA' then 'consulta'
              when p_modalidade in ('RM', 'TC', 'US', 'RX', 'MAMO', 'DENSITO') then 'exame'
              else 'outro' end
$$;

-- ---------- 1) lista de exames, consultas e outros ----------
-- Regra do dono (17/11/2026): aparece o que a clínica FEZ nos últimos 30 dias (marcação com status `atendido` na Jornada, casada pelo nome do procedimento) e, para consultas,
-- as especialidades que têm agenda. A Jornada só guarda o nome ("CONSULTA MEDICA" vale para 75 cadastros de especialidades diferentes), por isso a consulta é mostrada pela
-- especialidade do catálogo. Um item por nome (e por especialidade, nas consultas). `agenda` = tem horário na grade: só então a página oferece "Ver a disponibilidade".
-- PLANOS: a lista é a mesma para todos os planos e NÃO mostra preço nem cobertura; quem decide cobertura, autorização e valor é a equipe (a página avisa e pergunta o plano, sem exigir).
create or replace function public.pmarc_catalogo(p_busca text default null, p_tipo text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_busca text := nullif(btrim(public.norm_nome(left(coalesce(p_busca, ''), 60))), ''); v_tipo text := nullif(btrim(coalesce(p_tipo, '')), ''); v_itens jsonb;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  if v_tipo is not null and v_tipo not in ('consulta', 'exame', 'outro') then v_tipo := null; end if;
  -- os "feitos" são contados UMA vez (agrupados por nome) e ligados ao catálogo por junção; a versão com subconsulta por procedimento passava de 60 s na produção
  with feitos as (
    select public.norm_nome(e.procedimento) as n, count(*) as c from public.jornada_exame e
     where e.status = 'atendido' and e.agendado_para >= now() - interval '30 days' and e.agendado_para < now() group by 1
  ), com_agenda as (
    select distinct a.procedimento_id from public.catalogo_agenda a where a.vig_fim >= current_date and a.profissional !~* 'teste'
  ), k as (
    select p.id, p.modalidade, public.pmarc_tipo_proc(p.modalidade) as tipo, coalesce(p.demanda_90d, 0) as demanda,
      case when p.modalidade = 'CONSULTA' and public.norm_nome(p.nome) in ('CONSULTA', 'CONSULTA MEDICA') then btrim('Consulta ' || coalesce(initcap(lower(p.especialidade)), '')) else p.nome end as nome,
      public.norm_nome(p.nome) || case when p.modalidade = 'CONSULTA' then '|' || public.norm_nome(coalesce(p.especialidade, '')) else '' end as chave,
      (ca.procedimento_id is not null) as agenda, coalesce(f.c, 0) as feitos
    from public.catalogo_procedimento p
    left join com_agenda ca on ca.procedimento_id = p.id
    left join feitos f on f.n = public.norm_nome(p.nome)
    where p.ativo
      and public.norm_nome(p.nome) !~ 'ACRESCENTAR|\mPCTE\M|PACOTE|\mCONTRASTE\M|RECONSTRUCAO|PLANEJAMENTO|PUNCAO|BIOPSIA|DRENAGEM|AMNIOCENTESE|RADIOCIRURGIA|SEDACAO|ADICIONAL'
      and (v_tipo is null or public.pmarc_tipo_proc(p.modalidade) = v_tipo)
  ), x as (
    select distinct on (k.chave) k.id, k.nome, k.modalidade, k.tipo, k.agenda, k.feitos, k.demanda
    from k
    where (k.feitos > 0 and k.modalidade <> 'CONSULTA' or (k.modalidade = 'CONSULTA' and k.agenda))
      and (v_busca is null or public.norm_nome(k.nome) like '%' || replace(replace(v_busca, '%', ''), '_', '') || '%')
    order by k.chave, k.agenda desc, k.demanda desc, k.id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'tipo', x.tipo, 'modalidade', x.modalidade, 'agenda', x.agenda) order by x.feitos desc, x.demanda desc, x.nome), '[]'::jsonb) into v_itens from x;
  return jsonb_build_object('ok', true, 'itens', v_itens);
end $$;

-- ---------- 2) disponibilidade PREVISTA ----------
-- p_dados: { turno: manha|tarde|noite|qualquer, hora_apos: 'HH:MM', hora_ate: 'HH:MM', data_ate: AAAA-MM-DD, unidade: texto }. Tudo opcional: sem nada = os próximos horários.
create or replace function public.pmarc_disponibilidade(p_procedimento integer, p_dados jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d jsonb := case when jsonb_typeof(p_dados) = 'object' then p_dados else '{}'::jsonb end;
  v_turno text := coalesce(nullif(d ->> 'turno', ''), 'qualquer'); v_apos time; v_ate time; v_dia date; v_unid text := nullif(btrim(coalesce(d ->> 'unidade', '')), '');
  v_hoje date := (now() at time zone 'America/Bahia')::date; v_ate_dia date; v_proc record; v_dias jsonb; v_total integer; v_meta timestamptz;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  -- cada consulta monta a grade de vários dias: limite global (não há como identificar quem pede)
  delete from public.pmarc_tentativa where quando < now() - interval '6 hours';
  if (select count(*) from public.pmarc_tentativa where marca = 'global' and tipo = 'disp' and quando > now() - interval '1 minute') >= 120 then
    return jsonb_build_object('ok', false, 'motivo', 'muitos');
  end if;
  insert into public.pmarc_tentativa (marca, tipo) values ('global', 'disp');

  select p.id, p.nome into v_proc from public.catalogo_procedimento p where p.id = p_procedimento and p.ativo;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'procedimento_invalido'); end if;
  if v_turno not in ('manha', 'tarde', 'noite', 'qualquer') then v_turno := 'qualquer'; end if;
  if coalesce(d ->> 'hora_apos', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then v_apos := (d ->> 'hora_apos')::time; end if;
  if coalesce(d ->> 'hora_ate', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then v_ate := (d ->> 'hora_ate')::time; end if;
  begin v_dia := nullif(d ->> 'data_ate', '')::date; exception when others then v_dia := null; end;
  v_ate_dia := least(greatest(coalesce(v_dia, v_hoje + 21), v_hoje), v_hoje + 30);
  -- a página manda o nome curto; na grade do Klingo o nome é longo ("CLÍNICA DE SAÚDE E IMAGEM - CSI"). Nome desconhecido = sem filtro.
  v_unid := case upper(coalesce(v_unid, '')) when 'CSI' then 'CLÍNICA DE SAÚDE E IMAGEM - CSI' when 'RM/TC' then 'CLÍNICA DE SAÚDE E IMAGEM - RM/TC' when 'CSI RM/TC' then 'CLÍNICA DE SAÚDE E IMAGEM - RM/TC'
                 when 'DESENVOAR' then 'DESENVOAR' end;

  select (select max(m.valido_desde) from public.agenda_ocupacao_meta m where m.id = 1) into v_meta;
  with h as materialized (
    select h.data, h.hora, case when public.norm_nome(h.unidade) like '%RM TC' then 'RM/TC' when public.norm_nome(h.unidade) like '%CSI' then 'CSI' when public.norm_nome(h.unidade) = 'DESENVOAR' then 'DESENVOAR' else h.unidade end as unidade, h.profissional
    from public.agenda_horarios(array[p_procedimento], v_hoje, v_ate_dia, v_unid, null, null, '[]'::jsonb, 120) h
    where (v_turno = 'qualquer' or (v_turno = 'manha' and h.hora < '12:00') or (v_turno = 'tarde' and h.hora >= '12:00' and h.hora < '18:00') or (v_turno = 'noite' and h.hora >= '18:00'))
      and (v_apos is null or h.hora::time >= v_apos) and (v_ate is null or h.hora::time <= v_ate)
  ), dias as (select distinct h.data from h order by h.data limit 10)
  select (select count(*) from h),
         coalesce((select jsonb_agg(jsonb_build_object('data', dd.data, 'slots', (select jsonb_agg(jsonb_build_object('hora', s.hora, 'unidade', s.unidade, 'profissional', s.profissional) order by s.hora)
                                                                                    from (select * from h where h.data = dd.data order by h.hora limit 8) s)) order by dd.data) from dias dd), '[]'::jsonb)
    into v_total, v_dias;
  return jsonb_build_object('ok', true, 'procedimento', jsonb_build_object('id', v_proc.id, 'nome', v_proc.nome), 'de', v_hoje, 'ate', v_ate_dia, 'total', v_total,
    'dias', v_dias, 'atualizado_em', v_meta,
    'aviso', 'Estes horários são uma PREVISÃO a partir da agenda da clínica. Não estão reservados nem confirmados: a nossa equipe confirma pelo webchat, WhatsApp e telefone. Alguns profissionais não atendem todos os planos: a equipe confere o seu.');
end $$;

-- ---------- 3) pedido de previsão ----------
-- p_dados: { procedimento_id, procedimento_texto, turno, hora_apos, hora_ate, data_ate, unidade, horario: {data, hora, unidade, profissional}, sem_preferencia: true, observacao }.
-- Tudo opcional: quem só quer ver a disponibilidade e pedir para a equipe olhar manda só o exame.
create or replace function public.pmarc_pedido(p_codigo text, p_dados jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.pmarc_pessoa; d jsonb := case when jsonb_typeof(p_dados) = 'object' then p_dados else '{}'::jsonb end;
  v_pid integer; v_nome text; v_txt text; v_turno text; v_apos text; v_ate text; v_dia date; v_unid text; v_obs text; v_plano text; v_h jsonb; v_hdata date; v_hhora text; v_msg text; v_ped jsonb; v_conv uuid; v_lista jsonb;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  select * into p from public.pmarc_pessoa where codigo = btrim(coalesce(p_codigo, '')) for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;
  if (select count(*) from jsonb_array_elements(coalesce(p.informado -> 'pedidos', '[]'::jsonb)) e where (e ->> 'em')::timestamptz > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'motivo', 'muitos');
  end if;
  begin v_pid := nullif(d ->> 'procedimento_id', '')::integer; exception when others then v_pid := null; end;
  if v_pid is not null then select nome into v_nome from public.catalogo_procedimento where id = v_pid; if v_nome is null then v_pid := null; end if; end if;
  v_txt := nullif(left(btrim(coalesce(d ->> 'procedimento_texto', '')), 200), '');
  v_turno := case when d ->> 'turno' in ('manha', 'tarde', 'noite') then d ->> 'turno' end;
  v_apos := case when coalesce(d ->> 'hora_apos', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then d ->> 'hora_apos' end;
  v_ate := case when coalesce(d ->> 'hora_ate', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then d ->> 'hora_ate' end;
  begin v_dia := nullif(d ->> 'data_ate', '')::date; exception when others then v_dia := null; end;
  v_unid := nullif(left(btrim(coalesce(d ->> 'unidade', '')), 40), '');
  v_obs := nullif(left(btrim(coalesce(d ->> 'observacao', '')), 1000), '');
  v_plano := nullif(left(btrim(coalesce(d ->> 'plano', '')), 80), '');
  v_h := case when jsonb_typeof(d -> 'horario') = 'object' then d -> 'horario' end;
  if v_h is not null then
    begin v_hdata := (v_h ->> 'data')::date; exception when others then v_hdata := null; end;
    v_hhora := case when coalesce(v_h ->> 'hora', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then v_h ->> 'hora' end;
    if v_hdata is null or v_hhora is null then v_h := null; end if;
  end if;

  v_ped := jsonb_strip_nulls(jsonb_build_object('em', now(), 'procedimento_id', v_pid, 'procedimento', coalesce(v_nome, v_txt), 'turno', v_turno, 'hora_apos', v_apos, 'hora_ate', v_ate,
    'data_ate', v_dia, 'unidade', v_unid, 'observacao', v_obs, 'plano', v_plano, 'sem_preferencia', (v_turno is null and v_apos is null and v_ate is null and v_dia is null and v_h is null),
    'horario', case when v_h is not null then jsonb_build_object('data', v_hdata, 'hora', v_hhora, 'unidade', left(v_h ->> 'unidade', 40), 'profissional', left(v_h ->> 'profissional', 80)) end));
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_lista from (select e from jsonb_array_elements(coalesce(p.informado -> 'pedidos', '[]'::jsonb) || jsonb_build_array(v_ped)) with ordinality t(e, o) order by o desc limit 10) z;
  update public.pmarc_pessoa set informado = informado || jsonb_build_object('pedidos', v_lista), aceitou_lgpd_em = coalesce(aceitou_lgpd_em, now()),
    ultimo_acesso_em = now(), atualizado_em = now() where id = p.id;

  v_conv := public.pmarc_conversa_garantir(p.id);
  if v_conv is not null then
    v_msg := 'Pedido de previsão: ' || coalesce(v_nome, v_txt, 'não escolheu o exame (quer conversar)') || '.'
      || case when v_h is not null then E'\nHorário que viu: ' || to_char(v_hdata, 'DD/MM/YYYY') || ' ' || v_hhora
            || coalesce(' · ' || nullif(v_h ->> 'unidade', ''), '') || coalesce(' · ' || nullif(v_h ->> 'profissional', ''), '') || ' (previsão, não reservado)' else '' end
      || case when v_turno is not null then E'\nTurno: ' || case v_turno when 'manha' then 'manhã' when 'tarde' then 'tarde' else 'noite' end else '' end
      || case when v_apos is not null then E'\nA partir das: ' || v_apos else '' end
      || case when v_ate is not null then E'\nAté as: ' || v_ate else '' end
      || case when v_dia is not null then E'\nAté o dia: ' || to_char(v_dia, 'DD/MM/YYYY') else '' end
      || case when v_unid is not null then E'\nUnidade: ' || v_unid else '' end
      || case when v_turno is null and v_apos is null and v_ate is null and v_dia is null and v_h is null then E'\nSem preferência de horário: só quer ver a disponibilidade.' else '' end
      || case when v_plano is not null then E'\nPlano/convênio informado: ' || v_plano || ' (conferir; cobertura e valor são com a equipe)' else '' end
      || case when v_obs is not null then E'\nObservação: ' || v_obs else '' end;
    insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'cliente', v_msg);
    if coalesce(p.informado ->> 'final_em', '') = '' then
      insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'agente', public.pmarc_texto('previsao_marcacao_final'));
      update public.pmarc_pessoa set informado = informado || jsonb_build_object('final_em', now()) where id = p.id;
    end if;
  end if;
  return public.pmarc_vista(p.id) || jsonb_build_object('sem_celular', v_conv is null);
end $$;

-- ---------- permissões ----------
revoke all on function public.pmarc_tipo_proc(text) from public, anon, authenticated;
grant execute on function public.pmarc_tipo_proc(text) to service_role;
do $$
declare f text;
begin
  foreach f in array array['pmarc_catalogo(text, text)', 'pmarc_disponibilidade(integer, jsonb)', 'pmarc_pedido(text, jsonb)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', f);
  end loop;
end $$;
