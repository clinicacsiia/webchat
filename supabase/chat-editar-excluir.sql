-- Atendente edita ou exclui uma mensagem que ele mesmo enviou (admin: de qualquer atendente).
-- A exclusão é lógica: a conversa mostra "Mensagem apagada" para a equipe e para o paciente.

alter table public.mensagens add column if not exists editada_em timestamptz;
alter table public.mensagens add column if not exists excluida_em timestamptz;

create or replace function public.painel_mensagem_alterar(p_id bigint, p_texto text, p_excluir boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare m public.mensagens%rowtype; v_papel text; v_txt text; v_token text; v_nome text;
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
end $$;
revoke all on function public.painel_mensagem_alterar(bigint, text, boolean) from public, anon;
grant execute on function public.painel_mensagem_alterar(bigint, text, boolean) to authenticated;

-- O paciente recebe também as mensagens alteradas nas últimas 24 h (o cursor por id não pega edição).
create or replace function public.chat_listar(p_conversa uuid, p_token text, p_apos bigint default 0)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_status text; v_agente text; v_motor boolean; v_passo text;
begin
  select c.status, a.nome, (c.motor = 'fluxo' and c.ia_ativa and c.status = 'aguardando'), f.passo into v_status, v_agente, v_motor, v_passo
  from public.conversas c
  join public.conversa_segredo s on s.conversa_id = c.id
  left join public.agentes a on a.id = c.agente_id
  left join public.conversa_fluxo f on f.conversa_id = c.id
  where c.id = p_conversa and s.token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  return jsonb_build_object('status', v_status, 'agente', v_agente, 'motor_ativo', coalesce(v_motor, false), 'passo', v_passo,
    'mensagens', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'autor', m.autor, 'texto', m.texto, 'opcoes', m.opcoes, 'criado_em', m.criado_em,
                                          'editada_em', m.editada_em, 'excluida_em', m.excluida_em,
                                          'agente', coalesce(ag.nome, case when m.autor = 'agente' then 'Assistente virtual' end)) order by m.id)
      from (select * from public.mensagens where conversa_id = p_conversa and id > coalesce(p_apos, 0) order by id limit 200) m
      left join public.agentes ag on ag.id = m.agente_id), '[]'::jsonb),
    'alteradas', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'texto', x.texto, 'editada_em', x.editada_em, 'excluida_em', x.excluida_em) order by x.id)
      from (select id, texto, editada_em, excluida_em from public.mensagens
             where conversa_id = p_conversa and id <= coalesce(p_apos, 0)
               and greatest(editada_em, excluida_em) > now() - interval '24 hours' order by id desc limit 50) x), '[]'::jsonb));
end $$;
