-- public.chat_corpo_calcular()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.chat_corpo_calcular()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb;
begin
  with mods(codigo, nome, mapa, ordem) as (values
    ('RM', 'Ressonância magnética', true, 1), ('TC', 'Tomografia', true, 2), ('US', 'Ultrassom', true, 3),
    ('RX', 'Raio-X', true, 4), ('MAMO', 'Mamografia', false, 5), ('DENSITO', 'Densitometria óssea', false, 6)),
  regs as (select codigo from public.catalogo_regiao union all select 'outros')
  select jsonb_build_object(
    'modalidades', (select jsonb_agg(jsonb_build_object('codigo', m.codigo, 'nome', m.nome, 'mapa', m.mapa,
        'regioes', coalesce((select jsonb_agg(g.codigo) from (select rg.codigo from regs rg
                              where exists (select 1 from public.catalogo_exames_regiao(m.codigo, rg.codigo))) g), '[]'::jsonb),
        'total', (select count(*) from public.catalogo_exames_regiao(m.codigo, 'todos'))) order by m.ordem) from mods m),
    'regioes', (select jsonb_agg(jsonb_build_object('codigo', codigo, 'nome', nome, 'tem_lado', tem_lado, 'grupo', grupo) order by ordem) from public.catalogo_regiao))
  into r;
  return r;
end $function$;

