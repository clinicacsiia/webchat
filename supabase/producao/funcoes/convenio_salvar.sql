-- public.convenio_salvar(p_operadora text, p_dados jsonb)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.convenio_salvar(p_operadora text, p_dados jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ch text := public.convenio_chave(p_operadora); v_nome text := initcap(lower(btrim(coalesce(p_operadora, '')))); c public.convenio_config; n public.convenio_config;
  v_uid uuid := (select auth.uid()); v_em int; v_30 int;
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  if v_ch = '' or length(v_ch) > 120 then raise exception 'Convênio inválido.' using errcode = '22023'; end if;
  if p_dados is null or jsonb_typeof(p_dados) <> 'object' then raise exception 'Dados inválidos.' using errcode = '22023'; end if;
  if v_ch ~ '^PARTICULAR' and (p_dados ? 'ativo') and not (p_dados ->> 'ativo')::boolean then raise exception 'O Particular não pode ser desativado.' using errcode = '22023'; end if;
  select * into c from public.convenio_config where operadora = v_ch;
  n := c;
  n.operadora := v_ch;
  n.ativo := coalesce(case when p_dados ? 'ativo' then (p_dados ->> 'ativo')::boolean end, c.ativo, true);
  n.um_por_vez := coalesce(case when p_dados ? 'um_por_vez' then (p_dados ->> 'um_por_vez')::boolean end, c.um_por_vez, false);
  if p_dados ? 'mensagem_inativo' then n.mensagem_inativo := nullif(left(btrim(p_dados ->> 'mensagem_inativo'), 600), ''); end if;
  if p_dados ? 'aviso' then n.aviso := nullif(left(btrim(p_dados ->> 'aviso'), 600), ''); end if;
  if p_dados ? 'msg_varios' then n.msg_varios := nullif(left(btrim(p_dados ->> 'msg_varios'), 600), ''); end if;
  if p_dados ? 'motivo' then n.motivo := nullif(left(btrim(p_dados ->> 'motivo'), 200), ''); end if;
  n.atualizado_em := now(); n.atualizado_por := v_uid;
  insert into public.convenio_config (operadora, ativo, mensagem_inativo, aviso, um_por_vez, msg_varios, motivo, atualizado_em, atualizado_por)
    values (n.operadora, n.ativo, n.mensagem_inativo, n.aviso, n.um_por_vez, n.msg_varios, n.motivo, n.atualizado_em, n.atualizado_por)
    on conflict (operadora) do update set ativo = excluded.ativo, mensagem_inativo = excluded.mensagem_inativo, aviso = excluded.aviso, um_por_vez = excluded.um_por_vez,
      msg_varios = excluded.msg_varios, motivo = excluded.motivo, atualizado_em = excluded.atualizado_em, atualizado_por = excluded.atualizado_por;
  if coalesce(c.ativo, true) is distinct from n.ativo then
    insert into public.convenio_evento (operadora, tipo, descricao, antes, depois, relevante, origem, visto_em, visto_por)
      values (v_ch, case when n.ativo then 'ativado' else 'desativado' end, v_nome || (case when n.ativo then ' foi ativado' else ' foi desativado' end) || coalesce(' (' || n.motivo || ')', ''),
              case when coalesce(c.ativo, true) then 'ativo' else 'desativado' end, case when n.ativo then 'ativo' else 'desativado' end, true, 'painel', now(), v_uid);
  end if;
  if coalesce(c.um_por_vez, false) is distinct from n.um_por_vez then
    insert into public.convenio_evento (operadora, tipo, descricao, antes, depois, origem, visto_em, visto_por)
      values (v_ch, 'regra', v_nome || (case when n.um_por_vez then ': passou a fazer um exame por vez' else ': deixou de limitar a um exame por vez' end),
              case when coalesce(c.um_por_vez, false) then 'um por vez' else 'sem limite' end, case when n.um_por_vez then 'um por vez' else 'sem limite' end, 'painel', now(), v_uid);
  end if;
  if (coalesce(c.mensagem_inativo, '') is distinct from coalesce(n.mensagem_inativo, '')) or (coalesce(c.aviso, '') is distinct from coalesce(n.aviso, '')) or (coalesce(c.msg_varios, '') is distinct from coalesce(n.msg_varios, '')) then
    insert into public.convenio_evento (operadora, tipo, descricao, origem, visto_em, visto_por) values (v_ch, 'mensagem', v_nome || ': mensagem alterada', 'painel', now(), v_uid);
  end if;
  select count(*) into v_em from public.pre_agendamentos where public.convenio_chave(plano) = v_ch and status = 'rascunho';
  select d.ult_30d into v_30 from public.convenio_demanda() d where d.chave = v_ch;
  return jsonb_build_object('ok', true, 'operadora', v_nome, 'ativo', n.ativo, 'um_por_vez', n.um_por_vez, 'em_andamento', v_em, 'agendamentos_30d', coalesce(v_30, 0));
end $function$;

