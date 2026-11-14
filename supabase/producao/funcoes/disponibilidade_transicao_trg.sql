-- public.disponibilidade_transicao_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_transicao_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  new.atualizado_em := now();
  if new.estado is distinct from old.estado and not exists (
      select 1 from (values ('ativa', 'oportunidade_identificada'), ('ativa', 'expirada'), ('ativa', 'cancelada'), ('ativa', 'convertida_em_agendamento'),
                            ('oportunidade_identificada', 'notificada'), ('oportunidade_identificada', 'ativa'), ('oportunidade_identificada', 'expirada'), ('oportunidade_identificada', 'cancelada'), ('oportunidade_identificada', 'convertida_em_agendamento'),
                            ('notificada', 'aguardando_resposta'), ('notificada', 'ativa'), ('notificada', 'expirada'), ('notificada', 'cancelada'), ('notificada', 'convertida_em_agendamento'),
                            ('aguardando_resposta', 'convertida_em_agendamento'), ('aguardando_resposta', 'ativa'), ('aguardando_resposta', 'expirada'), ('aguardando_resposta', 'cancelada')) t(de, para)
       where t.de = old.estado and t.para = new.estado) then
    raise exception 'Transição inválida da solicitação de disponibilidade: % -> %', old.estado, new.estado using errcode = '23514';
  end if;
  return new;
end $function$;

