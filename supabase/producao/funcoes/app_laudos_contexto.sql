-- public.app_laudos_contexto(p_token text, p_renova boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_laudos_contexto(p_token text, p_renova boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; v_trava timestamptz;
begin
  if coalesce((select valor from public.config where chave = 'app_laudos'), 'sim') <> 'sim' then
    return jsonb_build_object('ok', false, 'erro', 'desligado', 'mensagem', 'Os laudos pelo aplicativo ainda não estão disponíveis. Fale com a clínica.');
  end if;
  select * into s from public.app_aparelho_validar(p_token, p_renova);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if not p_renova then   -- abrir ou recarregar a tela não estende o PIN (igual a app_pedidos)
    select desbloqueada_ate into v_trava from public.app_aparelho where id = s.o_aparelho;
    if v_trava is null or v_trava < now() then return public.app_erro_json('bloqueado'); end if;
  end if;
  return jsonb_build_object('ok', true, 'paciente_id', s.o_pac, 'pessoas', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'chave', p.pessoa, 'nome', p.nome, 'nascimento', p.nascimento, 'cpf', p.cpf, 'eu', p.eu,
             'klingo_id', case when lp.ident_hash is not distinct from p.ih then lp.klingo_id end,
             'voucher_em', case when lp.ident_hash is not distinct from p.ih then lp.voucher_em end,
             'situacao', case when lp.ident_hash is not distinct from p.ih then lp.situacao else 'pendente' end,
             'verificado_em', case when lp.ident_hash is not distinct from p.ih then lp.verificado_em end) order by p.ord, p.criado, p.pessoa), '[]'::jsonb)
      from public.app_laudos_pessoas(s.o_pac) p
      left join public.app_laudo_pessoa lp on lp.paciente_id = s.o_pac and lp.pessoa = p.pessoa));
end $function$;

