-- FLUXOGRAMA: entrada (o paciente abre a lista de consultas ou de exames no chat; uma rotina sonda no Klingo, aos poucos, quais exames têm horário) -> validação (o filtro só vale se config.klingo_so_liberados = 'sim' E esta conversa está no autoatendimento; senão a lista é a de sempre) -> lógica (consulta aparece se a especialidade está liberada na API; exame some só se o Klingo foi consultado nos últimos 7 dias e não tinha horário (exame ainda não consultado continua aparecendo)) -> saída (o paciente só vê o que o Klingo libera)
-- Versão 1.0 — 12/11/2026 / Mudança: pedido do dono (mostrar ao paciente só consultas e exames liberados no Klingo, com chave para ligar e desligar em Configurações). Começa DESLIGADO.
-- ROLLBACK: update public.config set valor = 'nao' where chave = 'klingo_so_liberados' (a lista volta ao normal na hora); para remover de vez: select cron.unschedule('klingo-sondar-exames'); e recriar chat_consultas, chat_exames e chat_exames_buscar a partir de supabase/producao/funcoes/.
-- APLICAR EM PARTES: 15a (chave, funções novas e rotina), 15b (chat_consultas e chat_exames), 15c (chat_exames_buscar).

-- Parte 15a
insert into public.config (chave, valor) values ('klingo_so_liberados', 'nao') on conflict (chave) do nothing;

CREATE OR REPLACE FUNCTION public.klingo_liberado(p_conversa uuid, p_proc integer, p_tipo text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if public.klingo_cfg('klingo_so_liberados', 'nao') <> 'sim' then return true; end if;
  if not public.klingo_ativo(p_conversa, 'klingo_api_marcar') then return true; end if;   -- fora do autoatendimento a lista é a de sempre
  if p_tipo = 'consulta' then
    return exists (select 1 from public.klingo_especialidade e where e.liberada_api and p_proc = any (e.procedimentos));
  end if;
  -- exame: só some se o Klingo foi consultado há menos de 7 dias e NÃO tinha horário; exame ainda não consultado continua aparecendo
  return not exists (select 1 from public.klingo_proc_api a where a.procedimento_id = p_proc and a.vazio_em > now() - interval '7 days'
                       and (a.com_horario_em is null or a.com_horario_em < a.vazio_em));
end $function$;
REVOKE ALL ON FUNCTION public.klingo_liberado(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.klingo_liberado(uuid, integer, text) TO service_role;

CREATE OR REPLACE FUNCTION public.klingo_exames_sondar(p_n integer DEFAULT 15)
 RETURNS SETOF integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p.id from public.catalogo_procedimento p
   where p.ativo and p.modalidade in ('RM', 'TC', 'US', 'RX', 'MAMO', 'DENSITO')
     and exists (select 1 from public.catalogo_agenda a where a.procedimento_id = p.id and a.vig_fim >= current_date and a.profissional !~* 'teste')
     and coalesce((select greatest(x.com_horario_em, x.vazio_em) from public.klingo_proc_api x where x.procedimento_id = p.id), 'epoch'::timestamptz) < now() - interval '3 days'
   order by coalesce(p.demanda_90d, 0) desc, p.id limit greatest(1, least(coalesce(p_n, 15), 40))
$function$;
REVOKE ALL ON FUNCTION public.klingo_exames_sondar(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.klingo_exames_sondar(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.klingo_sondagem_gravar(p_proc integer, p_tem boolean)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into public.klingo_proc_api (procedimento_id, com_horario_em, vazio_em)
  values (p_proc, case when p_tem then now() end, case when not p_tem then now() end)
  on conflict (procedimento_id) do update set com_horario_em = case when p_tem then now() else public.klingo_proc_api.com_horario_em end,
                                              vazio_em = case when not p_tem then now() else public.klingo_proc_api.vazio_em end
$function$;
REVOKE ALL ON FUNCTION public.klingo_sondagem_gravar(integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.klingo_sondagem_gravar(integer, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.klingo_sondar_disparar()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo();
begin
  if v_base = '' or v_seg is null or public.klingo_mestre() = 'nao' then return; end if;   -- só gasta chamadas do Klingo com o autoatendimento ligado
  if not exists (select 1 from public.klingo_exames_sondar(1)) then return; end if;
  perform net.http_post(url := v_base || 'klingo-sincronizar', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('acao', 'exames'), timeout_milliseconds := 120000);
exception when others then null;
end $function$;
REVOKE ALL ON FUNCTION public.klingo_sondar_disparar() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.klingo_sondar_disparar() TO service_role;

select cron.schedule('klingo-sondar-exames', '*/10 * * * *', 'select public.klingo_sondar_disparar()');

-- Parte 15b
CREATE OR REPLACE FUNCTION public.chat_consultas(p_conversa uuid, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_cat text; v_med text;
begin
  perform public.chat_valida(p_conversa, p_token);
  select u.catalogo, c.medico_preferido into v_cat, v_med
  from public.conversas c left join public.unidade_config u on u.chave = c.unidade_inicial where c.id = p_conversa;
  return jsonb_build_object('medico_preferido', v_med, 'consultas', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'rotulo', x.rotulo, 'do_medico', coalesce(v_med = any(x.medicos), false))
                     order by coalesce(v_med = any(x.medicos), false) desc, x.profissionais desc, x.rotulo)
    from (select * from public.consultas_da_unidade(v_cat) cu where public.klingo_liberado(p_conversa, cu.id, 'consulta') limit 24) x), '[]'::jsonb));
end $function$;

CREATE OR REPLACE FUNCTION public.chat_exames(p_conversa uuid, p_token text, p_modalidade text, p_regiao text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.chat_valida(p_conversa, p_token);
  if p_modalidade not in ('RM','TC','US','RX','MAMO','DENSITO') then raise exception 'Modalidade inválida.' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'unilateral', e.unilateral, 'bilateral', e.bilateral))
                   from public.catalogo_exames_regiao(p_modalidade, coalesce(nullif(p_regiao, ''), 'todos')) e where public.klingo_liberado(p_conversa, e.id, 'exame')), '[]'::jsonb);
end $function$;

-- Parte 15c
CREATE OR REPLACE FUNCTION public.chat_exames_buscar(p_conversa uuid, p_token text, p_termo text, p_ocr boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_linhas text[]; l text; t text; v_mods text[]; v_regs text[]; v_lado text; r jsonb := '[]'::jsonb; v_parte jsonb; v_tok text[]; v_b int[]; n int := 0;
begin
  perform public.chat_valida(p_conversa, p_token);
  v_linhas := case when p_ocr then (select array_agg(x) from (select btrim(x) x from regexp_split_to_table(left(coalesce(p_termo, ''), 4000), '[\n;]+') x) q where length(x) >= 4)
                   else array[left(coalesce(p_termo, ''), 120)] end;
  foreach l in array coalesce(v_linhas, array['']) loop
    exit when n >= 12;
    t := public.fluxo_norm_exame(l);
    v_mods := array_remove(array[case when t ~ '\mRM\M' then 'RM' end, case when t ~ '\mTC\M' then 'TC' end, case when t ~ '\mUS\M|DOPPLER' then 'US' end,
                                 case when t ~ '\mRX\M' then 'RX' end, case when t ~ 'MAMOGRAF' then 'MAMO' end, case when t ~ 'DENSITOMETR' then 'DENSITO' end], null);
    select array_agg(g.codigo order by g.ordem) into v_regs from public.catalogo_regiao g
     where t <> '' and t ~ ('(' || split_part(g.padrao, '|^(?!', 1) || ')');
    v_lado := case when t ~ '\mBILATERA|\mAMBOS\M|\mDOIS LADOS' then 'A' when t ~ '\mDIREIT' then 'D' when t ~ '\mESQUERD' then 'E' end;
    v_tok := array(select w from unnest(string_to_array(t, ' ')) w where length(w) >= 2 and w !~ '^\d+$'
                   and w !~ '^(DIREITO|DIREITA|ESQUERDO|ESQUERDA|BILATERAL|AMBOS|LADO|LADOS|DOIS|EXAME|EXAMES|SOLICITO|SOLICITACAO|PEDIDO|FAVOR|REALIZAR|FAZER|QUERO|PRECISO|UM|UMA)$');
    select coalesce(array_agg(x.id), '{}') into v_b from public.fluxo_exames x
     where cardinality(v_tok) > 0 and (cardinality(v_mods) = 0 or x.modalidade = any(v_mods))
       and coalesce((select bool_and(x.chave ~ ('\m' || w)) from unnest(v_tok) w where w !~ '^(RM|TC|US|RX)$' or cardinality(v_mods) = 0), false);
    with cand as (
      select x.id, x.nome, x.modalidade, null::text as regiao, x.demanda, 0 as fonte from public.fluxo_exames x where x.id = any(v_b)
      union all
      select x.id, x.nome, x.modalidade, g.codigo, x.demanda, 1
      from public.fluxo_exames x join public.catalogo_regiao g on g.codigo = any(v_regs) and x.chave_reg ~ g.padrao
      where cardinality(v_regs) > 0 and (cardinality(v_mods) > 0 or cardinality(v_b) = 0)
        and x.modalidade = any(case when cardinality(v_mods) > 0 then v_mods else array['RM','TC','US','RX'] end)
      union all
      select x.id, x.nome, x.modalidade, null, x.demanda, 3 from public.fluxo_exames x
      where not p_ocr and cardinality(v_tok) = 0 and coalesce(cardinality(v_regs), 0) = 0 and x.modalidade <> 'OUTRO' and x.demanda > 0
    ), um as (
      select distinct on (c.id) c.* from cand c order by c.id, c.fonte
    ), lim as (
      select u.*, row_number() over (order by u.fonte, u.demanda desc, u.nome) as ord from um u where public.klingo_liberado(p_conversa, u.id, 'exame')
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'modalidade', x.modalidade, 'regiao', reg.codigo, 'regiao_nome', reg.nome,
             'tem_lado', coalesce(reg.tem_lado, false), 'bilateral', x.nome ~* 'BILATERAL', 'lado', v_lado, 'linha', case when p_ocr then left(l, 120) end,
             'sugerido', p_ocr and x.ord = 1) order by x.ord), '[]'::jsonb) into v_parte
    from lim x
    left join lateral (select g.codigo, g.nome, g.tem_lado from public.catalogo_regiao g
                       where g.codigo = x.regiao or (x.regiao is null and regexp_replace(public.norm_nome(x.nome), 'NAO INCLUI.*$', '') ~ g.padrao)
                       order by (g.codigo = x.regiao) desc, g.ordem limit 1) reg on true
    where x.ord <= case when p_ocr then 3 else 24 end;
    r := r || v_parte; n := n + 1;
  end loop;
  return r;
end $function$;
