-- FLUXOGRAMA: entrada (o dono liga ou desliga "Marcação automática" de cada unidade em Configurações > Marcação automática por unidade; config marcacao_auto_<unidade> = sim ou nao)
--   -> validação (unidade_marca_auto(unidade do Klingo): unidade desligada = false; unidade desconhecida ou chave ausente = true, para nunca travar sem querer)
--   -> lógica (chat_horarios esconde os horários da unidade desligada; chat_horario_escolher recusa o horário dela; klingo_pode_marcar não marca sozinho nela)
--   -> saída (o paciente vê o aviso "No momento o agendamento automático está disponível só para: <unidades ligadas>" e é encaminhado à equipe; nada é marcado no Klingo pelo chat).
-- Versão 1.0 — 16/11/2026 / Mudança: pedido do dono (cadastro feito na unidade errada): chaves por unidade para bloquear a marcação automática. Nasce tudo ligado (sem mudar o comportamento de hoje); o dono desliga as unidades que quiser.
-- Sem "drop": a ferramenta de migração pede confirmação para comandos que parecem destrutivos e expira em 60 s.
-- ROLLBACK: delete from public.config where chave like 'marcacao\_auto\_%'; e recriar chat_horarios, chat_horario_escolher e klingo_pode_marcar a partir de supabase/producao/funcoes/ (versão anterior); apagar unidade_marca_auto() e unidade_aviso_bloqueio().

-- Parte 1: chaves e funções de apoio
insert into public.config (chave, valor)
select 'marcacao_auto_' || u.chave, 'sim' from public.unidade_config u
on conflict (chave) do nothing;

create or replace function public.unidade_marca_auto(p_unidade text) returns boolean
 language sql stable security definer set search_path to ''
as $f$
  select coalesce((select c.valor <> 'nao' from public.config c where c.chave = 'marcacao_auto_' || public.unidade_chave(p_unidade)), true)
$f$;

create or replace function public.unidade_aviso_bloqueio() returns text
 language sql stable security definer set search_path to ''
as $f$
  select 'No momento, o agendamento automático está disponível só para ' ||
    coalesce((select string_agg(u.rotulo, ' e ' order by u.ordem) from public.unidade_config u where u.ativo and public.unidade_marca_auto(u.catalogo)), 'a equipe') ||
    '. Para as outras unidades, a nossa equipe faz o agendamento com você.'
$f$;
revoke all on function public.unidade_marca_auto(text), public.unidade_aviso_bloqueio() from public, anon, authenticated;
grant execute on function public.unidade_marca_auto(text), public.unidade_aviso_bloqueio() to service_role;
-- chat_horarios e chat_horario_escolher são security definer e rodam como dono: enxergam as funções acima.

