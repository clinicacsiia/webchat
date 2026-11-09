# WC-02: reconhecer no pedido do chat os agendamentos feitos no Klingo (v3, 10/11/2026)

**No ar desde 10/11/2026.** Arquivos: `supabase/agendamento-reconhecer-v3.sql`, Edge Function `supabase/functions/klingo-reconhecer/` (`casar.ts` compara; `index.ts` lê o Klingo). Testes: `npm run test:reconhecer-sql` (16), `npm run test:edge` (inclui `casar.test.ts`, 10).

## O problema
O programa só marcava "Agendado" quando a conferência achava marcação com mesmo horário, profissional e unidade, e a v2 só olhava o que a Jornada lia (exames dos próximos 30 dias). Muita marcação feita pela recepção (outra data, outro horário, mais de 30 dias à frente, conversa já encerrada) não era reconhecida.

## Como funciona agora
A cada 10 minutos o banco chama a função `klingo-reconhecer`, que:
1. pega os pedidos do chat dos últimos 14 dias que ainda não têm agendamento reconhecido (**"pronto"** de qualquer conversa; **"rascunho"** quando há atendente ou a conversa já encerrou);
2. lê do Klingo (relatório #13825) as marcações **criadas** desde a conversa mais antiga, de **qualquer data de exame**;
3. compara **na memória** (nome e telefone nunca são gravados nem aparecem no log) e devolve só o veredito.

**Quem é a pessoa:** nome completo igual (sem acento nem maiúsculas, 2 palavras ou mais). Com o mesmo telefone a identidade é "forte"; sem telefone igual, "média". Telefone igual com nome só parecido **não** conta. Dois cadastros com o mesmo nome completo = ambíguo: nada é escolhido e a atendente recebe um alerta.

**É agendamento deste pedido:** marcação **aberta** (não cancelada), **feita depois que a conversa começou** (marcação anterior à conversa nunca é agendamento do pedido) e com o **exame batendo**: mesmo nome do exame, ou um contido no outro ("CONSULTA" × "CONSULTA ORTOPEDIATRA"). Mesma família com nome diferente (duas consultas de especialidades diferentes) só vale se for a única marcação. Marcação de outro tipo de exame é ignorada.

**O que acontece:** o pedido vira **Agendado** com a **data, hora e unidade reais do Klingo** (a previsão do chat fica em `escolha_horario_chat`). Cada marcação do Klingo vale para **um pedido só**; se dois pedidos da mesma pessoa casam com a mesma marcação, vale o "pronto" mais recente.
- **Conversa aberta:** o paciente recebe a confirmação com exame, dia, horário, unidade e, quando já conhecido, o médico.
- **Conversa encerrada:** o pedido é marcado como agendado, mas **sem mensagem** ao paciente (chave `agendamento_reconhecer_msg_encerradas = 'sim'` para enviar).
- **Data, hora ou exame diferentes do pedido não bloqueiam:** o pedido fica com "remarcado" e, em conversa aberta, a atendente vê o alerta "Agendado conforme o Klingo… Confirme com o paciente; estando certo, pode encerrar a conversa."

## Primeira rodada (10/11/2026)
83 pedidos olhados, 1.921 marcações lidas do Klingo: **8 pedidos agendados** (2 em conversa aberta, com confirmação enviada; 6 em conversa encerrada) e 2 casos em que dois pedidos da mesma pessoa disputavam a mesma marcação. Agendados passaram de **4 para 13**. Entre eles estão marcações para fevereiro de 2027, que a leitura por data do exame não alcançava.

## Chaves e rotina
- Configurações > Encerramento e avaliação > "Reconhecer agendamentos feitos no Klingo" (`config.agendamento_reconhecer`).
- Rotina `agendamento-reconhecer-klingo` (pg_cron, 10 min). Testar sem gravar: chamar a função com `{"aplicar": false}` (devolve contagens e, por pedido, só exame, datas e unidade).
- Desfazer um caso: a previsão está em `escolha_horario_chat`; no painel, Pré-agendamento > "Voltar para pronto"; para liberar a marcação: `update pre_agendamentos set klingo_marcacoes = null where id = ...`.

## Limites conhecidos
- O relatório #13825 não traz o médico; ele só entra na mensagem quando a conferência automática já registrou "marcado em DD/MM HH:MM (MÉDICO, UNIDADE)" para o mesmo dia e horário.
- Paciente que marca com **outro nome** (ex.: o nome do responsável) não é reconhecido: o sistema só reconhece pelo nome completo do paciente do pedido.
- A v2 (SQL sobre a Jornada) foi desligada; a função dela continua no banco só para consulta.
