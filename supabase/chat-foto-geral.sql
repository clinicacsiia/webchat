-- Foto livre enviada pelo paciente no chat (câmera ou galeria): não é o pedido médico.
-- Fica em conversa_anexo com tipo 'foto'; a equipe vê na própria conversa. Não entra na pendência "conferir no Klingo".

create or replace function public.chat_foto_enviar(p_conversa uuid, p_token text, p_mime text, p_base64 text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_bin bytea; v_id bigint; v_msg bigint;
begin
  perform public.chat_valida(p_conversa, p_token);
  if p_mime not in ('image/jpeg', 'image/png', 'image/webp') then raise exception 'Envie uma foto (JPG ou PNG).' using errcode = '22023'; end if;
  if length(coalesce(p_base64, '')) > 2000000 then raise exception 'A foto é grande demais. Tente de novo.' using errcode = '22023'; end if;
  if (select count(*) from public.conversa_anexo where conversa_id = p_conversa and tipo = 'foto') >= 10 then raise exception 'Limite de fotos desta conversa atingido.' using errcode = '54000'; end if;
  begin v_bin := decode(regexp_replace(p_base64, '^data:[^,]*,', ''), 'base64'); exception when others then raise exception 'Foto inválida.' using errcode = '22023'; end;
  insert into public.conversa_anexo (conversa_id, tipo, mime, dados) values (p_conversa, 'foto', p_mime, v_bin) returning id into v_id;
  insert into public.mensagens (conversa_id, autor, texto, opcoes) values (p_conversa, 'cliente', 'Foto enviada.', jsonb_build_object('tipo', 'anexo', 'id', v_id, 'geral', true))
  returning id into v_msg;
  return jsonb_build_object('ok', true, 'id', v_id, 'mensagem_id', v_msg);
end $$;
revoke all on function public.chat_foto_enviar(uuid, text, text, text) from public;
grant execute on function public.chat_foto_enviar(uuid, text, text, text) to anon, authenticated;

-- A pendência do Klingo e a contagem de "fotos do pedido" só consideram o pedido médico.
create or replace function public.painel_anexos_resumo() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('conversa_id', q.conversa_id, 'total', q.n, 'sem_conferir', q.sc, 'ultima', q.ult, 'ids', q.ids) order by q.ult desc)
    from (select a.conversa_id, count(*)::int n, (count(*) filter (where a.klingo_conferido_em is null))::int sc, max(a.criado_em) ult, jsonb_agg(a.id order by a.id) ids
          from public.conversa_anexo a where a.criado_em > now() - interval '120 days' and a.tipo = 'pedido_medico' group by a.conversa_id) q), '[]'::jsonb);
end $$;
