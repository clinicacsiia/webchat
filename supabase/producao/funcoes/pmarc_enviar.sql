-- public.pmarc_enviar(p_codigo text, p_texto text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.pmarc_enviar(p_codigo text, p_texto text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p public.pmarc_pessoa; v_txt text; v_conv uuid; v_class text; v_id bigint; v_reab boolean;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  v_txt := left(btrim(coalesce(p_texto, '')), 4000);
  if v_txt = '' then return jsonb_build_object('ok', false, 'motivo', 'texto_vazio'); end if;
  select * into p from public.pmarc_pessoa where codigo = btrim(coalesce(p_codigo, '')) for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;
  v_conv := public.pmarc_conversa_garantir(p.id);
  if v_conv is null then return jsonb_build_object('ok', false, 'motivo', 'sem_celular'); end if;
  if (select count(*) from public.mensagens where conversa_id = v_conv and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    return jsonb_build_object('ok', false, 'motivo', 'muitas_mensagens');
  end if;
  v_reab := public.pmarc_conversa_reabrir(p.id, v_conv);   -- 23/11/2026: mesma regra do pedido e da resposta (um só lugar)
  insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'cliente', v_txt) returning id into v_id;
  -- "não sei", "seguimos"... também valem como resposta à previsão (e a pessoa recebe o aviso final uma única vez)
  v_class := public.pmarc_classificar(v_txt);
  update public.pmarc_pessoa set aceitou_lgpd_em = coalesce(aceitou_lgpd_em, now()), ultimo_acesso_em = now(), atualizado_em = now(),
    resposta = case when resposta is null and v_class is not null then v_class else resposta end,
    respondeu_em = case when resposta is null and v_class is not null then now() else respondeu_em end
  where id = p.id;
  if v_reab or coalesce(p.informado ->> 'final_em', '') = '' then
    insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'agente', public.pmarc_texto('previsao_marcacao_final'));
    update public.pmarc_pessoa set informado = informado || jsonb_build_object('final_em', now()) where id = p.id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;

