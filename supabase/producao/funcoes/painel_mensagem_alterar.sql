-- public.painel_mensagem_alterar(p_id bigint, p_texto text, p_excluir boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_mensagem_alterar(p_id bigint, p_texto text, p_excluir boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m public.mensagens%rowtype; v_papel text; v_txt text; v_token text;
begin
  v_papel := public.papel_atual();
  if v_papel is null or v_papel not in ('admin','atendente') then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into m from public.mensagens where id = p_id for update;
  if not found then raise exception 'Mensagem não encontrada.' using errcode = '22023'; end if;
  if m.autor <> 'agente' or m.agente_id is null or m.opcoes is not null
     or (m.agente_id <> (select auth.uid()) and v_papel <> 'admin') then
    raise exception 'Só dá para alterar mensagens de atendente escritas à mão.' using errcode = '42501';
  end if;
  if m.excluida_em is not null then raise exception 'Mensagem já apagada.' using errcode = '22023'; end if;
  if p_excluir then
    update public.mensagens set texto = 'Mensagem apagada', excluida_em = now() where id = p_id returning * into m;
  else
    v_txt := btrim(coalesce(p_texto, ''));
    if v_txt = '' or char_length(v_txt) > 4000 then raise exception 'Mensagem inválida.' using errcode = '22023'; end if;
    if v_txt = m.texto then return jsonb_build_object('id', m.id, 'texto', m.texto); end if;
    update public.mensagens set texto = v_txt, editada_em = now() where id = p_id returning * into m;
  end if;
  update public.conversas set ultima_mensagem = left(m.texto, 140)
   where id = m.conversa_id and not exists (select 1 from public.mensagens x where x.conversa_id = m.conversa_id and x.id > m.id);
  select token into v_token from public.conversa_segredo where conversa_id = m.conversa_id;
  if v_token is not null then
    begin
      perform realtime.send(jsonb_build_object('id', m.id, 'texto', m.texto, 'editada_em', m.editada_em, 'excluida_em', m.excluida_em), 'alt', 'conversa:' || v_token, false);
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('id', m.id, 'texto', m.texto, 'editada_em', m.editada_em, 'excluida_em', m.excluida_em);
end $function$;

