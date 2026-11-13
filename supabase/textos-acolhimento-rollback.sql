-- ROLLBACK de supabase/textos-acolhimento.sql e textos-acolhimento-botao.sql (textos como estavam na produção em 13/11/2026, antes de aplicar).
-- Para o botão da lista de espera: reaplicar supabase/producao/funcoes/previsao_pergunta.sql.
update public.fluxo_texto set texto = $t$Olá, {nome}! Vamos com calma, é só tocar nas opções.$t$ where chave = 'ola_proprio';
update public.fluxo_texto set texto = $t$Olá, {nome}! Vamos organizar o atendimento de {paciente}. É só tocar nas opções.$t$ where chave = 'ola_filho';
update public.fluxo_texto set texto = $t$Agora escolha o dia e o horário que preferir. É uma previsão: o atendente confirma.$t$ where chave = 'horario';
update public.fluxo_texto set texto = $t$Confira se está tudo certo:
{resumo}

Ao confirmar, você envia uma PREVISÃO de agendamento. Quem confirma data, horário e valor é um atendente (uma pessoa da equipe).$t$ where chave = 'confirmar';
update public.fluxo_texto set texto = $t$Pronto, {nome}! Recebemos tudo e montamos a PREVISÃO do seu agendamento. Atenção: ainda não está confirmado. Um atendente (uma pessoa da equipe) vai conferir, marcar no sistema e te enviar aqui neste chat a confirmação de data, horário e valor, assim que possível. Se quiser falar com a equipe, é só escrever a qualquer momento.$t$ where chave = 'pronto_online';
update public.fluxo_texto set texto = $t$Pronto, {nome}! Montamos a PREVISÃO do seu agendamento e ela já está com a equipe. Ainda não está confirmado: no momento não estamos online, mas assim que possível um atendente (uma pessoa) vai conferir tudo e te enviar a confirmação aqui neste chat. Você pode escrever a qualquer momento.$t$ where chave = 'pronto_offline';
update public.fluxo_texto set texto = $t$Previsão de valor ({plano}):
{itens}
{total}Atenção: é só uma previsão. O valor final e a forma de pagamento são confirmados pelo atendente.$t$ where chave = 'preco_previsao';
update public.fluxo_texto set texto = $t$Não consegui concluir o agendamento sozinho, mas já passei tudo para a nossa equipe e uma pessoa confirma com você em instantes.$t$ where chave = 'marcar_equipe';
update public.fluxo_texto set texto = $t$O sistema da clínica demorou a responder. Já pedi para a equipe conferir a sua marcação, então você não precisa repetir nada.$t$ where chave = 'marcar_incerto';
update public.fluxo_texto set texto = $t$Não consegui agendar pelo convênio {plano} agora. Já passei para a equipe, que resolve com você e confirma o horário.$t$ where chave = 'marcar_plano';
update public.config set valor = $t$Os dias e horários que mostramos aqui são uma PREVISÃO. Quem confirma o seu agendamento é uma pessoa da nossa equipe.$t$ where chave = 'previsao_texto';
update public.config set valor = $t$Não temos horário disponível dentro do que você pediu. Você pode ficar na LISTA DE PREVISÃO. Atenção: isso NÃO confirma o dia do atendimento. É só uma previsão: se surgir vaga, nossa equipe entra em contato com você para combinar o dia e a hora.$t$ where chave = 'previsao_decide_texto';
update public.config set valor = $t$Anotado! Você ficou na lista de previsão. Lembrando: isso NÃO confirma o dia do atendimento. Se surgir uma vaga dentro do que você pediu, nossa equipe entra em contato para agendar o dia e a hora.$t$ where chave = 'previsao_final_texto';
