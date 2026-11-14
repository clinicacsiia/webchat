-- public.klingo_decidir(p_chave text, p_para text, p_motivo jsonb, p_avisar text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_decidir(p_chave text, p_para text, p_motivo jsonb, p_avisar text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_de text := public.klingo_cfg(p_chave, '');
begin
  if public.klingo_chave_de_modo(p_chave) and public.klingo_modo_nivel(p_para) > public.klingo_modo_nivel(v_de)
     and coalesce(current_setting('app.promocao_autorizada', true), '') <> p_chave then
    raise exception 'Promover % de % para % exige autorização explícita (klingo_promover).', p_chave, v_de, p_para using errcode = '42501';
  end if;
  perform set_config('app.origem', coalesce(nullif(current_setting('app.origem', true), ''), 'autogestao'), true);
  perform set_config('app.justificativa', left(coalesce(p_avisar, p_motivo::text), 500), true);
  insert into public.config (chave, valor) values (p_chave, p_para) on conflict (chave) do update set valor = excluded.valor;
  insert into public.klingo_decisao (chave, de, para, motivo) values (p_chave, v_de, p_para, coalesce(p_motivo, '{}'::jsonb));
  if p_avisar is not null then perform public.klingo_avisar_gestao(p_avisar, jsonb_build_object('chave', p_chave, 'de', v_de, 'para', p_para)); end if;
end $function$;

