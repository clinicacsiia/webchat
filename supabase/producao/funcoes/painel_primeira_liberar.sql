-- public.painel_primeira_liberar(p_conversa uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_primeira_liberar(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; v_chave text;
begin
  if (select public.papel_atual()) not in ('admin', 'atendente') then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  perform public.fluxo_set(p_conversa, '{"primeira_liberada": true}'::jsonb);
  d := public.klingo_dados_conversa(p_conversa);
  if d ->> 'cpf' is not null and d ->> 'nascimento' is not null then
    v_chave := public.klingo_hash((d ->> 'cpf') || '|' || (d ->> 'nascimento'));
    insert into public.primeira_consulta_liberada (chave, liberado_por) values (v_chave, (select auth.uid())) on conflict (chave) do nothing;
  end if;
  perform public.fluxo_nota(p_conversa, 'Atendente liberou o autoatendimento: paciente já atendido pela médica.');
  return jsonb_build_object('ok', true, 'permanente', v_chave is not null);
end $function$;

