-- FLUXOGRAMA: entrada (página previsao/index.html, tela "Quando você prefere?": o seletor Unidade; e a disponibilidade e a lista de exames da Previsão)
--   -> validação (interruptor `previsao_marcacao_modo`; exame existente e ativo; unidade desconhecida = sem filtro; NADA barra a pessoa)
--   -> lógica (unidade vale só se o catálogo dela está LIGADO em Configurações > Catálogos do chat (unidade_config.ativo = config catalogo_<chave>) E se o exame escolhido tem agenda nela;
--      a disponibilidade só devolve horários das unidades com catálogo ligado; a lista marca "agenda" só se a agenda está numa unidade ligada)
--   -> saída (pmarc_unidades(exame) = unidades que a página oferece; disponibilidade e lista já filtradas) | ROLLBACK: previsao-marcacao-parte6-rollback.sql
-- Versão 1.0 — 17/11/2026 / Mudança: pedido do dono ("a unidade depende de qual exame foi escolhido; preciso que respeite o catálogo também"). Antes o seletor mostrava sempre CSI, Desenvoar e CSI RM/TC.
--
-- Nova função aberta ao `anon` (igual às outras pmarc_*): pmarc_unidades(p_procedimento). Alteradas (create or replace, mesma assinatura): pmarc_disponibilidade e pmarc_catalogo.
-- Sem "drop": a ferramenta de migração pede confirmação para comandos que parecem destrutivos e expira em 60 s.

-- ---------- Parte 1: unidades que a página oferece para o exame escolhido ----------
create or replace function public.pmarc_unidades(p_procedimento integer default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $f$
declare v_u jsonb;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  select coalesce(jsonb_agg(jsonb_build_object('chave', case u.chave when 'csi' then 'CSI' when 'rmtc' then 'RM/TC' when 'desenvoar' then 'DESENVOAR' else upper(u.chave) end, 'rotulo', u.rotulo) order by u.ordem), '[]'::jsonb) into v_u
    from public.unidade_config u
   where u.ativo
     and (p_procedimento is null or exists (select 1 from public.catalogo_agenda a
                                             where a.procedimento_id = p_procedimento and a.unidade = u.catalogo and a.vig_fim >= current_date and a.profissional !~* 'teste'));
  return jsonb_build_object('ok', true, 'unidades', v_u);
end $f$;
revoke all on function public.pmarc_unidades(integer) from public;
grant execute on function public.pmarc_unidades(integer) to anon, authenticated, service_role;

-- ---------- Parte 2: disponibilidade só das unidades com catálogo ligado ----------
CREATE OR REPLACE FUNCTION public.pmarc_disponibilidade(p_procedimento integer, p_dados jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    where public.unidade_chave(h.unidade) in (select u.chave from public.unidade_config u where u.ativo)
      and (v_turno = 'qualquer' or (v_turno = 'manha' and h.hora < '12:00') or (v_turno = 'tarde' and h.hora >= '12:00' and h.hora < '18:00') or (v_turno = 'noite' and h.hora >= '18:00'))
      and (v_apos is null or h.hora::time >= v_apos) and (v_ate is null or h.hora::time <= v_ate)
  ), dias as (select distinct h.data from h order by h.data limit 10)
  select (select count(*) from h),
         coalesce((select jsonb_agg(jsonb_build_object('data', dd.data, 'slots', (select jsonb_agg(jsonb_build_object('hora', s.hora, 'unidade', s.unidade, 'profissional', s.profissional) order by s.hora)
                                                                                    from (select * from h where h.data = dd.data order by h.hora limit 8) s)) order by dd.data) from dias dd), '[]'::jsonb)
    into v_total, v_dias;
  return jsonb_build_object('ok', true, 'procedimento', jsonb_build_object('id', v_proc.id, 'nome', v_proc.nome), 'de', v_hoje, 'ate', v_ate_dia, 'total', v_total,
    'dias', v_dias, 'atualizado_em', v_meta,
    'aviso', 'Estes horários são uma PREVISÃO a partir da agenda da clínica. Não estão reservados nem confirmados: a nossa equipe confirma pelo webchat, WhatsApp e telefone. Alguns profissionais não atendem todos os planos: a equipe confere o seu.');
end $function$;

-- ---------- Parte 3: lista de exames (agenda só conta se estiver numa unidade ligada) ----------
CREATE OR REPLACE FUNCTION public.pmarc_catalogo(p_busca text DEFAULT NULL::text, p_tipo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_busca text := nullif(btrim(public.norm_nome(left(coalesce(p_busca, ''), 60))), ''); v_tipo text := nullif(btrim(coalesce(p_tipo, '')), ''); v_itens jsonb;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  if v_tipo is not null and v_tipo not in ('consulta', 'exame', 'outro') then v_tipo := null; end if;
  -- os "feitos" são contados UMA vez (agrupados por nome) e ligados ao catálogo por junção; a versão com subconsulta por procedimento passava de 60 s na produção
  with feitos as (
    select public.norm_nome(e.procedimento) as n, count(*) as c from public.jornada_exame e
     where e.status = 'atendido' and e.agendado_para >= now() - interval '30 days' and e.agendado_para < now() group by 1
  ), com_agenda as (
    select distinct a.procedimento_id from public.catalogo_agenda a join public.unidade_config u on u.catalogo = a.unidade and u.ativo
     where a.vig_fim >= current_date and a.profissional !~* 'teste'
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
end $function$;
