-- FLUXOGRAMA: entrada (Id da Marcação nos dois relatórios do Klingo + chegada na fila) -> validação (só equipe: fila_exige_staff; telefone só em hash; nome confere) -> lógica (v_olho_marcacao junta klingo_conferencia #14554 ao vivo com jornada_exame; v_olho_fila liga a chegada à marcação) -> saída (fila_olho_hoje: por pessoa na fila, as marcações com status ao vivo; sem nome nem telefone)
-- Versão 1.0 — 14/11/2026 / Mudança: primeira versão (o "olho": status ao vivo do Klingo ao lado da fila do painel).
-- Rollback: drop function public.fila_olho_hoje(); drop view public.v_olho_fila; drop view public.v_olho_marcacao; select cron.unschedule('klingo-conferir-olho');
-- Leitura do #14554 a cada 2 min: select cron.schedule('klingo-conferir-olho', '*/2 * * * *', $$select public.klingo_conferir_agendar(2)$$);
-- As views v_olho_marcacao e v_olho_fila (security_invoker, só service_role) e a função fila_olho_hoje foram aplicadas na produção em 14/11/2026 (migração olho_fila_hoje + views).

create or replace view public.v_olho_marcacao with (security_invoker = true) as
select c.m as marcacao_id, e.atendimento_id, c.status_klingo as status_agora, c.lido_em as status_lido_em,
       e.status as situacao_jornada, e.confirm_status, e.cancelamento_motivo,
       c.marcado_em, c.exame_em, c.origem, c.unidade, c.plano, coalesce(e.procedimento, '') as procedimento, e.atualizado_em as jornada_atualizado_em
from public.klingo_conferencia c left join public.jornada_exame e on e.marcacao_id = c.m;
revoke all on public.v_olho_marcacao from anon, authenticated;
grant select on public.v_olho_marcacao to service_role;

create or replace view public.v_olho_fila with (security_invoker = true) as
select f.id as fila_id, f.senha, f.status as fila_status,
       case when f.status = 'aguardando' then public.fila_posicao(f.id) end as posicao,
       f.chegou_em, f.chamado_em, f.concluido_em,
       o.marcacao_id, o.atendimento_id, o.status_agora, o.situacao_jornada, o.procedimento, o.unidade
from public.fila_chegada f
left join public.contas_paciente cp on cp.id = f.conta_id
left join public.jornada_paciente jp
       on jp.fone_chave = encode(sha256(convert_to(right(regexp_replace(coalesce(f.telefone, cp.telefone, ''), '\D', '', 'g'), 8) || coalesce((select valor from public.config where chave = 'ia_segredo'), ''), 'UTF8')), 'hex')
      and public.nome_confere(jp.nome, coalesce(cp.nome, f.nome))
left join public.jornada_card c on c.paciente_chave = jp.prontuario and c.arquivado_em is null and c.data_ref = public.fila_dia(f.chegou_em)
      and c.paciente_chave not like 'conv:%' and c.paciente_chave not like 'manual:%'
left join public.jornada_exame e on e.card_id = c.id
left join public.v_olho_marcacao o on o.marcacao_id = e.marcacao_id;
revoke all on public.v_olho_fila from anon, authenticated;
grant select on public.v_olho_fila to service_role;
-- (a função fila_olho_hoje está em supabase/producao/funcoes/fila_olho_hoje.sql)
