-- public.medicos_painel()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.medicos_painel()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  perform public.medico_detectar();
  return jsonb_build_object(
    'medicos', coalesce((select jsonb_agg(to_jsonb(q) order by q.sala, q.profissional, q.unidade) from (
      select k.profissional, k.unidade, k.especialidade, k.consulta, k.sala, k.dias, k.hora_ini, k.hora_fim,
             (select to_jsonb(r) - 'atualizado_por' from public.medico_regra r where public.norm_nome(r.profissional) = public.norm_nome(k.profissional) and public.norm_nome(r.unidade) = public.norm_nome(k.unidade)) as regra,
             public.profissional_bloqueado(k.profissional) as bloqueado,
             exists (select 1 from public.medico_turno t where public.norm_nome(t.profissional) = public.norm_nome(k.profissional) and public.norm_nome(t.unidade) = public.norm_nome(k.unidade)) as tem_turnos,
             exists (select 1 from public.medico_particular mp where mp.profissional = public.norm_nome(k.profissional)) as particular,
             (select count(*)::int from public.medico_convenio_bloqueio b where b.profissional = public.norm_nome(k.profissional)) as n_convenios_fora,
             (select count(*)::int from public.medico_excecao e where e.profissional = public.norm_nome(k.profissional) and e.data_fim >= current_date) as n_excecoes,
             (select a.id from public.medico_aviso a where a.status = 'pendente' and a.profissional = k.profissional and a.unidade = k.unidade) as aviso_id
      from public.medico_klingo() k) q), '[]'::jsonb),
    'avisos', coalesce((select jsonb_agg(to_jsonb(a) - 'resolvido_por' order by a.criado_em desc, a.id desc) from (
      select a.id, a.criado_em, a.profissional, a.unidade, a.tipo, a.antes, a.depois, a.status, a.resolvido_em,
             exists (select 1 from public.medico_regra r where public.norm_nome(r.profissional) = public.norm_nome(a.profissional) and public.norm_nome(r.unidade) = public.norm_nome(a.unidade)) as tem_regra
      from public.medico_aviso a where a.status = 'pendente') a), '[]'::jsonb),
    'proc_avisos', coalesce((select jsonb_agg(to_jsonb(x) order by x.profissional, x.procedimento) from (
      select a.id, a.criado_em, a.profissional, a.procedimento_id, a.procedimento, a.especialidade
      from public.medico_proc_aviso a where a.status = 'pendente' order by a.profissional, a.procedimento limit 600) x), '[]'::jsonb));
end $function$;

