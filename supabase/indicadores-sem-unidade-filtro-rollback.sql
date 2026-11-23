-- Rollback de supabase/indicadores-sem-unidade-filtro.sql: volta a aceitar só csi, rmtc e desenvoar.
-- (Com isso o quadro "Sem unidade definida" volta a mostrar o total de todos.)

create or replace function public.painel_indicadores_pessoas(p_de date default null::date, p_ate date default null::date, p_unidade text default null::text, p_incluir_teste boolean default false, p_tipo text default null::text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_len integer;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
  v_tipo text := case when lower(coalesce(p_tipo, '')) in ('exame', 'consulta') then lower(p_tipo) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje);
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;
  v_len := v_ate - v_de + 1;
  return jsonb_build_object('periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'anterior_periodo', jsonb_build_object('de', v_de - v_len, 'ate', v_de - 1),
    'unidade', v_un, 'tipo', v_tipo, 'gerado_em', now(),
    'atual', public.ind_pessoas_periodo(v_de, v_ate, v_un, coalesce(p_incluir_teste, false), v_tipo),
    'anterior', public.ind_pessoas_periodo(v_de - v_len, v_de - 1, v_un, coalesce(p_incluir_teste, false), v_tipo));
end $function$;
