-- public.consulta_config_salvar(p_id integer, p_oculta boolean, p_rotulo text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.consulta_config_salvar(p_id integer, p_oculta boolean, p_rotulo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_rot text := nullif(btrim(coalesce(p_rotulo, '')), '');
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  if not exists (select 1 from public.catalogo_procedimento where id = p_id and classe = 'CONSULTAS') then raise exception 'Consulta não encontrada.' using errcode = '22023'; end if;
  if v_rot is not null and length(v_rot) > 80 then raise exception 'O nome da consulta pode ter até 80 letras.' using errcode = '22023'; end if;
  if not coalesce(p_oculta, false) and v_rot is null then
    delete from public.consulta_config where procedimento_id = p_id;
  else
    insert into public.consulta_config (procedimento_id, oculta, rotulo, atualizado_por) values (p_id, coalesce(p_oculta, false), v_rot, (select auth.uid()))
    on conflict (procedimento_id) do update set oculta = excluded.oculta, rotulo = excluded.rotulo, atualizado_em = now(), atualizado_por = excluded.atualizado_por;
  end if;
  return jsonb_build_object('ok', true);
end $function$;

