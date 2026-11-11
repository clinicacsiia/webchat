-- public.pessoa_klingo_confirmar_sup(p_prontuario text, p_conversa uuid, p_substituir boolean)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.pessoa_klingo_confirmar_sup(p_prontuario text, p_conversa uuid, p_substituir boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_quem text := coalesce((select valor from public.config where chave = 'vinculo_manual_quem'), 'equipe'); v_nivel text := public.org_nivel(); v_outro text; v_pessoa uuid[]; v_dono uuid;
begin
  perform public.pessoa_equipe();
  if v_quem = 'supervisao' and coalesce(v_nivel, '') not in ('ti', 'gerente', 'supervisor') then
    raise exception 'Este vínculo precisa da supervisão: peça para a supervisão confirmar.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.jornada_paciente where prontuario = p_prontuario) then raise exception 'Paciente não encontrado na Jornada.' using errcode = '22023'; end if;
  if not exists (select 1 from public.conversas where id = p_conversa) then raise exception 'Conversa não encontrada.' using errcode = '22023'; end if;
  v_pessoa := public.pessoa_membros(p_conversa);
  select pv.prontuario into v_outro from public.pessoa_klingo_vinculo pv where pv.conversa_id = any (v_pessoa) and pv.prontuario <> p_prontuario and pv.prontuario not like 'n:%' limit 1;
  select pv.conversa_id into v_dono from public.pessoa_klingo_vinculo pv where pv.prontuario = p_prontuario and not (pv.conversa_id = any (v_pessoa));
  if (v_outro is not null or v_dono is not null) then
    if not coalesce(p_substituir, false) then
      return jsonb_build_object('ok', false, 'conflito', case when v_outro is not null then 'pessoa_ja_tem_outro_prontuario' else 'prontuario_ja_ligado_a_outra_pessoa' end,
                                'atual', v_outro, 'mensagem', 'Já existe um vínculo diferente. A supervisão decide se troca.');
    end if;
    if coalesce(v_nivel, '') not in ('ti', 'gerente', 'supervisor') then raise exception 'Só a supervisão troca um vínculo que já existe.' using errcode = '42501'; end if;
    if v_outro is not null then delete from public.pessoa_klingo_vinculo pv where pv.conversa_id = any (v_pessoa) and pv.prontuario = v_outro; end if;
  end if;
  insert into public.pessoa_klingo_vinculo (prontuario, conversa_id, por) values (p_prontuario, p_conversa, (select auth.uid()))
  on conflict (prontuario) do update set conversa_id = excluded.conversa_id, por = excluded.por, em = now();
  return jsonb_build_object('ok', true);
end $function$;

