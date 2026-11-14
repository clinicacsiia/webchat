-- public.klingo_recomendar(p_chave text, p_para text, p_motivo jsonb, p_aviso text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_recomendar(p_chave text, p_para text, p_motivo jsonb, p_aviso text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_de text := public.klingo_cfg(p_chave, '');
begin
  if public.klingo_modo_nivel(p_para) <= public.klingo_modo_nivel(v_de) then return false; end if;
  if exists (select 1 from public.klingo_decisao where chave = 'recomendacao:' || p_chave and em > now() - interval '7 days') then return false; end if;
  insert into public.klingo_decisao (chave, de, para, motivo) values ('recomendacao:' || p_chave, v_de, p_para, coalesce(p_motivo, '{}'::jsonb));
  perform public.klingo_avisar_gestao(p_aviso, jsonb_build_object('chave', p_chave, 'de', v_de, 'recomendado', p_para, 'recomendacao', true));
  return true;
end $function$;

