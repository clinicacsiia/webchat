# Auditoria dos indicadores (17/11/2026)

> **Mudança de escopo (17/11/2026, pedido do dono): a aba mostra só o que tem a ver com o webchat.** A agenda da clínica toda saiu da tela (e a comparação "o site é X% da clínica"). A seção de marcações passou a contar **só as marcações do Klingo ligadas a uma conversa do chat** (143 hoje, 7 de teste ficam fora), com as mesmas contas. Os números de clínica toda nas seções 1 a 3 abaixo seguem aqui só como prova de que o Klingo é a fonte confiável. Números do chat de 03 a 16/11 (exame nesse período): 30 marcações, 4 remarcadas, 26 ficaram, 24 confirmaram, 18 atendidas, 3 faltaram, 5 ainda sem fechamento; marcadas no período: 135 (123 ativas). A amostra é pequena porque o chat é novo e as consultas são marcadas para datas futuras. "Confirmar adianta?" só compara com 20 ou mais marcações passadas de cada lado.

Pedido do dono: usar só dado real (nada de teste), conferir todo número e toda conta, descobrir qual fonte é mais fiel, e refazer a aba para **contar uma história** (agendados → confirmaram → vieram → faltaram), sem jargão, com o que a supervisão usa no dia a dia e fala na reunião.

Tudo abaixo foi medido na produção em 17/11/2026 (só contagens; nenhum dado de paciente saiu do banco). Funções novas: `supabase/indicadores-agenda.sql` (migrações `indicadores_agenda_parte1..5`).

## 1. Qual fonte é a mais fiel? O Klingo

| Comparação | Resultado |
|---|---|
| Relatório #14359 (`jornada_exame`, por data do exame) × relatório #14554 (`klingo_conferencia`, por data em que foi marcado), marcações novas por dia, 02 a 16/11 | **Iguais em 13 dos 15 dias; nos outros 2 a diferença é de 1 marcação.** Os dois relatórios do Klingo concordam: dá para confiar neles. |
| "Agendaram pelo chat" (chat + equipe) × pessoas do chat com marcação encontrada no Klingo, 03 a 16/11 | Chat diz **114**; o Klingo confirma **82** (76 ainda ativas). **32 (28%) dos "agendados" do chat não têm marcação no Klingo.** O número do chat é o menos fiel. |
| Conversas encerradas como "agendado" | 92 conversas, mas só 55 têm pedido com status "agendado"; 10 pedidos "agendado" não têm marcação no Klingo. |
| Origem das marcações novas no Klingo (03 a 16/11, 3.993) | WhatsApp 46%, Telefone 26%, sem origem 24%, Recepção 5%, Webchat 1 (0,03%). Só 135 (3%) vêm de conversa do chat. O site é uma parte pequena da agenda. |

Conclusão: **a agenda da clínica vem do Klingo**; o chat só entra como "quanto do que a clínica marca começou no site", e o número do chat sempre aparece ao lado da prova do Klingo.

## 2. Dado de teste
- 53 de 448 conversas são de teste (marcadas pelo banco: contato de teste ou atendida por conta de teste). Ficam **fora por padrão** em todos os blocos; só o administrador pode marcar "Incluir conversas de teste".
- As marcações do Klingo ligadas a conversa de teste também ficam fora (`teste_m` em `ind_agenda_periodo`; mesma regra de `ind_clinica_periodo`).

## 3. Contas conferidas
- Soma de `jornada_exame` por dia (03 a 13/11) = 2.035 atendidos, igual à soma da consulta direta; `agendados = cancelados + remarcados + ficaram` fecha em todas as linhas (ex.: 3.404 = 457 + 461 + 2.486).
- Falta: 450 de 2.485 que já passaram = 18,1% no período 03 a 13/11. Quem **confirmou** faltou **11,8%** (242 de 2.059); quem **não** confirmou faltou **48,8%** (208 de 426). Confirmar adianta e agora aparece na tela.
- Os números do chat (pessoas, funil) continuam como estavam; só foram recolocados na ordem (ver `indicadores-por-unidade.md`).

## 4. Problemas encontrados (e o que mudou)
1. **A aba não mostrava a agenda.** Na versão de 17/11 só havia o uso do site; agendados, confirmados, atendidos e faltas tinham saído da tela. Voltaram, na ordem da história.
2. **Remarcado misturado com cancelado.** O Klingo mostra a marcação trocada de data como "Cancelada" (motivo "Remarcad…"). Há 806 remarcadas e 789 canceladas: contar tudo como cancelamento dobraria a taxa. Agora são duas contagens.
3. **"Confirmaram" ficava invisível no dia passado.** O status da marcação vira atendido/faltou e some o "confirmado". A conta agora usa a situação de confirmação do Klingo, que fica guardada.
4. **Falta falsa.** O Klingo não tem o campo "faltou": é a marcação cuja data passou sem atendimento registrado. Quando a leitura do Klingo ainda não fechou o dia, a marcação ficava "por vir" para sempre. Hoje: **107 marcações de dias passados ainda abertas** (98 de 16/11 aguardando a leitura da noite, 8 de 14/11 e 1 de 05/11, que o Klingo parou de atualizar). Aparecem à parte ("Klingo ainda não fechou"), nunca como falta nem como atendido.
5. **Chegada (check-in) só existe desde 16/11/2026.** Antes disso o campo vem vazio (2.038 check-ins no Klingo, mas só os de 16/11 em diante estão no banco). Por isso "vieram" = atendidos, e a chegada só aparece em "Hoje". A tela avisa a data.
6. **Gráfico mês a mês enganava.** O sistema só tem dados desde 29/10, então 4 dos 6 meses eram zero. Trocado por **gráficos por dia**: colunas empilhadas (atendidos, faltaram, cancelados e remarcados, sem desfecho) e área do chat por dia.
7. **Comparação com o período anterior** só aparece quando o período anterior tem dado (dados do Klingo começam em 30/10); senão escreve "sem período anterior com dados".
8. Unidades do Klingo (`CSI 1`, `CSI 2`, `CSI Pediatria`) viram CSI, CSI RM/TC e Desenvoar por `unidade_chave` (CSI 2 = RM/TC, Pediatria = Desenvoar). Mantido.

## 5. Limites que continuam (dito na própria tela)
- Dados do Klingo no sistema começam em 30/10/2026; períodos antes disso ficam abaixo do real.
- "Faltou" é regra do sistema (teto): se a recepção atende e não registra, conta como falta.
- Sem hora real de atendimento (só "Atendido" S/N). O relatório de hora real (`docs/klingo-relatorios-pendentes.md`) continua pendente do dono e **não** é necessário para estes indicadores.

## 6. Como ficou a aba (ordem)
1. Cinco números do período (agendados, atendidos, faltaram, cancelados e remarcados, confirmaram), com seta contra o período anterior.
2. **Hoje e próximos dias** (para o dia a dia): marcados, confirmados, já chegaram, já atendidos, e quanto falta confirmar nos próximos 3 dias.
3. A história das marcações (barras) + "Confirmar adianta?" + por onde as marcações novas entram.
4. Dia a dia (gráfico e tabela).
5. Consultas, exames e unidades.
6. Por atendente (só quem a pessoa pode ver).
7. O chat do site (como antes, mais o gráfico por dia e "Com marcação no Klingo").
