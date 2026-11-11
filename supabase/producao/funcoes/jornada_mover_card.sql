-- public.jornada_mover_card(p_card bigint, p_para text, p_versao integer, p_nota text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_mover_card(p_card bigint, p_para text, p_versao integer, p_nota text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if not exists (select 1 from public.jornada_transicao t join public.jornada_coluna k on k.id = t.para where t.de = c.coluna and t.para = p_para and k.ativa and k.origem = 'manual') then
    raise exception 'Movimento não permitido: de "%" para "%".', c.coluna, p_para;
  end if;
  if p_para = 'perdido' and (v_nota is null or char_length(v_nota) < 3) then
    raise exception 'Diga o motivo de perder o contato (mínimo 3 letras).';
  end if;

  update public.jornada_card set coluna = p_para, coluna_desde = now(), versao = versao + 1, atualizado_em = now() where id = c.id;
  insert into public.jornada_evento (card_id, tipo, origem, usuario, de_coluna, para_coluna, detalhe)
  values (c.id, 'movido', 'pessoa', auth.uid(), c.coluna, p_para, case when v_nota is null then '{}'::jsonb else jsonb_build_object('nota', left(v_nota, 500)) end);
  return jsonb_build_object('ok', true, 'versao', c.versao + 1);
end;
$function$;

