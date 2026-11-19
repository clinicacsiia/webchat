-- FLUXOGRAMA: entrada (pedido do dono, 19/11/2026: o card "Agendaram" da aba Indicadores deve contar as marcações FEITAS no dia, mesmo que a conversa do paciente seja de outro dia; hoje havia 3 marcações e o card mostrava 0) -> validação (painel_indicadores_pessoas continua só para admin e atendente; ind_pessoas_periodo só para o servidor; tipo só 'exame' ou 'consulta'; conversa de teste fora, salvo p_teste) -> lógica (1. "procuraram" e "atendidos" NÃO mudam: pessoas pelo dia em que abriram o chat; 2. "agendaram" = pessoas com marcação no Klingo cujo DIA DA MARCAÇÃO (klingo_conferencia.marcado_em = "Agendado Em" do relatório #14554) cai no período, ligada a uma conversa dela (por pedido, comprovante ou telefone+nome), qualquer que seja o dia da conversa; 3. "robo", "robo_sem_atendente", "faltaram", "cancelaram" e "faltaram_ou_cancelaram" são partes desse mesmo grupo; 4. nova chave agendaram_conversa_anterior = dessas, quantas têm conversa aberta antes do período; 5. marcação "Bloqueada" não é agendamento; 6. chave nova agendaram_da_coorte = a conta ANTIGA (pessoas que abriram o chat no período e têm marcação, de qualquer dia), mantida só para o funil do chat, que é por dia da conversa) -> saída (o mesmo JSON dos 5 números, com a chave nova).
-- Versão 1.0 — 19/11/2026 / Mudança: Implementação inicial. Só uma função é reescrita (CREATE OR REPLACE, mesma assinatura e permissões): ind_pessoas_periodo. A painel_indicadores_pessoas não muda.
-- ATENÇÃO (data): klingo_conferencia.marcado_em é a coluna "Agendado Em" do relatório #14554 e o tipo é DATE (só o dia). Compara-se direto com p_de/p_ate, SEM converter fuso: converter com at time zone 'America/Sao_Paulo' empurra a data para o dia anterior (19/11 vira 18/11 21:00) e o card de hoje daria 0.
-- Limite conhecido: "faltaram" e "cancelaram" vêm da Jornada (jornada_exame); enquanto a leitura da Jornada estiver parada (19/11/2026: 55 falhas seguidas) esses dois ficam abaixo do real. "Agendaram" não depende da Jornada.
-- ROLLBACK: restaurar a definição anterior em supabase/indicadores-cinco-numeros.sql (Parte 1: ind_pessoas_periodo), ou supabase/producao/funcoes/ind_pessoas_periodo.sql antes desta mudança. Nada mais foi criado.
-- APLICAR: uma parte só (uma função; create or replace, sem comando que a ferramenta de migração tome por destrutivo).

CREATE OR REPLACE FUNCTION public.ind_pessoas_periodo(p_de date, p_ate date, p_un text, p_teste boolean, p_tipo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tipo text := case when lower(coalesce(p_tipo, '')) in ('exame', 'consulta') then lower(p_tipo) end;
  v jsonb;
begin
  with
  pu as (select x.conversa_id, x.pessoa from public.painel_conversa_pessoa_un() x
          where p_un is null or (p_un = 'sem' and (x.chaves is null or cardinality(x.chaves) = 0)) or (p_un <> 'sem' and p_un = any (x.chaves))),
  -- Quem procurou o chat no período (pelo dia em que abriu a conversa).
  cv as (select c.id, pu.pessoa, c.primeiro_humano_em
           from public.conversas c join pu on pu.conversa_id = c.id
          where (p_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate),
  pd as (select cv.pessoa, pa.tipo
           from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id
          where v_tipo is null or pa.tipo = v_tipo),
  base as (select distinct cv.pessoa from cv
            where v_tipo is null or exists (select 1 from pd where pd.pessoa = cv.pessoa)),
  hum as (select cv.pessoa, bool_or(cv.primeiro_humano_em is not null) as humano from cv group by cv.pessoa),
  -- Marcações FEITAS no período (dia da marcação no Klingo), de qualquer conversa ligada a elas, seja qual for o dia da conversa.
  mc as (select pu.pessoa, kc.m, c.primeiro_humano_em, ((c.criado_em at time zone 'America/Sao_Paulo')::date < p_de) as conversa_anterior,
                (pa.agendado_origem = 'chat_api') as robo,
                exists (select 1 from public.jornada_exame je where je.marcacao_id = 'm' || kc.m and je.status = 'faltou') as faltou,
                exists (select 1 from public.jornada_exame je where je.marcacao_id = 'm' || kc.m and je.status = 'cancelado') as cancelou
           from public.klingo_conferencia kc
           join public.conversas c on c.id = kc.conversa_id
           join pu on pu.conversa_id = c.id
           left join lateral (select p.tipo, p.agendado_origem from public.pre_agendamentos p
                               where p.conversa_id = kc.conversa_id and kc.m = any (coalesce(p.klingo_marcacoes, '{}'))
                               order by p.atualizado_em desc limit 1) pa on true
          where (p_teste or not c.teste)
            and kc.status_klingo in ('Aberta', 'Cancelada')
            and kc.marcado_em between p_de and p_ate
            and (v_tipo is null or pa.tipo = v_tipo)),
  mk as (select mc.pessoa,
                bool_or(coalesce(mc.robo, false)) as robo,
                bool_or(coalesce(mc.robo, false) and mc.primeiro_humano_em is null) as robo_sem_atendente,
                bool_or(mc.faltou) as faltou,
                bool_or(mc.cancelou) as cancelou,
                bool_or(mc.conversa_anterior) as conversa_anterior
           from mc group by mc.pessoa)
  select jsonb_build_object(
    'procuraram', (select count(*) from base),
    'atendidos', (select count(*) from base b join hum on hum.pessoa = b.pessoa where hum.humano),
    'agendaram', (select count(*) from mk),
    'agendaram_da_coorte', (select count(distinct cv.pessoa) from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id
                             where cardinality(coalesce(pa.klingo_marcacoes, '{}')) > 0 and (v_tipo is null or pa.tipo = v_tipo)),
    'agendaram_conversa_anterior', (select count(*) from mk where mk.conversa_anterior),
    'robo', (select count(*) from mk where mk.robo),
    'robo_sem_atendente', (select count(*) from mk where mk.robo_sem_atendente),
    'faltaram', (select count(*) from mk where mk.faltou),
    'cancelaram', (select count(*) from mk where mk.cancelou),
    'faltaram_ou_cancelaram', (select count(*) from mk where mk.faltou or mk.cancelou)
  ) into v;
  return v;
end $function$;
REVOKE ALL ON FUNCTION public.ind_pessoas_periodo(date, date, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ind_pessoas_periodo(date, date, text, boolean, text) TO service_role;
