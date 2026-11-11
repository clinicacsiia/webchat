-- public.despedida_publicar(p_conversa uuid, p_encerrada_em timestamp with time zone)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.despedida_publicar(p_conversa uuid, p_encerrada_em timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_padrao constant text := 'Atendimento encerrado. Se precisar, é só mandar uma nova mensagem.';
  v_ver bigint; v_id bigint; v_txt text; v_img boolean := false; v_texto text := v_padrao; v_opc jsonb;
begin
  if coalesce((select valor from public.config where chave = 'despedida_configurada'), 'nao') = 'sim' then
    select case when valor ~ '^[0-9]+$' then valor::bigint end into v_ver from public.config where chave = 'despedida_versao_atual';
    select d.id, d.texto, (d.dados is not null) into v_id, v_txt, v_img from public.despedida_versao d where d.id = v_ver;
    if v_id is not null then v_texto := coalesce(nullif(btrim(v_txt), ''), v_padrao); else v_img := false; end if;
  end if;
  v_opc := jsonb_build_object('tipo', 'despedida', 'versao', v_id, 'imagem', coalesce(v_img, false), 'encerrada_em', p_encerrada_em::text);
  insert into public.mensagens (conversa_id, autor, texto, opcoes) values (p_conversa, 'sistema', v_texto, v_opc) on conflict do nothing;
end $function$;

