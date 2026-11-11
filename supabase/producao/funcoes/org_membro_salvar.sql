-- public.org_membro_salvar(p_id bigint, p_equipe bigint, p_agente uuid, p_rotulo text, p_funcao text, p_ativo boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.org_membro_salvar(p_id bigint, p_equipe bigint, p_agente uuid, p_rotulo text, p_funcao text, p_ativo boolean DEFAULT true)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_nivel text := public.org_nivel(); v_uid uuid := (select auth.uid()); v_id bigint; v_antes jsonb; v_rot text := nullif(btrim(coalesce(p_rotulo, '')), '');
begin
  if v_nivel is null or v_nivel = 'atendente' then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_funcao not in ('ti', 'gerente', 'supervisor', 'atendente') then raise exception 'Função inválida.' using errcode = '22023'; end if;
  if p_agente is null and v_rot is null then raise exception 'Informe a conta ou um nome provisório.' using errcode = '22023'; end if;
  if p_funcao in ('ti', 'gerente') and p_equipe is not null then raise exception 'TI e gerência são funções gerais, sem equipe.' using errcode = '22023'; end if;
  if p_funcao in ('supervisor', 'atendente') and p_equipe is null then raise exception 'Escolha a equipe.' using errcode = '22023'; end if;
  if p_funcao = 'ti' and v_nivel <> 'ti' then raise exception 'Somente a TI concede a função de TI.' using errcode = '42501'; end if;
  if p_funcao in ('gerente', 'supervisor') and v_nivel not in ('ti', 'gerente') then raise exception 'Somente TI e gerência concedem essa função.' using errcode = '42501'; end if;
  if v_nivel = 'supervisor' and not exists (select 1 from public.org_membro s where s.equipe_id = p_equipe and s.agente_id = v_uid and s.funcao = 'supervisor' and s.ativo) then
    raise exception 'A supervisão só mexe na própria equipe.' using errcode = '42501';
  end if;
  if p_id is null then
    insert into public.org_membro (equipe_id, agente_id, rotulo, funcao, ativo) values (p_equipe, p_agente, v_rot, p_funcao, coalesce(p_ativo, true)) returning id into v_id;
    insert into public.org_alteracao_log (por, acao, alvo, depois) values (v_uid, 'membro_criado', 'membro:' || v_id, jsonb_build_object('equipe', p_equipe, 'agente', p_agente, 'rotulo', v_rot, 'funcao', p_funcao));
  else
    select to_jsonb(m) into v_antes from public.org_membro m where m.id = p_id;
    if v_antes is null then raise exception 'Membro não encontrado.' using errcode = '22023'; end if;
    if (v_antes ->> 'funcao') = 'ti' and v_nivel <> 'ti' or (v_antes ->> 'funcao') in ('gerente', 'supervisor') and v_nivel not in ('ti', 'gerente') then raise exception 'Sem permissão para alterar essa função.' using errcode = '42501'; end if;
    update public.org_membro set equipe_id = p_equipe, agente_id = p_agente, rotulo = v_rot, funcao = p_funcao, ativo = coalesce(p_ativo, true), fim = case when coalesce(p_ativo, true) then null else coalesce(fim, current_date) end where id = p_id returning id into v_id;
    insert into public.org_alteracao_log (por, acao, alvo, antes, depois) values (v_uid, 'membro_alterado', 'membro:' || v_id, v_antes, (select to_jsonb(m) from public.org_membro m where m.id = v_id));
  end if;
  return v_id;
end $function$;

