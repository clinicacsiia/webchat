-- ROLLBACK de supabase/textos-enxutos.sql (volta o texto anterior; só se ainda for o texto novo, para não apagar edição da equipe).
update public.fluxo_texto set texto = $t$Olá, {nome}! Vamos com calma. Para começar, preciso do seu CPF e da sua data de nascimento. Eles ficam protegidos e só servem para conferir quem é o paciente e já te oferecer o atendimento certo.$t$
 where chave = 'ola_cpf_proprio' and texto = $t$Olá, {nome}! Para começar, informe o seu CPF e a data de nascimento. Eles ficam protegidos e servem só para conferir quem é o paciente.$t$;
update public.fluxo_texto set texto = $t$Olá, {nome}! Vamos organizar o atendimento de {paciente}. Para começar, preciso do CPF e da data de nascimento de {paciente} (ou do responsável, se a criança não tiver CPF). Eles ficam protegidos e só servem para conferir quem é o paciente.$t$
 where chave = 'ola_cpf_filho' and texto = $t$Olá, {nome}! Para começar, informe o CPF e a data de nascimento de {paciente} (ou do responsável, se a criança não tiver CPF). Eles ficam protegidos e servem só para conferir quem é o paciente.$t$;
update public.fluxo_texto set texto = $t$Olá, {nome}! Que bom ter você aqui. 💚 Estamos criando uma solução para facilitar o atendimento e levar equidade para todos, e a nossa equipe melhora este espaço a cada dia, ouvindo como as pessoas o usam. É só tocar nas opções, com calma.$t$
 where chave = 'ola_proprio' and texto = $t$Olá, {nome}! É só tocar nas opções, com calma.$t$;
update public.fluxo_texto set texto = $t$Olá, {nome}! Que bom ter você e {paciente} aqui. 💚 Estamos criando uma solução para facilitar o atendimento e levar equidade para todos, e a nossa equipe melhora este espaço a cada dia, ouvindo como as pessoas o usam. Vamos organizar o atendimento de {paciente}: é só tocar nas opções.$t$
 where chave = 'ola_filho' and texto = $t$Olá, {nome}! Vamos organizar o atendimento de {paciente}: é só tocar nas opções.$t$;
update public.fluxo_texto set texto = $t$Para localizar o seu cadastro na clínica e agilizar o seu atendimento, preciso do CPF e da data de nascimento{de_quem}. Eles ficam protegidos e só servem para conferir quem é o paciente.$t$
 where chave = 'cpf_nasc' and texto = $t$Para localizar o seu cadastro, preciso do CPF e da data de nascimento{de_quem}. Eles ficam protegidos e servem só para conferir quem é o paciente.$t$;
-- Parte 3
update public.fluxo_texto set texto = replace(texto, $a$Ao confirmar, eu marco o agendamento no sistema da clínica. Se algo não der certo, um atendente entra para resolver com você.$a$,
  $b$Ao confirmar, o seu pedido segue para a nossa equipe. Uma pessoa vai conferir tudo e confirmar com você a data, o horário e o valor.$b$)
 where chave = 'confirmar' and texto like '%eu marco o agendamento no sistema da clínica%';
