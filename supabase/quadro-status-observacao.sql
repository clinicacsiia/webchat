-- Cartão: mudar o status para qualquer etapa (cancelado, concluído...) e registrar observação (03/11/2026).
create or replace function public.jornada_definir_status(p_card bigint, p_para text, p_versao integer, p_nota text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  c public.jornada_card%rowtype;
  v_nota text := nullif(trim(coalesce(p_nota, '')), '');
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if not public.jornada_pode() then raise exception 'Sem permissão para a Jornada.'; end if;
  select * into c from public.jornada_card where id = p_card for update;
  if not found then raise exception 'Card não encontrado.'; end if;
  if c.versao <> p_versao then raise exception 'CONFLITO: o card foi alterado por outra pessoa. Atualize a tela e tente de novo.'; end if;
  if c.arquivado_em is not null then raise exception 'Card arquivado.'; end if;
  if c.coluna = p_para then raise exception 'O card já está nesta coluna.'; end if;
  if not exists (select 1 from public.jornada_coluna where id = p_para and ativa) then raise exception 'Coluna não existe.'; end if;
  if p_para in ('cancelado', 'perdido') and (v_nota is null or char_length(v_nota) < 3) then
    raise exception 'Diga o motivo (mínimo 3 letras).';
  end if;
  update public.jornada_card set coluna = p_para, coluna_desde = now(), versao = versao + 1, atualizado_em = now() where id = c.id;
  insert into public.jornada_evento (card_id, tipo, origem, usuario, de_coluna, para_coluna, detalhe)
  values (c.id, 'movido', 'pessoa', auth.uid(), c.coluna, p_para, case when v_nota is null then '{}'::jsonb else jsonb_build_object('nota', left(v_nota, 500)) end);
  return jsonb_build_object('ok', true, 'versao', c.versao + 1);
end $$;
revoke all on function public.jornada_definir_status(bigint, text, integer, text) from public, anon;
grant execute on function public.jornada_definir_status(bigint, text, integer, text) to authenticated;

create or replace function public.jornada_anotar_card(p_card bigint, p_nota text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_nota text := nullif(trim(coalesce(p_nota, '')), '');
begin
  if auth.uid() is null then raise exception 'Faça login.'; end if;
  if not public.jornada_pode() then raise exception 'Sem permissão para a Jornada.'; end if;
  if v_nota is null then raise exception 'Escreva a observação.'; end if;
  if not exists (select 1 from public.jornada_card where id = p_card) then raise exception 'Card não encontrado.'; end if;
  insert into public.jornada_evento (card_id, tipo, origem, usuario, detalhe)
  values (p_card, 'nota', 'pessoa', auth.uid(), jsonb_build_object('nota', left(v_nota, 1000)));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.jornada_anotar_card(bigint, text) from public, anon;
grant execute on function public.jornada_anotar_card(bigint, text) to authenticated;
