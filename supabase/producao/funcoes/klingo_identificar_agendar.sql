-- public.klingo_identificar_agendar(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_identificar_agendar(p_conversa uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; v_cpf text; v_dt date; v_base text; v_seg text; v_i public.klingo_identidade; v_chave text; v_novo uuid;
begin
  select dados -> 'digitado' into d from public.conversa_fluxo where conversa_id = p_conversa;
  v_cpf := regexp_replace(coalesce(d ->> 'cpf', ''), '\D', '', 'g');
  if not public.fluxo_cpf_ok(v_cpf) then return; end if;
  v_dt := public.fluxo_ler_data(d ->> 'dt_nasc');
  if v_dt is null or v_dt > current_date or v_dt < date '1900-01-01' then return; end if;
  v_chave := public.klingo_hash(v_cpf || '|' || v_dt::text);
  insert into public.klingo_conversa_ident (conversa_id, chave) values (p_conversa, v_chave)
    on conflict (conversa_id) do update set chave = excluded.chave, em = now() where public.klingo_conversa_ident.chave is distinct from excluded.chave
    returning conversa_id into v_novo;
  if v_novo is null then return; end if;
  select * into v_i from public.klingo_identidade where chave = v_chave;
  if v_i.id is not null and v_i.conferido_em > now() - interval '1 day' and v_i.situacao <> 'erro' then
    perform public.klingo_identidade_registrar(v_cpf, v_dt, jsonb_build_object('situacao', v_i.situacao, 'klingo_id', v_i.klingo_id, 'faltando', to_jsonb(v_i.faltando), 'plano_id', v_i.plano_id), p_conversa);
    return;
  end if;
  v_base := public.klingo_cfg('klingo_funcoes_base', ''); v_seg := public.klingo_segredo();
  if v_base = '' or v_seg is null then return; end if;
  perform net.http_post(url := v_base || 'klingo-identificar', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('acao', 'conferir', 'cpf', v_cpf, 'nascimento', v_dt::text, 'conversa', p_conversa), timeout_milliseconds := 30000);
exception when others then null;
end $function$;

