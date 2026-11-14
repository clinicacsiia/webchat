-- public.klingo_promover(p_chave text, p_para text, p_justificativa text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.klingo_promover(p_chave text, p_para text, p_justificativa text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_de text := public.klingo_cfg(p_chave, ''); v_uid uuid := auth.uid();
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' or v_uid is null then raise exception 'Somente o administrador autoriza esta mudança.' using errcode = '42501'; end if;
  if not public.klingo_chave_de_modo(p_chave) then raise exception 'Chave não é um interruptor de modo.' using errcode = '22023'; end if;
  if p_para not in ('nao', 'teste', 'sombra', 'sim', 'ligado', 'legado') then raise exception 'Valor inválido.' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_justificativa, ''))) < 10 then raise exception 'Escreva a justificativa (mínimo 10 letras).' using errcode = '22023'; end if;
  perform set_config('app.promocao_autorizada', p_chave, true);
  perform set_config('app.origem', 'promocao:' || v_uid::text, true);
  perform set_config('app.justificativa', left(btrim(p_justificativa), 500), true);
  insert into public.config (chave, valor) values (p_chave, p_para) on conflict (chave) do update set valor = excluded.valor;
  insert into public.klingo_decisao (chave, de, para, motivo) values (p_chave, v_de, p_para, jsonb_build_object('autorizado_por', v_uid, 'justificativa', left(btrim(p_justificativa), 500)));
  return jsonb_build_object('ok', true, 'chave', p_chave, 'de', v_de, 'para', p_para);
end $function$;

