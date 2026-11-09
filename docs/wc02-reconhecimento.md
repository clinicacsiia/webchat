# WC-02: reconhecer agendamentos feitos no Klingo (09/11/2026; regra v2 de 10/11)

**No ar desde 09/11/2026** (SQL aplicado; chave `agendamento_reconhecer = sim`). Arquivo: `supabase/agendamento-reconhecer.sql`. Teste: `npm run test:reconhecer-sql` (16 verificações).

## O que estava errado (antes)
O pedido do chat só virava "Agendado" quando a conferência automática achava no Klingo uma marcação com **mesmo horário, mesmo profissional e mesma unidade** (ou quando alguém tocava "Marcar como agendado"). Se a recepção marcasse o mesmo horário com **outro profissional**, ou outra data, o pedido ficava para sempre em "pronto"/"divergente" e não contava.

## Regra atual (versão 2, decidida pelo dono em 09/11/2026)
A cada 5 minutos, para os pedidos em "pronto" (ou "rascunho" com atendente na conversa) **cuja conversa está aberta**, o banco procura o paciente no que a Jornada já leu do Klingo (relatório #14359):
- **Basta o nome completo** do paciente do pedido aparecer no Klingo (igual depois de tirar acento e caixa; o telefone **não** é exigido).
- O pedido vira **Agendado** com a **data, hora e unidade reais do Klingo**: o que veio do chat era só previsão, e a previsão original fica guardada em `escolha_horario_chat`.
- O paciente recebe no chat a **mensagem de confirmação** com os dados do Klingo (exame, dia, horário, unidade e, quando conhecido, o médico).
- **Nada é bloqueado por divergência.** Se data, horário, exame ou médico diferem do pedido, a conversa recebe o alerta "Agendado conforme o Klingo… Confirme com o paciente; estando certo, pode encerrar a conversa."
- Conversa **encerrada** não é tocada. Dois cadastros com o mesmo nome completo: não escolhe, só alerta a atendente.
- **Guarda mantida:** só conta marcação **feita depois que a conversa começou** (menos 1 hora) e ainda por vir. Sem isso, uma consulta antiga do mesmo paciente viraria "agendado" de um pedido novo: em 09/11/2026 três pedidos abertos tinham o nome no Klingo, mas com marcações feitas em agosto, setembro e outubro, de outros atendimentos.
- O médico só entra na mensagem quando a conferência automática já guardou "marcado em DD/MM HH:MM (MÉDICO, UNIDADE)" para o mesmo dia e horário (o relatório da Jornada não traz o médico).

## Chave e rotina
- Configurações > Encerramento e avaliação > "Reconhecer agendamentos feitos no Klingo" (`config.agendamento_reconhecer`).
- Rotina `agendamento-reconhecer` (pg_cron, 5 minutos). Simular sem gravar: `select public.agendamento_reconhecer_klingo(false);`.
- Desfazer um caso: no painel, Pré-agendamento > voltar para "pronto" (ou cancelar). Desligar tudo: chave em "não" ou `cron.unschedule('agendamento-reconhecer')`.
