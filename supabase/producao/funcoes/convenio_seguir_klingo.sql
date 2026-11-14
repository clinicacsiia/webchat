-- public.convenio_seguir_klingo()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.convenio_seguir_klingo()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; v_off int := 0; v_on int := 0;
begin
  if public.klingo_cfg('convenio_seguir_klingo', 'sim') <> 'sim' then return jsonb_build_object('ligada', false); end if;
  -- o Klingo não lista / não atende: inativo no chat
  for r in select public.convenio_chave(m.operadora) as chave, m.operadora from public.klingo_plano_map m where m.origem = 'nao_atende' and nullif(btrim(m.operadora), '') is not null loop
    if not exists (select 1 from public.convenio_config c where c.operadora = r.chave) then
      insert into public.convenio_config (operadora, ativo, motivo, atualizado_em) values (r.chave, false, 'Klingo: não consta como convênio atendido', now());
      v_off := v_off + 1;
      perform public.klingo_avisar_gestao('O convênio ' || initcap(lower(r.operadora)) || ' foi marcado como NÃO atendido no chat porque o Klingo não o lista como ativo.', jsonb_build_object('convenio', r.chave, 'para', 'inativo'));
    elsif exists (select 1 from public.convenio_config c where c.operadora = r.chave and c.ativo) then
      update public.convenio_config set ativo = false, motivo = coalesce(nullif(motivo, ''), 'Klingo: não consta como convênio atendido'), atualizado_em = now() where operadora = r.chave;
      v_off := v_off + 1;
      perform public.klingo_avisar_gestao('O convênio ' || initcap(lower(r.operadora)) || ' foi marcado como NÃO atendido no chat porque o Klingo não o lista como ativo.', jsonb_build_object('convenio', r.chave, 'para', 'inativo'));
    end if;
  end loop;
  -- o Klingo lista e atende: ativo no chat (a suspensão temporária da equipe, em suspenso_em, não é mexida)
  for r in select c.operadora as chave, m.operadora from public.convenio_config c join public.klingo_plano_map m on public.convenio_chave(m.operadora) = c.operadora
            where not c.ativo and m.plano_id is not null and m.origem <> 'nao_atende' loop
    update public.convenio_config set ativo = true, atualizado_em = now() where operadora = r.chave;
    v_on := v_on + 1;
    perform public.klingo_avisar_gestao('O convênio ' || initcap(lower(r.operadora)) || ' voltou a ser aceito no chat porque o Klingo o lista como ativo.', jsonb_build_object('convenio', r.chave, 'para', 'ativo'));
  end loop;
  return jsonb_build_object('ligada', true, 'desativados', v_off, 'ativados', v_on);
end $function$;

