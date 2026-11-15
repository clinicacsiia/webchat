-- public.app_pedidos(p_token text, p_renova boolean)
-- Pode executar: anon, authenticated
CREATE OR REPLACE FUNCTION public.app_pedidos(p_token text, p_renova boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; a public.app_paciente%rowtype; v_dados jsonb; v_trava timestamptz;
begin
  select * into s from public.app_aparelho_validar(p_token, p_renova);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if not p_renova then
    select desbloqueada_ate into v_trava from public.app_aparelho where id = s.o_aparelho;
    if v_trava is null or v_trava < now() then return public.app_erro_json('bloqueado'); end if;
  end if;
  select * into a from public.app_paciente where id = s.o_pac;
  v_dados := public.app_pedido_dados(a.id);
  return jsonb_build_object('ok', true,
    'nome', a.nome, 'telefone_final', right(a.telefone, 4), 'email_salvo', a.email is not null,
    'pessoas', jsonb_build_array(jsonb_build_object('nome', a.nome, 'eu', true)) || coalesce((select jsonb_agg(jsonb_build_object('nome', f.nome, 'eu', false) order by f.criado_em, f.id)
                from public.app_filho f where f.responsavel_id = a.id and f.removido_em is null), '[]'::jsonb),
    'pedidos', v_dados,
    'novidades', (select count(*) from jsonb_array_elements(v_dados) e where (e ->> 'novo')::boolean),
    'resultados', public.app_resultados_json(a.id));
end $function$;

