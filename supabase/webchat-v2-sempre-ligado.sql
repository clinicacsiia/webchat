-- FLUXOGRAMA: entrada (qualquer função do chat ou Edge Function pergunta klingo_ativo / klingo_modo(conversa, chave)) -> validação (a conversa existe) -> processamento (a resposta é sempre "sim": o autoatendimento do Klingo fica LIGADO PARA SEMPRE;
--   única exceção: klingo_api_resultado, porque a integração de laudo ainda não existe e segue a chave de configuração) -> persistência (nenhuma) -> saída ('sim' ou 'nao')
-- Versão 1.0 — 14/11/2026 / Mudança: decisão do dono — o v2 fica ligado para sempre. SAEM os interruptores de liberação: modo por capacidade (nao/teste/sombra/sim), mestre klingo_auto, lista de telefones de teste, percentual de conversas,
--   autogestão (recuo automático a cada 10 min) e promoção. FICAM: (1) agendamento_externo_modo e os limites por IP/CPF da página pública /agendamento/ (proteção contra abuso, não é liberação); (2) config_auditoria (trilha de qualquer mudança em config);
--   (3) klingo_api_resultado (a entrega de laudo não tem integração; continua desligada até existir).
-- ATENÇÃO — efeito imediato: marcar, cancelar, remarcar, ver marcações, cadastrar paciente novo, horários reais da API, aviso de vaga futura e a busca de vagas passam a valer para TODOS os pacientes e sem freio automático.
--   Para parar tudo numa emergência: publicar a versão anterior das Edge Functions ou reaplicar as funções abaixo (ver "Como voltar atrás").
-- Como voltar atrás: reaplicar as 4 funções {klingo_mestre,klingo_modo,klingo_autogestao,klingo_agendamento_passar} como estavam no retrato 1.8 (estado ANTES desta migração; a pasta supabase/producao/ já guarda a versão NOVA):
--   git show 17d6bc8:supabase/producao/funcoes/<nome>.sql   (commit "Retrato da produção 1.8") e recriar a rotina:
--   select cron.schedule('klingo-autogestao', '*/10 * * * *', 'select public.klingo_autogestao()');   e depois ajustar as chaves klingo_auto e klingo_api_* em public.config para o modo desejado (valores de 14/11/2026 antes da migração: klingo_auto=sim, horarios=sombra, marcar/pre_cadastro/pos/cancelar/remarcar/consultar/previsao_modo=teste, resultado/monitor/notificacao=nao).

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 1. Portas sempre abertas
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.klingo_mestre() returns text
  language sql stable security definer set search_path to ''
as $f$ select 'sim'::text $f$;

-- klingo_ativo(conversa, chave) = klingo_modo(...) in ('teste','sim')  e  klingo_sombra(conversa, chave) = klingo_modo(...) = 'sombra': continuam iguais e passam a dar sempre "ativo" e nunca "sombra".
create or replace function public.klingo_modo(p_conversa uuid, p_chave text) returns text
  language sql stable security definer set search_path to ''
as $f$
  select case
    when p_chave = 'klingo_api_resultado' then case when public.klingo_cfg('klingo_api_resultado', 'nao') = 'sim' then 'sim' else 'nao' end
    when p_conversa is not null and exists (select 1 from public.conversas c where c.id = p_conversa) then 'sim'   -- conversa que não existe nunca libera nada
    else 'nao' end
$f$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 2. Sem autogestão: a rotina deixa de existir e a função vira um registro de que foi removida
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.klingo_autogestao() returns jsonb
  language sql stable security definer set search_path to ''
as $f$ select jsonb_build_object('ligada', false, 'motivo', 'removida') $f$;

select cron.unschedule('klingo-autogestao') where exists (select 1 from cron.job where jobname = 'klingo-autogestao');

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3. Página pública /agendamento/: a trava de escrita deixa de depender do mestre klingo_auto (a chave agendamento_externo_modo continua: sim | leitura | nao)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
do $m$
declare d text := pg_get_functiondef('public.klingo_agendamento_passar(text,text,text)'::regprocedure); a text := $a$(v_modo = 'leitura' or v_mestre = 'nao')$a$; n integer;
begin
  if position(a in d) = 0 then return; end if;   -- já aplicado (reaplicar é seguro)
  n := (length(d) - length(replace(d, a, ''))) / length(a);
  if n <> 1 then raise exception 'klingo_agendamento_passar: trecho do mestre achado % vez(es) (esperado 1)', n; end if;
  execute replace(d, a, $b$v_modo = 'leitura'$b$);
end $m$;
