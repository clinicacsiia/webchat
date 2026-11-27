-- public.pre_marcacao_vencer()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pre_marcacao_vencer()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n integer;
begin
  with v as (
    update public.pre_marcacao
       set situacao = 'vencido',
           obs = case when fila = 'novo'
                      then left(concat_ws(E'\n', nullif(obs, ''), 'Vencido automaticamente: passou o prazo sem o paciente completar o pedido.'), 2000)
                      else obs end,
           fila = case when fila = 'novo' then 'descartado' else fila end,
           atualizado_em = now()
     where tipo = 'pre_marcacao' and situacao = 'aguardando_equipe' and fila in ('novo', 'em_contato')
       and vence_em is not null and vence_em < now()
    returning 1)
  select count(*) into v_n from v;
  return v_n;
end $function$;

