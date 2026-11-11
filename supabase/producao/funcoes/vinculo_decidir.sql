-- public.vinculo_decidir(p_id bigint, p_acao text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.vinculo_decidir(p_id bigint, p_acao text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; cp record; v_novo text;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe decide vínculos.' using errcode = '42501'; end if;
  select * into s from public.vinculo_solicitacoes where id = p_id and status = 'aberta' for update;
  if not found then raise exception 'Este pedido já foi resolvido ou não existe.' using errcode = '22023'; end if;
  select * into cp from public.contas_paciente where id = s.conta_id for update;

  if p_acao not in ('vincular', 'vincular_atualizar', 'recusar', 'conferido', 'atualizar', 'desfazer', 'aplicar') then raise exception 'Ação desconhecida.' using errcode = '22023'; end if;
  if not ((s.tipo = 'verificar' and p_acao in ('vincular', 'vincular_atualizar', 'recusar'))
       or (s.tipo = 'atualizar' and p_acao in ('conferido', 'atualizar', 'desfazer'))
       or (s.tipo = 'alterar' and p_acao in ('aplicar', 'recusar'))) then
    raise exception 'Ação inválida para este tipo de pedido.' using errcode = '22023';
  end if;

  if p_acao in ('vincular', 'vincular_atualizar') then
    if exists (select 1 from public.contas_paciente o where o.paciente_id = s.paciente_id and o.id <> s.conta_id) then
      raise exception 'Este cadastro já está ligado a outra conta.' using errcode = '22023';
    end if;
    update public.contas_paciente set paciente_id = s.paciente_id, vinculado_em = now(), vinculo_metodo = 'atendente' where id = s.conta_id;
    v_novo := 'vinculada';
  elsif p_acao = 'recusar' then v_novo := 'recusada';
  elsif p_acao = 'conferido' then v_novo := 'conferida';
  elsif p_acao = 'atualizar' then v_novo := 'atualizada';
  elsif p_acao = 'aplicar' then v_novo := 'aplicada';
  else
    update public.contas_paciente set paciente_id = null, vinculado_em = null, vinculo_metodo = null where id = s.conta_id and paciente_id = s.paciente_id;
    v_novo := 'desfeita';
  end if;

  if p_acao in ('vincular_atualizar', 'atualizar') then
    update public.pacientes p set
      email = case when 'email' = any(s.diferem) and nullif(btrim(coalesce(cp.email, '')), '') is not null then lower(btrim(cp.email)) else p.email end,
      telefones = case when 'telefone' = any(s.diferem) and public.fone_chave(coalesce(s.conta_telefone, cp.telefone)) is not null and not (public.fone_chave(coalesce(s.conta_telefone, cp.telefone)) = any(p.telefones))
                       then p.telefones || public.fone_chave(coalesce(s.conta_telefone, cp.telefone)) else p.telefones end,
      atualizado_em = now()
    where p.id = s.paciente_id;
  elsif p_acao = 'aplicar' then
    update public.pacientes p set
      email = coalesce(s.novo_email, p.email),
      telefones = case when s.novo_telefone is not null and public.fone_chave(s.novo_telefone) is not null and not (public.fone_chave(s.novo_telefone) = any(p.telefones))
                       then p.telefones || public.fone_chave(s.novo_telefone) else p.telefones end,
      atualizado_em = now()
    where p.id = s.paciente_id;
  end if;

  update public.vinculo_solicitacoes set status = v_novo, decidido_em = now(), decidido_por = (select auth.uid()) where id = s.id;
  return jsonb_build_object('ok', true, 'status', v_novo);
end $function$;

