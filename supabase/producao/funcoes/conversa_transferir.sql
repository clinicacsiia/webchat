-- public.conversa_transferir(p_conversas uuid[], p_para_agente uuid, p_para_unidade text, p_motivo text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conversa_transferir(p_conversas uuid[], p_para_agente uuid DEFAULT NULL::uuid, p_para_unidade text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid()); v_papel text := (select public.papel_atual()); v_modo text; r record; v_ids uuid[];
  v_inv jsonb := '[]'::jsonb; v_ok uuid[] := '{}'; v_dest public.agentes; v_motivo text := nullif(left(btrim(coalesce(p_motivo, '')), 300), ''); v_uni text := nullif(btrim(coalesce(p_para_unidade, '')), ''); v_n integer; v_quem text;
begin
  if v_papel not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '42501'; end if;
  if (p_para_agente is null) = (v_uni is null) then raise exception 'Escolha uma pessoa OU uma unidade.' using errcode = '22023'; end if;
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_conversas, '{}')) x;
  if v_ids is null then raise exception 'Escolha ao menos uma conversa.' using errcode = '22023'; end if;
  if cardinality(v_ids) > 50 then raise exception 'No máximo 50 conversas por vez.' using errcode = '22023'; end if;
  if p_para_agente is not null then
    select * into v_dest from public.agentes where id = p_para_agente and ativo and papel in ('admin', 'atendente');
    if not found then raise exception 'Essa pessoa não pode receber conversas.' using errcode = '22023'; end if;
  elsif not exists (select 1 from public.unidade_config where chave = v_uni and ativo) then
    raise exception 'Unidade inválida.' using errcode = '22023';
  end if;
  v_modo := coalesce((select valor from public.config where chave = 'permissao_modo'), 'desligado');
  for r in select c.id, c.status, c.agente_id, coalesce(c.unidade_responsavel, c.unidade_inicial) as un from public.conversas c where c.id = any (v_ids) order by c.id for update loop
    if r.status = 'encerrada' then v_inv := v_inv || jsonb_build_object('id', r.id, 'motivo', 'A conversa está encerrada.'); continue; end if;
    if p_para_agente is not null and r.agente_id = p_para_agente then v_inv := v_inv || jsonb_build_object('id', r.id, 'motivo', 'Já está com essa pessoa.'); continue; end if;
    if v_uni is not null and r.un is not distinct from v_uni and r.agente_id is null then v_inv := v_inv || jsonb_build_object('id', r.id, 'motivo', 'Já está na fila dessa unidade.'); continue; end if;
    if not public.org_pode_ver(v_uid, v_papel, r.agente_id, r.un) then
      insert into public.permissao_observacao (agente_id, acao, conversa_id, unidade, detalhe) values (v_uid, 'transferir', r.id, r.un, jsonb_build_object('modo', v_modo));
      if v_modo = 'ligado' then v_inv := v_inv || jsonb_build_object('id', r.id, 'motivo', 'Sem permissão para esta conversa.'); continue; end if;
    end if;
    v_ok := v_ok || r.id;
  end loop;
  select count(*) into v_n from public.conversas where id = any (v_ids);
  if v_n <> cardinality(v_ids) then v_inv := v_inv || jsonb_build_object('id', null, 'motivo', 'Alguma conversa não foi encontrada.'); end if;
  if jsonb_array_length(v_inv) > 0 then
    return jsonb_build_object('ok', false, 'transferidas', 0, 'recusadas', v_inv, 'mensagem', 'Nada foi transferido: ' || jsonb_array_length(v_inv) || ' conversa(s) não podem ser transferidas.');
  end if;
  for r in select c.id, c.agente_id, coalesce(c.unidade_responsavel, c.unidade_inicial) as un from public.conversas c where c.id = any (v_ok) loop
    if p_para_agente is not null then
      update public.conversas set agente_id = p_para_agente, status = case when status = 'aguardando' then 'em_atendimento' else status end where id = r.id;
    else
      update public.conversas set agente_id = null, unidade_responsavel = v_uni, status = 'aguardando' where id = r.id;
    end if;
    insert into public.conversa_evento (conversa_id, tipo, de_agente, para_agente, por, motivo, detalhe)
    values (r.id, 'transferencia', r.agente_id, p_para_agente, v_uid, v_motivo, jsonb_build_object('de_unidade', r.un, 'para_unidade', coalesce(v_uni, r.un), 'lote', cardinality(v_ok)));
  end loop;
  select coalesce(nome, 'Alguém') into v_quem from public.agentes where id = v_uid;
  if p_para_agente is not null then
    insert into public.equipe_notificacao (agente_id, tipo, conversa_id, detalhe)
    values (p_para_agente, 'transferida_para_voce', case when cardinality(v_ok) = 1 then v_ok[1] end, jsonb_build_object('de', v_quem, 'quantidade', cardinality(v_ok), 'motivo', v_motivo));
  else
    insert into public.equipe_notificacao (agente_id, tipo, conversa_id, detalhe)
    select distinct m.agente_id, 'transferida_para_unidade', case when cardinality(v_ok) = 1 then v_ok[1] end, jsonb_build_object('de', v_quem, 'quantidade', cardinality(v_ok), 'unidade', v_uni, 'motivo', v_motivo)
      from public.org_membro m join public.org_equipe e on e.id = m.equipe_id
     where m.ativo and m.agente_id is not null and m.agente_id <> v_uid and e.ativa and (e.unidade = v_uni or e.transversal);
  end if;
  return jsonb_build_object('ok', true, 'transferidas', cardinality(v_ok), 'recusadas', '[]'::jsonb);
end $function$;

