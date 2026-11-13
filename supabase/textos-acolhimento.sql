-- FLUXOGRAMA: entrada (textos que o paciente lê no chat) -> validação (só troca se o texto ainda for o atual; edição da equipe é preservada)
--   -> saída (textos acolhedores, sem a palavra "previsão", que dizem que nada está confirmado até uma pessoa da equipe confirmar).
-- Versão 1.1 — 13/11/2026 / Mudança: textos de acolhimento (equidade, melhoria contínua feita pela equipe, confiança, "família"); tira "previsão" do que o paciente lê.
-- Regra do dono (13/11/2026): a palavra "previsão" volta SÓ nos textos de dúvida/entrega para a equipe (pronto_*, marcar_equipe, marcar_incerto, marcar_plano) e no aviso do calendário sem conferência.
-- Tela interna da equipe (painel) e notas internas continuam com "previsão" de propósito.
-- ROLLBACK: o texto anterior de cada linha está em supabase/producao/ (retrato) e no comentário "-- antes:" de cada comando abaixo.
-- Aplicar em partes (a ferramenta de migração expira em 60 s); nenhum comando é destrutivo.

-- Parte 1: saudação (o aviso fixo do topo da tela já se apresenta como assistente automático)
-- antes: Olá, {nome}! Vamos com calma, é só tocar nas opções.
update public.fluxo_texto set texto = $t$Olá, {nome}! Que bom ter você aqui. 💚 Estamos criando uma solução para facilitar o atendimento e levar equidade para todos, e a nossa equipe melhora este espaço a cada dia, ouvindo como as pessoas o usam. É só tocar nas opções, com calma.$t$
 where chave = 'ola_proprio' and texto = 'Olá, {nome}! Vamos com calma, é só tocar nas opções.';
-- antes: Olá, {nome}! Vamos organizar o atendimento de {paciente}. É só tocar nas opções.
update public.fluxo_texto set texto = $t$Olá, {nome}! Que bom ter você e {paciente} aqui. 💚 Estamos criando uma solução para facilitar o atendimento e levar equidade para todos, e a nossa equipe melhora este espaço a cada dia, ouvindo como as pessoas o usam. Vamos organizar o atendimento de {paciente}: é só tocar nas opções.$t$
 where chave = 'ola_filho' and texto = 'Olá, {nome}! Vamos organizar o atendimento de {paciente}. É só tocar nas opções.';

-- Parte 2: horário, confirmação e pedido pronto
-- antes: Agora escolha o dia e o horário que preferir. É uma previsão: o atendente confirma.
update public.fluxo_texto set texto = $t$Agora escolha o dia e o horário que ficam melhores para a sua rotina. Depois, uma pessoa da nossa equipe confirma tudo com você.$t$
 where chave = 'horario' and texto = 'Agora escolha o dia e o horário que preferir. É uma previsão: o atendente confirma.';
-- antes: ...Ao confirmar, você envia uma PREVISÃO de agendamento. Quem confirma data, horário e valor é um atendente (uma pessoa da equipe).
update public.fluxo_texto set texto = replace(texto, $a$Ao confirmar, você envia uma PREVISÃO de agendamento. Quem confirma data, horário e valor é um atendente (uma pessoa da equipe).$a$,
  $b$Ao confirmar, o seu pedido segue para a nossa equipe. Uma pessoa vai conferir tudo e confirmar com você a data, o horário e o valor.$b$)
 where chave = 'confirmar' and texto like '%PREVISÃO de agendamento%';
-- antes: Pronto, {nome}! Recebemos tudo e montamos a PREVISÃO do seu agendamento. Atenção: ainda não está confirmado. ...
update public.fluxo_texto set texto = $t$Pronto, {nome}! Recebemos tudo e já está com a nossa equipe. 💚 O horário que você escolheu é uma previsão e ainda não está confirmado: um atendente (uma pessoa) vai conferir, marcar no sistema e te enviar aqui a confirmação de data, horário e valor, assim que possível. Se quiser falar com a gente, é só escrever a qualquer momento.$t$
 where chave = 'pronto_online' and texto like '%PREVISÃO do seu agendamento%';
-- antes: Pronto, {nome}! Montamos a PREVISÃO do seu agendamento e ela já está com a equipe. ...
update public.fluxo_texto set texto = $t$Pronto, {nome}! Recebemos tudo e já está com a nossa equipe. 💚 No momento não estamos online, mas assim que possível um atendente (uma pessoa) vai conferir e te enviar aqui a confirmação de data, horário e valor. O horário que você escolheu é uma previsão e ainda não está confirmado. Você pode escrever a qualquer momento.$t$
 where chave = 'pronto_offline' and texto like '%PREVISÃO do seu agendamento%';

-- Parte 3: valor e lista de espera
-- antes: Previsão de valor ({plano}): ... Atenção: é só uma previsão. O valor final e a forma de pagamento são confirmados pelo atendente.
update public.fluxo_texto set texto = $t$Valor estimado ({plano}):
{itens}
{total}O valor final e a forma de pagamento são confirmados com você pelo atendente.$t$
 where chave = 'preco_previsao' and texto like 'Previsão de valor%';
update public.config set valor = $t$Os dias e horários que mostramos aqui são sugestões para facilitar a sua escolha. Quem confirma o seu agendamento é uma pessoa da nossa equipe.$t$
 where chave = 'previsao_texto' and valor like '%PREVISÃO%';
update public.config set valor = $t$Não temos horário disponível dentro do que você pediu. Você pode ficar na nossa LISTA DE ESPERA. Atenção: isso NÃO confirma o dia do atendimento. Se surgir uma vaga, nossa equipe entra em contato com você para combinar o dia e a hora.$t$
 where chave = 'previsao_decide_texto' and valor like '%PREVISÃO%';
update public.config set valor = $t$Anotado! Você ficou na nossa lista de espera. Lembrando: isso NÃO confirma o dia do atendimento. Se surgir uma vaga dentro do que você pediu, nossa equipe entra em contato para agendar o dia e a hora.$t$
 where chave = 'previsao_final_texto' and valor like '%previsão%';

-- Parte 4: quando a automação não conclui (dúvida, falha ou regra não atendida) o paciente é avisado de que é uma previsão e a equipe assume
-- antes: Não consegui concluir o agendamento sozinho, mas já passei tudo para a nossa equipe e uma pessoa confirma com você em instantes.
update public.fluxo_texto set texto = $t$Não consegui concluir o agendamento sozinho. O horário que você escolheu fica como uma previsão, ainda não confirmada, e já passei tudo para a nossa equipe: uma pessoa confirma com você em instantes.$t$
 where chave = 'marcar_equipe' and texto = 'Não consegui concluir o agendamento sozinho, mas já passei tudo para a nossa equipe e uma pessoa confirma com você em instantes.';
-- antes: O sistema da clínica demorou a responder. Já pedi para a equipe conferir a sua marcação, então você não precisa repetir nada.
update public.fluxo_texto set texto = $t$O sistema da clínica demorou a responder. O seu horário fica como uma previsão, ainda não confirmada, até a equipe conferir a marcação. Você não precisa repetir nada.$t$
 where chave = 'marcar_incerto' and texto = 'O sistema da clínica demorou a responder. Já pedi para a equipe conferir a sua marcação, então você não precisa repetir nada.';
-- antes: Não consegui agendar pelo convênio {plano} agora. Já passei para a equipe, que resolve com você e confirma o horário.
update public.fluxo_texto set texto = $t$Não consegui agendar pelo convênio {plano} agora. O seu horário fica como uma previsão, ainda não confirmada. Já passei para a equipe, que resolve com você e confirma.$t$
 where chave = 'marcar_plano' and texto = 'Não consegui agendar pelo convênio {plano} agora. Já passei para a equipe, que resolve com você e confirma o horário.';
