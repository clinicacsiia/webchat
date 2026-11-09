# WC-02: reconhecer agendamentos feitos no Klingo (09/11/2026)

**No ar desde 09/11/2026** (SQL aplicado; chave `agendamento_reconhecer = sim`). Arquivo: `supabase/agendamento-reconhecer.sql`. Teste: `npm run test:reconhecer-sql` (14 verificações).

## O que estava errado
O pedido do chat só virava "Agendado" quando a conferência automática achava no Klingo uma marcação com **mesmo horário, mesmo profissional e mesma unidade** (ou quando alguém tocava "Marcar como agendado"). Se a recepção marcasse o mesmo horário com **outro profissional**, ou outra data, o pedido ficava para sempre em "pronto"/"divergente" e não contava.

## O que passou a acontecer
A cada 5 minutos, para os pedidos em "pronto" ou "rascunho" dos últimos 14 dias, o banco compara com o que a Jornada já leu do Klingo (relatório #14359), sem nova chamada ao Klingo:
- O paciente precisa bater em **telefone e nome** (a mesma regra do fechamento do exame; telefone igual com nome diferente, como família, não vale) e a marcação precisa ter sido **feita depois que a conversa começou**.
- **Mesma data e horário** (até 30 min; por ordem de chegada basta o dia): o pedido vira **Agendado**, **sem mensagem ao paciente** (quem marcou foi a recepção).
- **Só em outras datas**: o status **não muda**; o pedido mostra o aviso "O paciente já tem marcação no Klingo em outras datas: …" para a equipe decidir (Marcar como agendado). Conversa ainda aberta também recebe o alerta.
- Quem já tem veredito da conferência automática não tem o texto trocado. Unidade e profissional não são comparados; a conferência de 10 em 10 minutos continua avisando se o profissional for diferente.

## Resultado na primeira rodada
Agendados passaram de **2 para 4**. Os dois pacientes pedidos: **Flora Juriti de Oliveira Cordeiro** (Klingo 02/12 08:00, mesmo horário escolhido no chat, outro profissional) virou **Agendado**; **Anthony Kauã Nogueira Machado** tem 2 marcações no Klingo em datas diferentes da escolhida (14/11 e 24/11) e o pedido estava incompleto, então ficou com o **aviso** para a equipe.

## Chave e rotina
- Configurações > Encerramento e avaliação > "Reconhecer agendamentos feitos no Klingo" (`config.agendamento_reconhecer`).
- Rotina `agendamento-reconhecer` (pg_cron, 5 minutos). Simular sem gravar: `select public.agendamento_reconhecer_klingo(false);`.
- Desfazer um caso: no painel, Pré-agendamento > voltar para "pronto" (ou cancelar). Desligar tudo: chave em "não" ou `cron.unschedule('agendamento-reconhecer')`.
