-- public.paciente_klingo_ligar(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.paciente_klingo_ligar(p_conversa uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_sal text; v_fh text; v_nome text; v_dig text; v_pros text[]; v_ids uuid[]; v_lin integer := 0;
begin
  select regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), public.pessoa_ficha(c.id) ->> 'nome' into v_dig, v_nome
    from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
  if v_nome is null or length(coalesce(v_dig, '')) < 8 then return 0; end if;
  select valor into v_sal from public.config where chave = 'ia_segredo';
  v_fh := encode(sha256(convert_to(right(v_dig, 8) || coalesce(v_sal, ''), 'UTF8')), 'hex');
  v_pros := array(select jp.prontuario from public.jornada_paciente jp where jp.fone_chave = v_fh and public.nome_confere(jp.nome, v_nome));
  if cardinality(v_pros) = 0 then return 0; end if;
  v_ids := public.pessoa_membros(p_conversa);
  if exists (select 1 from public.pessoa_klingo_vinculo vk where vk.prontuario = any (v_pros) and vk.conversa_id = any (v_ids)) then return 0; end if;
  if cardinality(v_pros) > 1 then
    insert into public.paciente_aviso (conversa_id, tipo, detalhe) values (p_conversa, 'klingo_varios', jsonb_build_object('prontuarios', to_jsonb(v_pros)))
      on conflict (conversa_id, tipo) where resolvido_em is null do nothing;
    return 0;
  end if;
  insert into public.pessoa_klingo_vinculo (prontuario, conversa_id, por) values (v_pros[1], p_conversa, null) on conflict (prontuario) do nothing;
  get diagnostics v_lin = row_count;
  if v_lin > 0 then
    insert into public.paciente_aviso (conversa_id, tipo, detalhe) values (p_conversa, 'klingo_ligado', jsonb_build_object('prontuario', v_pros[1]))
      on conflict (conversa_id, tipo) where resolvido_em is null do nothing;
  end if;
  return v_lin;
end $function$;

