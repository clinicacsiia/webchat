# Relatório da revisão das conversas — 24/11/2026

Base lida: 623 conversas (29/10 a 23/11), 13.616 mensagens. Excluí as 23 conversas de teste. Li os textos de uma amostra dirigida: as conversas abertas, as encerradas sem motivo claro e as não respondidas. As demais foram analisadas por contagem.
Sem nome, CPF, telefone ou e-mail neste arquivo. As conversas são citadas pelos 6 primeiros caracteres do ID.

## 1. Retrato do chat (números)

| Item | Valor |
|---|---|
| Conversas abertas agora | 66 (65 em atendimento, 1 aguardando) |
| Encerradas: não respondido | 231 (37%) |
| Encerradas: agendado | 173 (28%) |
| Encerradas: só informação | 75 |
| Encerradas sem motivo registrado | 36 |
| Encerradas "outro" / "desistiu" / "nova conversa" | 11 / 4 / 4 |
| Pediram atendente | 149 |
| Tempo até a primeira resposta humana, depois do pedido | mediana 4,8 min; 90% em até 27,5 min |
| Pediram atendente e nunca foram atendidos | 0 |

A equipe responde bem e rápido. O problema está no que o robô faz ao redor da equipe e nos pontos em que a pessoa desiste antes de chegar a ela.

## 2. Problemas encontrados (do mais grave ao menos grave)

### 2.1 O robô fala por cima da equipe (215 avisos, 129 com atendente já na conversa)
O aviso "Estamos com muitas conversas, seu pedido segue na fila…" foi enviado 215 vezes. Em 129 delas (60%) um atendente já tinha respondido naquela conversa. Também há 10 avisos de "fora do horário de trabalho" em conversas em que a equipe tinha respondido nas 3 horas anteriores.
Exemplos: 1d5aea, fc7d84, d1af89, af0ae3. O aviso aparece entre duas respostas da atendente. Para o paciente parece que ninguém está cuidando dele.
**Correção sugerida:** não enviar esses avisos quando já houve resposta humana na conversa. Só enviar se a última mensagem humana for antiga (por exemplo, mais de 30 min) e o paciente esperar há mais tempo que isso.

### 2.2 Maior perda de pacientes: 44 não respondidos terminam no aviso de fila
Dos 231 "não respondido", o último passo do robô foi:
- 44: "Estamos com muitas conversas…". A pessoa já escreveu em média 8 mensagens.
- 31: "Agora escolha o dia e o horário… é uma previsão" (4,5 mensagens).
- 28: "Um atendente vai continuar com você…" (5,7 mensagens).
- 18: aviso de fora do horário (10,4 mensagens).
Mais de 100 pessoas que pediram ajuda ou chegaram à previsão e foram fechadas como "não respondido". Muitas escreveram bastante, então a demanda era real. Vale conferir quantas foram encerradas pelo fechamento automático e quantas tinham resposta humana pendente (`autoencerramento_fechada`).
Há também conversas encerradas com o paciente esperando: 3175a2 e 4161c8 (pedido atendido, mas o robô respondeu "um atendente vai responder" depois do "obrigada").

### 2.3 Conversa "encerrada" que continua aberta (8 casos)
A mensagem "Seu atendimento foi encerrado!" é enviada, e a conversa continua em atendimento. Exemplos: 187872, 22b467, 54f1fb, 93e034. Em seguida a atendente "entra na conversa" de novo. Em 22b467 e 187872 as mensagens de teste da equipe aparecem logo antes ou depois do encerramento (provável teste em conversa real). Isso mistura a fila com conversas já resolvidas.
Em 54f1fb a marcação foi confirmada no sistema e o encerramento foi enviado. A conversa ficou aberta mesmo assim.

### 2.4 Conversas fantasma e conversas paradas há muito tempo
- 9879a7: "aguardando" há 304 horas (cerca de 12 dias). O paciente tocou em "Consulta" e recebeu o aviso "a plataforma só agenda para a Desenvoar". Ele não voltou e a conversa ficou aberta. Conta como pendência na fila.
- 6 conversas com o robô ligado (`ia_ativa`) e a equipe dentro (c9dbe3, 3e83cf, 6c3a43, 9d1697, 93e034, fddb07). O robô e a atendente falam ao mesmo tempo.

### 2.5 Mensagens de teste da equipe em conversas reais
6 mensagens "teste" em 2 conversas reais (03da02 e 22b467). Em 03da02 a pessoa tinha escrito "Quero reabrir este pedido" e recebeu "teste" três vezes. Aparece para o paciente. Vale orientar a equipe a testar só em conversas marcadas como teste.

### 2.6 A saudação da atendente chega repetida e fora de hora
A saudação "Bom dia X, seja bem-vindo(a)…" e a mensagem de "Estamos finalizando nosso atendimento por falta de retorno" aparecem seguidas (c9dbe3, 6c3a43, 9d1697, d2010d). Com a pessoa ainda escrevendo, a segunda mensagem soa como se o atendimento fosse cortado.

### 2.7 Encerramentos sem motivo (36) e motivos mal usados
- 36 conversas encerradas sem motivo. Nas que li, quase todas eram agendamentos concluídos pela equipe ("Marcado", "Disponha"). Deveriam ser "agendado". Isso distorce o indicador de conversão (28% pode ser perto de 33%).
- "Desistiu" contém um cancelamento de consulta (032350) e uma pessoa que só perguntou o valor (65632c). Não é desistência de marcação.
- "Outro" contém casos de lista de espera (aac16d), pessoa que ficou com o horário atual (a2b0e1), pedido sem vaga (50cd20) e previsão montada (3296cc). Falta um motivo "sem vaga / lista de espera".

### 2.8 Desistência durante o cadastro (previsão)
Quem escolhe o horário da previsão e chega ao cadastro pára com frequência: "Agora os dados para o cadastro de…" aparece como último passo em 6c8a31, 83d838, 383f1b, e a carteirinha do convênio em 3 casos. São pedidos de agendamento reais que se perdem no cadastro. Conferir se a pessoa foi acompanhada por um atendente depois.

### 2.9 Erros técnicos do navegador (`incidente_chat`)
987 registros do tipo RPC (falha ao chamar o banco a partir do aparelho), 83 DES e 62 LNT. Concentram-se nos passos horário (39 + 23), confirmar (29 + 24 + 23), médico e humano, a maioria em Android e iPhone. Pico em 23/11, que também é o último dia com dados. Não vi o texto do erro. Precisa de uma análise própria: pode ser perda de rede do celular ou uma função lenta.

### 2.10 Pontos menores
- Frase que se repete 516 vezes: "Consulta". É a primeira escolha de quase todo mundo (508 de 600 conversas). O botão atende bem.
- 149 pedidos de atendente ("Quero falar com um atendente.") em 24% das conversas. Entre as respostas, a equipe faz as mesmas perguntas várias vezes ("Já é paciente?", "Preferência de turno e médica?"). Dá para virar respostas prontas.
- O acesso rápido está sendo bem usado: 126 conversas usaram os dados salvos e 101 confirmaram o PIN.
- Agenda esgotada: Dra. Ludmila só em dezembro, Dr. Alexandre em 01/12, Dr. Fábio sem vagas. Vários pedidos de "amanhã" ou "hoje" não têm como ser atendidos. A previsão e a lista de espera estão funcionando como saída.
- O aviso "somente a Desenvoar" confunde: 9879a7 parou nele.

## 3. Resumo por tema

**Estrutura do chat:** 2.1, 2.2, 2.3, 2.4, 2.6, 2.8 (o robô e a equipe se atrapalham; a fila perde pessoas).
**Conversas e uso:** 2.5, 2.7, 2.10 (testes em conversa real, motivos de encerramento, repetição de perguntas).
**Técnico:** 2.9 (erros do navegador).

## 4. O que eu faria primeiro (ordem)
1. Parar os avisos do robô quando a equipe já respondeu (2.1). Mudança de função no banco; segue o fluxo do CLAUDE.md (arquivo novo, teste no clone, rollback).
2. Descobrir por que 44 + 28 conversas pediram atendente e terminaram "não respondido" (2.2). Medir quantas receberam resposta humana.
3. Encerrar de verdade as conversas que já mandaram "atendimento encerrado" e a de 304 h (2.3, 2.4).
4. Corrigir a classificação do motivo de encerramento, incluindo "sem vaga / lista de espera" (2.7).
5. Investigar os erros do navegador (2.9) lendo o campo `detalhe`.
6. Orientar a equipe sobre testes em conversa real (2.5).

Nada foi alterado na produção. Esta revisão não conta como a "revisão mensal" da pendência 2.11 até você aprovar; a data não foi atualizada.
