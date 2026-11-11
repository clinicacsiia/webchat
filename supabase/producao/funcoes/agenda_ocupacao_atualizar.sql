-- public.agenda_ocupacao_atualizar(p_linhas jsonb, p_execucao timestamp with time zone, p_finalizar boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_ocupacao_atualizar(p_linhas jsonb, p_execucao timestamp with time zone DEFAULT NULL::timestamp with time zone, p_finalizar boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n integer := 0; v_tot integer;
begin
  if p_linhas is not null and jsonb_typeof(p_linhas) = 'array' and jsonb_array_length(p_linhas) > 0 then
    with x as (
      select distinct on (inicio, profissional, unidade, fonte)
        inicio, public.norm_nome(profissional) as prof, public.norm_nome(unidade) as unid,
        coalesce(nullif(fonte, ''), 'marcada') as fonte, greatest(coalesce(qtd, 1), 1) as qtd,
        left(procedimento, 160) as procedimento, public.norm_nome(procedimento) as proc_n
      from jsonb_to_recordset(p_linhas) as t(inicio timestamp, profissional text, unidade text, fonte text, qtd integer, procedimento text)
      where inicio is not null and profissional is not null and unidade is not null
      order by inicio, profissional, unidade, fonte
    ), pr as materialized (
      select distinct on (public.norm_nome(p.nome)) public.norm_nome(p.nome) as n, rg.minutos
      from public.catalogo_procedimento p join public.agenda_regra_duracao rg on rg.modalidade = p.modalidade
      where p.ativo
      order by public.norm_nome(p.nome)
    ), ag as materialized (
      select distinct on (public.norm_nome(a.profissional), public.norm_nome(a.unidade), a.dia_num, a.hora_ini::time, a.hora_fim::time)
             public.norm_nome(a.profissional) as prof, public.norm_nome(a.unidade) as unid, a.dia_num,
             a.hora_ini::time as hi, a.hora_fim::time as hf, a.local
      from public.catalogo_agenda a
      order by public.norm_nome(a.profissional), public.norm_nome(a.unidade), a.dia_num, a.hora_ini::time, a.hora_fim::time
    ), res as (
      select distinct on (x.inicio, x.prof, x.unid, x.fonte)
        x.inicio, x.prof, x.unid, x.fonte, x.qtd, x.procedimento, pr.minutos, ag.local
      from x
      left join pr on pr.n = x.proc_n
      left join ag on ag.prof = x.prof and ag.unid = x.unid and ag.dia_num = extract(dow from x.inicio)::int
                   and x.inicio::time >= ag.hi and x.inicio::time < ag.hf
      order by x.inicio, x.prof, x.unid, x.fonte
    )
    insert into public.agenda_ocupacao as o (inicio, profissional, unidade, fonte, qtd, procedimento, reserva_min, local, visto_em)
    select inicio, prof, unid, fonte, qtd, procedimento, minutos, local, now() from res
    on conflict (inicio, profissional, unidade, fonte) do update set
      qtd = excluded.qtd, procedimento = excluded.procedimento, reserva_min = excluded.reserva_min, local = excluded.local, visto_em = now();
    get diagnostics v_n = row_count;
  end if;
  if p_finalizar then
    update public.agenda_ocupacao_meta set valido_desde = coalesce(p_execucao, now()), atualizado_em = now(),
      linhas = (select count(*) from public.agenda_ocupacao where visto_em >= coalesce(p_execucao, now())) where id = 1;
  end if;
  select linhas into v_tot from public.agenda_ocupacao_meta where id = 1;
  return jsonb_build_object('gravadas', v_n, 'vigentes', v_tot);
end $function$;

