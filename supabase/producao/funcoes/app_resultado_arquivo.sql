-- public.app_resultado_arquivo(p_token text, p_id uuid)
-- Pode executar: anon, authenticated
CREATE OR REPLACE FUNCTION public.app_resultado_arquivo(p_token text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; x record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select x2.mime, x2.dados, x2.nome into x from public.app_resultado r join public.conversa_anexo x2 on x2.id = r.anexo_id
   where r.id = p_id and r.paciente_id = s.o_pac and r.estado = 'entregue';
  if not found then return jsonb_build_object('ok', false, 'erro', 'arquivo', 'mensagem', 'Não há arquivo guardado para este resultado. Abra a conversa para ver o que a equipe enviou.'); end if;
  return jsonb_build_object('ok', true, 'mime', x.mime, 'nome', x.nome, 'base64', encode(x.dados, 'base64'));
end $function$;

