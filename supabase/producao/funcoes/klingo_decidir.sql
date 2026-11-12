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
  insert into public.config (chave, valor) values (p_chave, p_para) on conflict (chave) do update set valor = excluded.valor;
  insert into public.klingo_decisao (chave, de, para, motivo) values (p_chave, v_de, p_para, coalesce(p_motivo, '{}'::jsonb));
  if p_avisar is not null then perform public.klingo_avisar_gestao(p_avisar, jsonb_build_object('chave', p_chave, 'de', v_de, 'para', p_para)); end if;
end $function$;

