-- FLUXOGRAMA: entrada (a cada 5 minutos, os pedidos do chat ainda em 'pronto' ou 'rascunho' dos últimos 14 dias + os exames que a Jornada já leu do Klingo) -> validação (o paciente do pedido precisa ser o mesmo do Klingo: marca do telefone E nome; só marcações FEITAS depois que a conversa começou; só exame agendado/confirmado; prontuário do chat "conv:" é ignorado) -> lógica (se há marcação na MESMA data e horário escolhidos no chat: o pedido vira 'agendado', sem mandar mensagem ao paciente; se só há marcação em OUTRAS datas: não muda o status, só avisa a equipe com as datas) -> saída (status/aviso no cartão do pré-agendamento e contagens, sem dado de paciente).
-- Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-02 da Atualização do WebChat).
-- Por que existe: a conferência automática (agenda-conferir) só confirma quando horário, profissional e unidade batem. Se a recepção marca o mesmo horário com OUTRO profissional (ou em outra data), o pedido ficava para sempre em 'pronto'/'divergente' e não contava como agendado. Aqui o reconhecimento usa o que a Jornada já lê do Klingo (relatório por data do exame, #14359), sem nova chamada ao Klingo.
-- Pré-requisitos: fase3-conferencia-automatica.sql (colunas conferencia_*), pacientes.sql (nome_confere), jornada (jornada_paciente, jornada_card, jornada_exame). Aditivo e idempotente. Nenhum comando destrutivo.
-- A UNIDADE não é comparada (nomes diferentes entre o chat e o Klingo). O profissional também não: a conferência automática de 10 em 10 minutos continua avisando se o profissional for diferente.
-- TESTAR SEM GRAVAR: select public.agendamento_reconhecer_klingo(false);   -- só conta e devolve os ids técnicos
-- DESLIGAR: select cron.unschedule('agendamento-reconhecer');   ou   update public.config set valor = 'nao' where chave = 'agendamento_reconhecer';
-- DESFAZER UM CASO: no painel, em Pré-agendamento, "Voltar para pronto" (ou Cancelar); o pedido volta a ser avaliado só se a chave estiver ligada.

insert into public.config (chave, valor) values ('agendamento_reconhecer', 'sim') on conflict (chave) do nothing;

create or replace function public.agendamento_reconhecer_klingo(p_aplicar boolean default true) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_sal text; r record; v_exatos integer := 0; v_outras integer := 0; v_det text;
  v_ids_exatos uuid[] := '{}'; v_ids_outras uuid[] := '{}';
begin
  if p_aplicar and coalesce((select valor from public.config where chave = 'agendamento_reconhecer'), 'sim') <> 'sim' then
    return jsonb_build_object('desligado', true);
  end if;
  select valor into v_sal from public.config where chave = 'ia_segredo';
  for r in
    with pre as (
      select pa.id as pre_id, pa.conversa_id, pa.escolha_horario, c.criado_em as conv_criada, c.status as conv_status, pa.conferencia_detalhe, pa.conferencia_status,
             coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), ct.nome) as nome,
             array(select distinct encode(sha256(convert_to(right(d, 8) || coalesce(v_sal, ''), 'UTF8')), 'hex')
                     from (select regexp_replace(coalesce(x, ''), '\D', '', 'g') as d
                             from unnest(array[ct.telefone, pa.paciente ->> 'celular', pa.paciente ->> 'telefone']) x) q
                    where length(d) >= 8) as fones
        from public.pre_agendamentos pa
        join public.conversas c on c.id = pa.conversa_id
        join public.contatos ct on ct.id = c.contato_id
       where pa.status in ('pronto', 'rascunho') and pa.criado_em > now() - interval '14 days'
         and jsonb_typeof(pa.escolha_horario) = 'array' and jsonb_array_length(pa.escolha_horario) > 0
    ), ex as (
      select pre.pre_id, pre.conversa_id, pre.escolha_horario, pre.conv_status, pre.conferencia_detalhe, pre.conferencia_status, e.procedimento,
             (e.agendado_para at time zone 'America/Bahia') as quando
        from pre
        join public.jornada_paciente p on p.fone_chave = any (pre.fones) and p.prontuario not like 'conv:%' and public.nome_confere(p.nome, pre.nome)
        join public.jornada_card k on k.paciente_chave = p.prontuario and k.arquivado_em is null
        join public.jornada_exame e on e.card_id = k.id and e.status in ('agendado', 'confirmado') and e.agendado_para is not null
                                   and e.agendado_em >= pre.conv_criada - interval '1 hour'
    )
    select ex.pre_id, ex.conversa_id, ex.conv_status, ex.conferencia_detalhe, ex.conferencia_status,
           bool_or(exists (select 1 from jsonb_array_elements(ex.escolha_horario) s
                            where (s ->> 'data')::date = ex.quando::date
                              and (coalesce((s ->> 'chegada')::boolean, false)
                                   or abs(extract(epoch from ((s ->> 'data')::date + (s ->> 'hora')::time) - ex.quando)) <= 1800))) as exato,
           string_agg(coalesce(nullif(btrim(ex.procedimento), ''), 'Atendimento') || ' ' || to_char(ex.quando, 'DD/MM HH24:MI'), '; ' order by ex.quando) as datas
      from ex group by ex.pre_id, ex.conversa_id, ex.conv_status, ex.conferencia_detalhe, ex.conferencia_status
  loop
    if r.exato then
      v_exatos := v_exatos + 1; v_ids_exatos := v_ids_exatos || r.pre_id;
      if p_aplicar then
        -- Sem mensagem ao paciente (confirmacao_enviada_em preenchida): quem marcou foi a recepção, e a conversa pode até já estar encerrada.
        update public.pre_agendamentos set status = 'agendado', conferencia_status = 'confirmado', conferencia_detalhe = null, conferencia_via = 'ambos',
               conferencia_em = now(), conferencia_falhas = 0, agendado_auto_em = now(), confirmacao_enviada_em = coalesce(confirmacao_enviada_em, now()), atualizado_em = now()
         where id = r.pre_id and status in ('pronto', 'rascunho');
      end if;
    else
      v_det := left('O paciente já tem marcação no Klingo em outras datas: ' || r.datas || '. Se foi feita a partir deste pedido, toque em "Marcar como agendado".', 300);
      -- Só escreve o aviso se a conferência automática ainda não deu o seu veredito (senão os dois ficariam trocando o texto a cada ciclo).
      if r.conferencia_detalhe is distinct from v_det and (r.conferencia_status is null or r.conferencia_detalhe like 'O paciente já tem marcação no Klingo%') then
        v_outras := v_outras + 1; v_ids_outras := v_ids_outras || r.pre_id;
        if p_aplicar then
          update public.pre_agendamentos set conferencia_status = 'divergente', conferencia_detalhe = v_det, conferencia_em = now() where id = r.pre_id and status in ('pronto', 'rascunho');
          if r.conv_status <> 'encerrada' then
            update public.conversas set alerta_agenda = 'Já tem marcação no Klingo em outras datas', atualizado_em = now() where id = r.conversa_id and alerta_agenda is distinct from 'Já tem marcação no Klingo em outras datas';
          end if;
        end if;
      end if;
    end if;
  end loop;
  return jsonb_build_object('aplicado', p_aplicar, 'mesma_data_e_hora', v_exatos, 'outras_datas', v_outras, 'ids_mesma_data_e_hora', v_ids_exatos, 'ids_outras_datas', v_ids_outras);
end $$;
revoke all on function public.agendamento_reconhecer_klingo(boolean) from public, anon, authenticated;
grant execute on function public.agendamento_reconhecer_klingo(boolean) to service_role;

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cron' and p.proname = 'schedule') then
    perform cron.schedule('agendamento-reconhecer', '*/5 * * * *', 'select public.agendamento_reconhecer_klingo()');
  end if;
end $$;
