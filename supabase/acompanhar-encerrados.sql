-- FLUXOGRAMA: entrada (o paciente do acesso rápido, com o PIN ativo, abre "Acompanhe seus pedidos"; a equipe encerra, reabre ou cancela conversas no painel)
--   -> validação (aparelho conhecido e desbloqueado; cada ação confere que a conversa é do cadastro; apagar pedido com exame marcado só vale depois de a conversa encerrar; reabrir só até 30 dias depois do encerramento e só se a conversa não foi substituída por outra)
--   -> lógica (a lista passa a trazer o estado real da conversa no painel: aberta ou encerrada, o MOTIVO e a data do encerramento, se dá para avaliar, reabrir ou apagar, e quando some sozinha;
--              encerrar no painel muda a "assinatura" e vira novidade; a ordem é "o que está mais perto do dia" primeiro e, no empate, o que foi atualizado por último; apagar = tirar da lista do paciente;
--              cancelar um pedido que ainda não tem exame marcado = cancelar o pré-agendamento, encerrar a conversa como "Paciente desistiu" e tirar da lista;
--              reabrir = a conversa volta para a fila da equipe com a mensagem do paciente; avaliar = a mesma avaliação do chat (chat_avaliar))
--   -> saída (JSON para a tela; nada de CPF, e-mail ou telefone; o código da conversa só sai nas ações que já o devolviam)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (pedidos encerrados pelo painel, avaliar, reabrir, cancelar e apagar, apagar sozinho, ordem da lista)
--
-- DEPENDE DE: acompanhar-pedidos.sql (app_conversa, app_pedido_dados, app_pedidos), acesso-rapido-paciente.sql (app_aparelho_validar, app_erro_json), avaliacao.sql (chat_avaliar), despedida.sql.
--
-- O QUE "APAGAR" SIGNIFICA (decisão de segurança; o dono pode mudar):
--   Apagar TIRA O PEDIDO DA LISTA DO PACIENTE (app_conversa.removido_em). A conversa, as mensagens, a avaliação e os indicadores continuam no painel da clínica, porque o prazo de guarda
--   ainda não foi definido pelo jurídico (docs/pendencias-do-dono.md, item 2.5) e apagar de verdade a conversa apagaria junto avaliações, encerramentos, pré-agendamento e histórico dos indicadores (tudo em cascata).
--   Apagar nunca cancela marcação no Klingo. Para cancelar exame marcado o caminho continua sendo "Cancelar" (a conversa confirma com o paciente e consulta o Klingo).
--   Apagar sozinho: 30 dias depois do encerramento. Se ainda houver exame marcado por vir, conta 30 dias depois da data do último exame (para o exame marcado não sumir da tela antes de acontecer).
--   Se a conversa apagada for reaberta (pelo chat ou pela equipe), ela volta a aparecer.
--
-- ROLLBACK (volta ao comportamento da versão 1.0 do acompanhar-pedidos.sql):
--   1) recriar app_pedido_dados com o texto de acompanhar-pedidos.sql (seção 2);
--   2) drop function if exists public.app_pedido_apagar(text, uuid), public.app_pedido_reabrir(text, uuid), public.app_pedido_avaliar(text, uuid, numeric, numeric, text);
--   3) alter table public.app_conversa drop column if exists removido_em, drop column if exists removido_por;
-- COMO APLICAR (limite de 60 s do conector): em TRÊS partes, na ordem das seções (1; 2; 3). Pode ser aplicado mais de uma vez.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 1. Coluna que marca o pedido apagado da lista do paciente
-- ---------------------------------------------------------------------------------------------------------------------------------------------
alter table public.app_conversa add column if not exists removido_em timestamptz;
alter table public.app_conversa add column if not exists removido_por text;
do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_conversa_removido_por_ck') then
    alter table public.app_conversa add constraint app_conversa_removido_por_ck check (removido_por is null or removido_por in ('paciente', 'cancelou'));
  end if;
end $c$;
comment on column public.app_conversa.removido_em is 'O paciente apagou o pedido da lista (ou cancelou e apagou). A conversa continua no painel. Volta a aparecer se a conversa for reaberta.';

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 2. A lista de pedidos agora conhece o estado da conversa no painel
--    ok: 1 pedido, 2 marcado, 3 confirmado, 4 chegou, 5 exame feito. excecao: cancelado | faltou. 0 = pedido ainda não concluído.
--    Conversas SEM exame também entram quando a equipe já atendeu ou encerrou de verdade (para o paciente poder avaliar ou reabrir). Ficam de fora: encerrada por "não respondido"
--    ou por "nova conversa" (o paciente abriu outra), e conversa aberta que ninguém da equipe tocou ainda.
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.app_pedido_dados(p_pac uuid, p_conversa uuid default null) returns jsonb
language sql stable security definer set search_path to ''
as $f$
  with hoje as (
    select to_char(now() at time zone 'America/Bahia', 'YYYY-MM-DD') as d
  ), base as (
    select ac.conversa_id, ac.pessoa_nome, ac.eu, ac.visto_sig, c.status as cstatus, c.criado_em, c.atualizado_em, c.encerrada_em, c.motivo_encerramento as motivo,
           c.encerramento_origem as origem, c.primeiro_humano_em, pa.tipo as pre_tipo, pa.status as pre_status,
           pa.procedimento as pre_proc, pa.escolha_horario as pre_hor, pa.unidade as pre_unidade
      from public.app_conversa ac
      join public.conversas c on c.id = ac.conversa_id
      left join public.pre_agendamentos pa on pa.conversa_id = c.id
     where ac.paciente_id = p_pac and (p_conversa is null or ac.conversa_id = p_conversa)
       and (ac.removido_em is null or c.status <> 'encerrada' or c.encerrada_em > ac.removido_em)   -- apagado some; reaberto volta
  ), jor as (
    select b.conversa_id, e.id as exame_id, e.procedimento as nome, e.unidade,
           to_char(e.agendado_para at time zone 'America/Bahia', 'YYYY-MM-DD') as data, to_char(e.agendado_para at time zone 'America/Bahia', 'HH24:MI') as hora,
           case when e.status in ('cancelado', 'faltou') or (e.status = 'pedido' and b.pre_status = 'cancelado') then null   -- pedido cancelado no painel: o exame do pedido também
                when e.status = 'atendido' then 5
                when e.status = 'pedido' then 1
                when jc.coluna in ('chegou', 'em_atendimento') then 4
                when e.status = 'confirmado' or lower(coalesce(e.confirm_status, '')) = 'confirmado' then 3
                else 2 end as ok,
           case when e.status in ('cancelado', 'faltou') then e.status when e.status = 'pedido' and b.pre_status = 'cancelado' then 'cancelado' end as excecao
      from base b
      join public.jornada_card jc on jc.conversa_id = b.conversa_id
      join public.jornada_exame e on e.card_id = jc.id
     where e.status <> 'remarcado'
  ), pre as (   -- pedido que o chat montou e o Klingo ainda não devolveu (ou nunca devolverá): itens do próprio pedido
    select b.conversa_id, null::bigint as exame_id, coalesce(nullif(i.procedimento, ''), nullif(b.pre_proc, ''), 'Atendimento') as nome, b.pre_unidade as unidade,
           b.pre_hor -> 0 ->> 'data' as data, b.pre_hor -> 0 ->> 'hora' as hora,
           case b.pre_status when 'agendado' then 2 when 'pronto' then 1 else 0 end as ok,
           case when b.pre_status = 'cancelado' then 'cancelado' end as excecao
      from base b
      left join public.pre_agendamento_itens i on i.conversa_id = b.conversa_id and i.ativo
     where not exists (select 1 from jor j where j.conversa_id = b.conversa_id)
       and b.pre_status in ('rascunho', 'pronto', 'agendado', 'cancelado')
       and (b.pre_status <> 'rascunho' or b.criado_em > now() - interval '14 days')
       and (i.id is not null or b.pre_proc is not null)
  ), todos as (
    select * from jor union all select * from pre
  ), com_res as (
    select t.*, case when t.ok = 5 then coalesce(r.estado, 'aguardando') end as res, r.id as res_id, r.conversa_resultado_id as res_conv
      from todos t
      left join public.app_resultado r on r.paciente_id = p_pac and r.conversa_id = t.conversa_id and t.exame_id is not null and r.exame_id = t.exame_id
  ), por_conversa as (
    select b.*,
           -- dentro do cartão: o que ainda vai acontecer primeiro (do mais perto para o mais longe); depois o que já passou (o mais recente primeiro)
           coalesce(jsonb_agg(jsonb_build_object('id', x.exame_id, 'nome', x.nome, 'unidade', x.unidade, 'data', x.data, 'hora', x.hora, 'ok', x.ok, 'excecao', x.excecao,
                                                 'resultado', x.res, 'resultado_id', x.res_id, 'resultado_conversa', x.res_conv)
                             order by (x.data is not null and x.data < (select d from hoje)), case when x.data >= (select d from hoje) then x.data end, x.data desc nulls last, x.hora, x.nome)
                    filter (where x.nome is not null), '[]'::jsonb) as exames,
           md5(coalesce(string_agg(coalesce(x.exame_id::text, 'p') || ':' || coalesce(x.ok::text, 'x') || ':' || coalesce(x.excecao, '') || ':' || coalesce(x.data, '') || coalesce(x.hora, '') || ':' || coalesce(x.res, ''),
                                   '|' order by x.exame_id nulls last, x.nome) filter (where x.ok >= 2 or x.excecao is not null), '')
               || case when b.cstatus = 'encerrada' then '|enc:' || coalesce(b.encerrada_em::text, '') else '' end) as sig,   -- encerrar no painel também é novidade
           min(x.data) filter (where x.excecao is null and x.ok < 5 and x.data >= (select d from hoje)) as proxima,                   -- o dia mais perto ainda por vir
           coalesce(bool_or(x.ok between 2 and 5), false) as tem_exame_ativo,                                                         -- marcado, confirmado, chegou ou feito
           max(x.data) filter (where x.ok between 2 and 4) as ultima_data                                                              -- o último exame marcado ainda não feito
      from base b left join com_res x on x.conversa_id = b.conversa_id
     group by b.conversa_id, b.pessoa_nome, b.eu, b.visto_sig, b.cstatus, b.criado_em, b.atualizado_em, b.encerrada_em, b.motivo, b.origem, b.primeiro_humano_em,
              b.pre_tipo, b.pre_status, b.pre_proc, b.pre_hor, b.pre_unidade
  ), pronto as (
    select pc.*,
           case when pc.cstatus = 'encerrada' and pc.encerrada_em is not null
                then greatest(pc.encerrada_em, coalesce(case when pc.ultima_data ~ '^\d{4}-\d{2}-\d{2}$' then pc.ultima_data::date::timestamp at time zone 'America/Bahia' end, pc.encerrada_em)) + interval '30 days' end as apaga_em
      from por_conversa pc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'conversa', conversa_id, 'pessoa', pessoa_nome, 'eu', eu, 'aberta', cstatus <> 'encerrada', 'status', cstatus, 'criado_em', criado_em, 'atualizado_em', atualizado_em,
           'tipo', pre_tipo, 'pre_status', pre_status, 'exames', exames, 'sig', sig, 'novo', visto_sig is not null and visto_sig <> sig,
           'encerrada_em', encerrada_em, 'motivo', motivo, 'origem', origem, 'apaga_em', apaga_em, 'proxima', proxima,
           'pode_reabrir', cstatus = 'encerrada' and origem is distinct from 'paciente' and encerrada_em > now() - interval '30 days',
           'pode_avaliar', cstatus = 'encerrada' and motivo is distinct from 'nao_respondido'
                           and coalesce((select valor from public.config where chave = 'avaliacao_ativa'), 'nao') = 'sim'
                           and exists (select 1 from public.mensagens m where m.conversa_id = pronto.conversa_id and (m.opcoes ->> 'tipo') = 'despedida' and (m.opcoes ->> 'encerrada_em')::timestamptz = pronto.encerrada_em)
                           and not exists (select 1 from public.avaliacao_atendimento a where a.conversa_id = pronto.conversa_id and a.encerrada_em = pronto.encerrada_em),
           'avaliou', cstatus = 'encerrada' and exists (select 1 from public.avaliacao_atendimento a where a.conversa_id = pronto.conversa_id and a.encerrada_em = pronto.encerrada_em),
           'pode_apagar', cstatus = 'encerrada' or (not tem_exame_ativo and coalesce(pre_status, '') <> 'agendado'),   -- aberta com exame marcado: antes é preciso cancelar o exame pela conversa
           'cancela_ao_apagar', cstatus <> 'encerrada',                                                                  -- aberta e sem exame marcado: apagar também cancela o pedido
           'reservado', proxima is not null and tem_exame_ativo)
         -- ordem: abertas primeiro; entre elas o dia mais perto primeiro e, no empate (ou sem dia), a atualizada por último primeiro; encerradas por último, a mais recente primeiro
         order by (cstatus = 'encerrada'), case when cstatus <> 'encerrada' then proxima end nulls last,
                  case when cstatus = 'encerrada' then encerrada_em else atualizado_em end desc nulls last, criado_em desc), '[]'::jsonb)
    from pronto
   where (jsonb_array_length(exames) > 0
          or (cstatus = 'encerrada' and origem is distinct from 'paciente' and coalesce(motivo, '') not in ('nao_respondido', 'nova_conversa'))
          or (cstatus <> 'encerrada' and primeiro_humano_em is not null))
     and not (cstatus = 'encerrada' and apaga_em < now())   -- 30 dias depois do encerramento (ou do último exame marcado): some sozinha
$f$;
revoke all on function public.app_pedido_dados(uuid, uuid) from public, anon, authenticated;

-- Uma única vez: o que já estava encerrado antes desta versão não vira "novidade" só porque a assinatura mudou
update public.app_conversa ac
   set visto_sig = coalesce((select e ->> 'sig' from jsonb_array_elements(public.app_pedido_dados(ac.paciente_id, ac.conversa_id)) e limit 1), ac.visto_sig)
 where ac.visto_sig is not null and ac.removido_em is null;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3. Ações: apagar (e cancelar, quando ainda não há exame marcado), reabrir e avaliar
-- ---------------------------------------------------------------------------------------------------------------------------------------------

-- Apagar da lista. Conversa encerrada: só tira da lista. Conversa aberta sem exame marcado: cancela o pedido (pré-agendamento e itens), avisa a equipe
-- dentro da conversa, encerra como "Paciente desistiu" e tira da lista. Aberta com exame marcado: recusa (o exame se cancela pela conversa, que confirma no Klingo).
create or replace function public.app_pedido_apagar(p_token text, p_conversa uuid) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare s record; c public.conversas; ac public.app_conversa%rowtype; v_p jsonb; v_cancelou boolean := false;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select * into ac from public.app_conversa where paciente_id = s.o_pac and conversa_id = p_conversa;
  if not found then return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Não encontrei este pedido neste cadastro.'); end if;
  select * into c from public.conversas where id = p_conversa;
  if c.id is null then return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Esta conversa não está mais disponível.'); end if;

  if c.status <> 'encerrada' then
    select e into v_p from jsonb_array_elements(public.app_pedido_dados(s.o_pac, p_conversa)) e limit 1;
    if v_p is not null and (v_p ->> 'pode_apagar')::boolean is not true then
      return jsonb_build_object('ok', false, 'erro', 'ativo', 'mensagem', 'Este pedido tem exame marcado. Cancele o exame primeiro (toque no pedido e escolha Cancelar); depois dá para apagar.');
    end if;
    update public.pre_agendamentos set status = 'cancelado', conferencia_status = null, conferencia_detalhe = null, atualizado_em = now()
     where conversa_id = c.id and status in ('rascunho', 'pronto');
    update public.pre_agendamento_itens set ativo = false where conversa_id = c.id and ativo;
    insert into public.mensagens (conversa_id, autor, texto) values (c.id, 'sistema', 'O paciente cancelou este pedido pelo "Acompanhe seus pedidos".');
    update public.conversas set status = 'encerrada', ia_ativa = false, motivo_encerramento = 'desistiu', encerramento_origem = 'sistema' where id = c.id;
    v_cancelou := true;
  end if;

  update public.app_conversa set removido_em = now(), removido_por = case when v_cancelou then 'cancelou' else 'paciente' end
   where paciente_id = s.o_pac and conversa_id = p_conversa;
  return jsonb_build_object('ok', true, 'cancelado', v_cancelou);
end $f$;
revoke all on function public.app_pedido_apagar(text, uuid) from public;
grant execute on function public.app_pedido_apagar(text, uuid) to anon, authenticated;

-- Reabrir o pedido: a conversa encerrada volta para a fila da equipe (não para o assistente), com a mensagem do paciente.
-- Vale até 30 dias depois do encerramento (no chat comum são 2 dias: aqui o paciente pede por um botão claro). Conversa que o paciente já substituiu por outra não reabre.
create or replace function public.app_pedido_reabrir(p_token text, p_conversa uuid) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare s record; c public.conversas; v_tok text;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if not exists (select 1 from public.app_conversa where paciente_id = s.o_pac and conversa_id = p_conversa) then
    return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Não encontrei este pedido neste cadastro.');
  end if;
  select * into c from public.conversas where id = p_conversa;
  select token into v_tok from public.conversa_segredo where conversa_id = p_conversa;
  if c.id is null or v_tok is null then return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Esta conversa não está mais disponível.'); end if;
  if c.status = 'encerrada' then
    if c.encerramento_origem = 'paciente' then
      return jsonb_build_object('ok', false, 'erro', 'substituida', 'mensagem', 'Este pedido já continuou em uma conversa nova. Abra a conversa mais recente.');
    end if;
    if c.encerrada_em is null or c.encerrada_em < now() - interval '30 days' then
      return jsonb_build_object('ok', false, 'erro', 'prazo', 'mensagem', 'Já passou o prazo para reabrir. Abra uma conversa nova pelo chat.');
    end if;
    begin
      update public.conversas set status = 'aguardando', agente_id = null where id = c.id;   -- o gatilho limpa o encerramento e liga o assistente...
      update public.conversas set ia_ativa = false where id = c.id;                          -- ...e aqui ele sai: reabrir é chamar a equipe (marca "paciente aguardando")
      perform public.chat_enviar(c.id, v_tok, 'Quero reabrir este pedido.');
    exception when others then
      return jsonb_build_object('ok', false, 'erro', 'reabrir', 'mensagem', 'Não foi possível reabrir agora. Tente de novo ou fale com a clínica.');
    end;
    update public.app_conversa ac set visto_em = now(),
           visto_sig = coalesce((select e ->> 'sig' from jsonb_array_elements(public.app_pedido_dados(ac.paciente_id, ac.conversa_id)) e limit 1), md5(''))
     where ac.paciente_id = s.o_pac and ac.conversa_id = c.id;
  end if;
  select * into c from public.conversas where id = p_conversa;
  return jsonb_build_object('ok', true, 'conversa', c.id, 'token', v_tok, 'aberta', c.status <> 'encerrada', 'reaberta', true, 'tipo', coalesce(c.paciente_tipo, 'proprio'),
                            'paciente_nome', c.paciente_nome, 'irmaos', coalesce(c.irmaos, '[]'::jsonb), 'irmaos_modo', c.irmaos_modo);
end $f$;
revoke all on function public.app_pedido_reabrir(text, uuid) from public;
grant execute on function public.app_pedido_reabrir(text, uuid) to anon, authenticated;

-- Avaliar o atendimento (a mesma avaliação do chat: duas notas de 0 a 10 e por onde conheceu). Quem decide se pode é chat_avaliar.
create or replace function public.app_pedido_avaliar(p_token text, p_conversa uuid, p_nota_atendimento numeric, p_nota_site numeric, p_canal text) returns jsonb
language plpgsql security definer set search_path to ''
as $f$
declare s record; v_tok text; r jsonb;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if not exists (select 1 from public.app_conversa where paciente_id = s.o_pac and conversa_id = p_conversa) then
    return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Não encontrei este pedido neste cadastro.');
  end if;
  select token into v_tok from public.conversa_segredo where conversa_id = p_conversa;
  if v_tok is null then return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Esta conversa não está mais disponível.'); end if;
  begin
    r := public.chat_avaliar(p_conversa, v_tok, p_nota_atendimento, p_nota_site, p_canal);
  exception when others then
    return jsonb_build_object('ok', false, 'erro', 'avaliar', 'mensagem', case when sqlstate = '22023' then sqlerrm else 'Não foi possível enviar agora. Tente de novo.' end);
  end;
  return r;
end $f$;
revoke all on function public.app_pedido_avaliar(text, uuid, numeric, numeric, text) from public;
grant execute on function public.app_pedido_avaliar(text, uuid, numeric, numeric, text) to anon, authenticated;
