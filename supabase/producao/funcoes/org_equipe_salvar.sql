-- public.org_equipe_salvar(p_id bigint, p_nome text, p_unidade text, p_transversal boolean, p_ativa boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.org_equipe_salvar(p_id bigint, p_nome text, p_unidade text DEFAULT NULL::text, p_transversal boolean DEFAULT false, p_ativa boolean DEFAULT true)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id bigint; v_antes jsonb;
begin
  if public.org_nivel() not in ('ti', 'gerente') then raise exception 'Somente TI e gerência alteram equipes.' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_nome, ''))) < 2 then raise exception 'Informe o nome da equipe.' using errcode = '22023'; end if;
  if nullif(btrim(coalesce(p_unidade, '')), '') is not null and not exists (select 1 from public.unidade_config where chave = btrim(p_unidade)) then raise exception 'Unidade inválida.' using errcode = '22023'; end if;
  if p_id is null then
    insert into public.org_equipe (nome, unidade, transversal, ativa) values (btrim(p_nome), nullif(btrim(coalesce(p_unidade, '')), ''), coalesce(p_transversal, false), coalesce(p_ativa, true)) returning id into v_id;
    insert into public.org_alteracao_log (por, acao, alvo, depois) values ((select auth.uid()), 'equipe_criada', 'equipe:' || v_id, jsonb_build_object('nome', btrim(p_nome), 'unidade', p_unidade));
  else
    select to_jsonb(e) into v_antes from public.org_equipe e where e.id = p_id;
    update public.org_equipe set nome = btrim(p_nome), unidade = nullif(btrim(coalesce(p_unidade, '')), ''), transversal = coalesce(p_transversal, false), ativa = coalesce(p_ativa, true) where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Equipe não encontrada.' using errcode = '22023'; end if;
    insert into public.org_alteracao_log (por, acao, alvo, antes, depois) values ((select auth.uid()), 'equipe_alterada', 'equipe:' || v_id, v_antes, (select to_jsonb(e) from public.org_equipe e where e.id = v_id));
  end if;
  return v_id;
end $function$;

