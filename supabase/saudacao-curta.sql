-- Saudação mais curta: o aviso fixo do topo já diz que é IA, que é previsão e que quem confirma é um atendente.
-- Só troca se o texto ainda for o da Fase 9 (edição da equipe é preservada).
update public.fluxo_texto set texto = $t$Olá, {nome}! Vamos com calma, é só tocar nas opções.$t$
 where chave = 'ola_proprio' and texto like 'Olá, {nome}! Eu sou o assistente virtual da clínica%';
update public.fluxo_texto set texto = $t$Olá, {nome}! Vamos organizar o atendimento de {paciente}. É só tocar nas opções.$t$
 where chave = 'ola_filho' and texto like 'Olá, {nome}! Eu sou o assistente virtual da clínica%';
