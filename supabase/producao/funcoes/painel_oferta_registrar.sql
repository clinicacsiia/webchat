-- public.painel_oferta_registrar(p_conversa uuid, p_tipo text, p_estado text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_oferta_registrar(p_conversa uuid, p_tipo text, p_estado text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ult text; v_grupo uuid;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  if p_tipo is null or p_estado is null or p_tipo not in ('horario', 'disponibilidade') or p_estado not in ('oferecido', 'aceito', 'recusado', 'dispensado') then raise exception 'Oferta inválida.' using errcode = '22023'; end if;
  if not exists (select 1 from public.conversas where id = p_conversa) then raise exception 'Conversa não encontrada.' using errcode = 'P0002'; end if;
  select grupo_id into v_grupo from public.conversa_grupo where conversa_id = p_conversa;
  perform pg_advisory_xact_lock(hashtextextended(coalesce(v_grupo, p_conversa)::text || p_tipo, 0));
  select o.estado into v_ult from public.painel_oferta o
   where o.tipo = p_tipo and (o.conversa_id = p_conversa or o.conversa_id in (
     select g.conversa_id from public.conversa_grupo g where g.grupo_id = v_grupo
   ))
   order by o.criado_em desc, o.id desc limit 1;
  if p_estado = 'oferecido' and v_ult in ('recusado', 'dispensado') then return jsonb_build_object('ok', false, 'bloqueado', true, 'motivo', 'ja_' || v_ult); end if;
  if v_ult is not distinct from p_estado then return jsonb_build_object('ok', true, 'estado', p_estado, 'repetido', true); end if;
  insert into public.painel_oferta (conversa_id, tipo, estado, criado_em) values (p_conversa, p_tipo, p_estado, clock_timestamp());
  return jsonb_build_object('ok', true, 'estado', p_estado);
end $function$;

