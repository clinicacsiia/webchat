-- public.painel_oferta_registrar(p_conversa uuid, p_tipo text, p_estado text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_oferta_registrar(p_conversa uuid, p_tipo text, p_estado text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ult text;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  if p_tipo not in ('horario', 'disponibilidade') or p_estado not in ('oferecido', 'aceito', 'recusado', 'dispensado') then raise exception 'Oferta inválida.' using errcode = '22023'; end if;
  if not exists (select 1 from public.conversas where id = p_conversa) then raise exception 'Conversa não encontrada.' using errcode = 'P0002'; end if;
  select estado into v_ult from public.painel_oferta where conversa_id = p_conversa and tipo = p_tipo order by criado_em desc, id desc limit 1;
  if p_estado = 'oferecido' and v_ult in ('recusado', 'dispensado') then return jsonb_build_object('ok', false, 'bloqueado', true, 'motivo', 'ja_' || v_ult); end if;
  if v_ult is not distinct from p_estado then return jsonb_build_object('ok', true, 'estado', p_estado, 'repetido', true); end if;
  insert into public.painel_oferta (conversa_id, tipo, estado) values (p_conversa, p_tipo, p_estado);
  return jsonb_build_object('ok', true, 'estado', p_estado);
end $function$;

