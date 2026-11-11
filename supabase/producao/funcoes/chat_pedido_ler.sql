-- public.chat_pedido_ler(p_conversa uuid, p_token text, p_anexo bigint, p_texto text, p_linhas jsonb, p_largura integer, p_altura integer)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_pedido_ler(p_conversa uuid, p_token text, p_anexo bigint, p_texto text, p_linhas jsonb, p_largura integer DEFAULT NULL::integer, p_altura integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_linhas jsonb; l jsonb; t text; k text; v_lado text; v_apr integer; v_ops jsonb; v_grupos jsonb := '[]'::jsonb;
        v_vistos integer[] := '{}'; v_id integer; n integer := 0; v_crianca boolean;
begin
  perform public.chat_valida(p_conversa, p_token);
  if not exists (select 1 from public.conversa_anexo where id = p_anexo and conversa_id = p_conversa) then
    raise exception 'Foto não encontrada.' using errcode = '22023';
  end if;
  v_linhas := case when jsonb_typeof(p_linhas) = 'array' and jsonb_array_length(p_linhas) > 0 then p_linhas
                   else coalesce((select jsonb_agg(jsonb_build_object('t', x)) from regexp_split_to_table(left(coalesce(p_texto, ''), 4000), '[\n;]+') x
                                  where length(btrim(x)) >= 4), '[]'::jsonb) end;
  update public.conversa_anexo set ocr_texto = left(coalesce(p_texto, ocr_texto), 4000), ocr_motor = 'tesseract.js 7',
    ocr_linhas = (select jsonb_agg(e) from (select e from jsonb_array_elements(v_linhas) e limit 40) q),
    largura = coalesce(p_largura, largura), altura = coalesce(p_altura, altura)
  where id = p_anexo;
  select paciente_tipo = 'filho' into v_crianca from public.conversas where id = p_conversa;

  for l in select e from jsonb_array_elements(v_linhas) e limit 40 loop
    exit when n >= 12;
    t := regexp_replace(left(btrim(coalesce(l ->> 't', '')), 160), '^[|•*·.\-\s]*(\d{1,2}\s*[).\-]\s*)?', '');
    k := public.ocr_chave(t);
    continue when k is null or length(replace(k, ' ', '')) < 3;
    v_lado := public.ocr_lado(t);
    select a.procedimento_id into v_apr from public.ocr_aprendido a join public.fluxo_exames x on x.id = a.procedimento_id
     where a.texto_norm = k order by a.vezes desc, a.atualizado_em desc limit 1;
    if v_apr is not null then
      continue when v_apr = any (v_vistos);
      v_ops := jsonb_build_array(jsonb_build_object('exame', public.ocr_exame_json(v_apr, v_lado, t)));
    else
      continue when length(replace(k, ' ', '')) < 4;
      select coalesce(jsonb_agg(jsonb_build_object('exame', c.v - 'sugerido') order by c.fora, c.ord), '[]'::jsonb) into v_ops
      from (select v, ord, public.norm_nome(v ->> 'nome') ~ case when v_crianca then 'FETAL|OBSTETR|GESTA' else 'PEDIATR|INFANTIL|NEONAT|FETAL' end
                           and k !~ case when v_crianca then 'FETAL|OBSTETR|GESTA' else 'PEDIATR|INFANTIL|NEONAT|FETAL' end as fora
            from jsonb_array_elements(public.chat_exames_buscar(p_conversa, p_token, t, true)) with ordinality q(v, ord)) c;
      continue when jsonb_array_length(v_ops) > 0 and (v_ops -> 0 -> 'exame' ->> 'id')::int = any (v_vistos);
      select coalesce(jsonb_agg(o), '[]'::jsonb) into v_ops from jsonb_array_elements(v_ops) o where (o -> 'exame' ->> 'id')::int <> all (v_vistos);
    end if;
    if jsonb_array_length(v_ops) = 0 then
      continue when k !~ '\m(RM|TC|US|RX|DOPPLER|MAMOGRAF|DENSITOMETR|ECOCARDIO|ELETRO|ANGIO|CINTILOGRAF|ENDOSCOP|COLONOSCOP|HOLTER|MAPA|ERGOMETR|ESPIROMETR|AUDIOMETR|BIOPSIA|PUNCAO|ELASTOGRAF)';
      v_grupos := v_grupos || jsonb_build_object('linha', t, 'caixa', l -> 'b', 'origem', 'leitura', 'certeza', 'nenhum', 'lado', v_lado, 'opcoes', '[]'::jsonb);
    else
      v_id := (v_ops -> 0 -> 'exame' ->> 'id')::int;
      v_vistos := v_vistos || v_id;
      v_grupos := v_grupos || jsonb_build_object('linha', t, 'caixa', l -> 'b', 'origem', case when v_apr is not null then 'aprendido' else 'leitura' end,
        'certeza', case when v_apr is not null or jsonb_array_length(v_ops) = 1 then 'alta' else 'media' end, 'lado', v_lado, 'opcoes', v_ops);
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('anexo', p_anexo, 'grupos', v_grupos, 'total', jsonb_array_length(v_grupos));
end $function$;

