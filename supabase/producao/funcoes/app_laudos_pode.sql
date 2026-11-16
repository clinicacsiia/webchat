-- public.app_laudos_pode(p_token text, p_marcacao text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_laudos_pode(p_token text, p_marcacao text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record;
begin
  if coalesce((select valor from public.config where chave = 'app_laudos'), 'sim') <> 'sim' then
    return jsonb_build_object('ok', false, 'erro', 'desligado', 'mensagem', 'Os laudos pelo aplicativo ainda não estão disponíveis. Fale com a clínica.');
  end if;
  select * into s from public.app_aparelho_validar(p_token);   -- exige o PIN e renova os 30 minutos: baixar é uso de verdade
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if (select count(*) from public.app_evento e where e.paciente_id = s.o_pac and e.tipo = 'laudo_baixado' and e.criado_em > now() - interval '1 hour') >= 60 then
    return jsonb_build_object('ok', false, 'erro', 'muitos', 'mensagem', 'Muitos downloads seguidos. Tente de novo daqui a pouco.');
  end if;
  if not exists (select 1 from public.app_laudo l
                   join public.app_laudos_pessoas(s.o_pac) p on p.pessoa = l.pessoa and p.ih = l.ident_hash
                   join public.app_laudo_pessoa lp on lp.paciente_id = l.paciente_id and lp.pessoa = l.pessoa and lp.ident_hash = l.ident_hash and lp.situacao = 'confere'
                  where l.paciente_id = s.o_pac and l.marcacao_id = p_marcacao) then
    return jsonb_build_object('ok', false, 'erro', 'sem_acesso', 'mensagem', 'Laudo não encontrado.');
  end if;
  return jsonb_build_object('ok', true, 'paciente_id', s.o_pac);
end $function$;

