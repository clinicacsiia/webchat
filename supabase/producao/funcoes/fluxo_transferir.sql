-- public.fluxo_transferir(p_conversa uuid, p_motivo text, p_urgencia text, p_avisar boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_transferir(p_conversa uuid, p_motivo text, p_urgencia text DEFAULT 'baixa'::text, p_avisar boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_url text; v_seg text; v_on boolean := public.fluxo_equipe_online();
begin
  update public.conversas set ia_ativa = false,
    triagem_resumo = left(btrim(coalesce(p_motivo, '') || E'\n' || coalesce(public.fluxo_resumo(p_conversa), '')), 1000),
    triagem_urgencia = case when p_urgencia in ('baixa','media','alta') then p_urgencia else 'baixa' end
  where id = p_conversa;
  update public.conversa_fluxo set passo = case when passo = 'pronto' then 'pronto' else 'humano' end,
    dados = dados || jsonb_build_object('transferido_em', now()), atualizado_em = now() where conversa_id = p_conversa;
  if p_avisar then
    perform public.fluxo_dizer(p_conversa, public.fluxo_t(case when v_on then 'transferir_online' else 'transferir_offline' end, public.fluxo_ctx(p_conversa)),
                               jsonb_build_object('tipo', 'acompanhar'));
  end if;
  select valor into v_url from public.config where chave = 'equipe_push_url';
  v_seg := public.fila_aviso_segredo();
  if coalesce(v_url, '') <> '' and coalesce(v_seg, '') <> '' then
    begin
      perform net.http_post(url := v_url, body := jsonb_build_object('conversa', p_conversa, 'urgencia', p_urgencia),
                            headers := jsonb_build_object('Content-Type', 'application/json', 'x-fila-aviso-segredo', v_seg));
    exception when others then null;
    end;
  end if;
end $function$;

