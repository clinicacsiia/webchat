-- public.pmarc_mensagens(p_codigo text, p_apos bigint)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.pmarc_mensagens(p_codigo text, p_apos bigint DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p public.pmarc_pessoa;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  select * into p from public.pmarc_pessoa where codigo = btrim(coalesce(p_codigo, ''));
  if not found then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;
  if p.conversa_id is null then return jsonb_build_object('ok', true, 'mensagens', '[]'::jsonb); end if;
  return jsonb_build_object('ok', true, 'mensagens', coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'autor', m.autor, 'texto', m.texto, 'criado_em', m.criado_em,
             'agente', coalesce(ag.nome, case when m.autor = 'agente' then 'Assistente virtual' end)) order by m.id)
    from public.mensagens m left join public.agentes ag on ag.id = m.agente_id
    where m.conversa_id = p.conversa_id and m.id > coalesce(p_apos, 0) and m.excluida_em is null
      and m.id >= coalesce(nullif(p.informado ->> 'msg_desde', '')::bigint, 0)), '[]'::jsonb));
end $function$;

