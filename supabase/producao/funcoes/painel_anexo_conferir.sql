-- public.painel_anexo_conferir(p_id bigint, p_itens jsonb)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_anexo_conferir(p_id bigint, p_itens jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare it jsonb; k text; v_id integer; n integer := 0;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  if jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) > 20 then raise exception 'Conferência inválida.' using errcode = '22023'; end if;
  if not exists (select 1 from public.conversa_anexo where id = p_id) then raise exception 'Foto não encontrada.' using errcode = '22023'; end if;
  for it in select e from jsonb_array_elements(p_itens) e loop
    v_id := nullif(it ->> 'procedimento_id', '')::int;
    continue when v_id is null or not exists (select 1 from public.catalogo_procedimento where id = v_id);
    k := public.ocr_chave(it ->> 'linha');
    continue when k is null or length(replace(k, ' ', '')) < 3;
    insert into public.ocr_aprendido as ap (texto_norm, procedimento_id, vezes, exemplo)
    values (k, v_id, 1, left(btrim(it ->> 'linha'), 120))
    on conflict (texto_norm, procedimento_id) do update set vezes = ap.vezes + 1, atualizado_em = now();
    n := n + 1;
  end loop;
  update public.conversa_anexo set gabarito = p_itens, gabarito_por = (select auth.uid()), gabarito_em = now() where id = p_id;
  return jsonb_build_object('ok', true, 'aprendidos', n);
end $function$;

