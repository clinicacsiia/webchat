-- public.pmarc_novo(p_nome text, p_celular text, p_nascimento date, p_texto text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.pmarc_novo(p_nome text, p_celular text, p_nascimento date DEFAULT NULL::date, p_texto text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tel text; v_nome text; v_max integer; v_id uuid; v_codigo text; v_obs text;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  v_tel := public.pmarc_telefone(p_celular);
  if v_tel is null then return jsonb_build_object('ok', false, 'motivo', 'celular_invalido'); end if;
  v_nome := left(btrim(coalesce(p_nome, '')), 120);
  v_obs := nullif(left(btrim(coalesce(p_texto, '')), 1000), '');
  -- o mesmo celular volta para o mesmo pré-cadastro espontâneo
  select codigo into v_codigo from public.pmarc_pessoa where origem = 'espontaneo' and celular = v_tel order by criado_em limit 1;
  if v_codigo is null then
    v_max := coalesce((select case when valor ~ '^[0-9]+$' then valor::int end from public.config where chave = 'previsao_marcacao_novos_max_hora'), 60);
    if (select count(*) from public.pmarc_pessoa where origem = 'espontaneo' and criado_em > now() - interval '1 hour') >= v_max then
      return jsonb_build_object('ok', false, 'motivo', 'muitos');
    end if;
    insert into public.pmarc_pessoa (chave, nome, celular, nascimento, origem, informado, primeiro_acesso_em, ultimo_acesso_em)
    values ('p:' || replace(gen_random_uuid()::text, '-', ''), nullif(v_nome, ''), v_tel, p_nascimento, 'espontaneo',
            jsonb_strip_nulls(jsonb_build_object('observacao', v_obs, 'nome_revisar', case when char_length(v_nome) < 2 then true end)), now(), now())
    returning id, codigo into v_id, v_codigo;
  else
    select id into v_id from public.pmarc_pessoa where codigo = v_codigo;
    update public.pmarc_pessoa set ultimo_acesso_em = now(), nascimento = coalesce(nascimento, p_nascimento) where id = v_id;
  end if;
  return public.pmarc_vista(v_id);
end $function$;

