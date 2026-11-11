-- public.chat_responder(p_conversa uuid, p_token text, p_passo text, p_valor jsonb, p_texto text, p_ms integer)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_responder(p_conversa uuid, p_token text, p_passo text, p_valor jsonb, p_texto text DEFAULT NULL::text, p_ms integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id bigint; c public.conversas; v_passo text; v_txt text; o jsonb; k text; x text; v_partes text[] := '{}';
  rotulos jsonb := '{"nome":"Nome","sexo":"Sexo","dt_nasc":"Nascimento","mae":"Mãe","cpf":"CPF","rg":"RG","celular":"Celular","telefone":"Telefone","cep":"CEP","endereco":"Rua","numero":"Nº","complemento":"Compl.","bairro":"Bairro","cidade":"Cidade","uf":"UF","matricula":"Carteirinha","validade":"Validade"}';
begin
  perform public.chat_valida(p_conversa, p_token);
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  select * into c from public.conversas where id = p_conversa;
  select passo into v_passo from public.conversa_fluxo where conversa_id = p_conversa;
  if p_valor ->> 'acao' = 'atendente' then
    v_txt := 'Quero falar com um atendente.';
  else
    if c.motor <> 'fluxo' or not (c.ia_ativa and c.status = 'aguardando') or p_passo is distinct from v_passo then
      raise exception 'Essa pergunta já foi respondida. Veja a última mensagem.' using errcode = '22023';
    end if;
    o := case when jsonb_typeof(p_valor) = 'object' then p_valor else null end;
    if o is not null and p_passo in ('identidade', 'dados_ident', 'dados_contato', 'dados_endereco', 'dados_carteira') then
      if coalesce((o ->> 'pular')::boolean, false) then v_txt := 'Prefiro deixar para depois.';
      else
        for k, x in select e.key, e.value from jsonb_each_text(o) e
                    order by array_position(array['nome','sexo','dt_nasc','mae','cpf','rg','celular','telefone','cep','endereco','numero','complemento','bairro','cidade','uf','matricula','validade'], e.key) loop
          if nullif(btrim(x), '') is null or k = 'pular' then continue; end if;
          if k = 'cpf' then x := '***.***.' || right(regexp_replace(x, '\D', '', 'g'), 5); end if;
          if k = 'sexo' then x := case upper(left(x, 1)) when 'F' then 'Feminino' when 'M' then 'Masculino' else x end; end if;
          v_partes := v_partes || (coalesce(rotulos ->> k, k) || ': ' || left(btrim(x), 120));
        end loop;
        v_txt := coalesce(nullif(array_to_string(v_partes, E'\n'), ''), 'Enviado.');
      end if;
    else
      v_txt := coalesce(nullif(left(btrim(coalesce(p_texto, '')), 1000), ''),
                        left(coalesce(case when jsonb_typeof(p_valor) = 'string' then p_valor #>> '{}' end, p_valor ->> 'outro', 'Enviado.'), 1000));
    end if;
  end if;
  perform set_config('fluxo.entrada', jsonb_build_object('passo', p_passo, 'valor', case when p_valor ->> 'acao' = 'atendente' then null else p_valor end,
                                                         'acao', p_valor ->> 'acao', 'ms', p_ms)::text, true);
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_id;
  perform set_config('fluxo.entrada', '', true);
  return jsonb_build_object('id', v_id, 'respostas', public.chat_respostas(p_conversa, v_id - 1));
end $function$;

