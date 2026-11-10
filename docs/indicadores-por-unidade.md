# Indicadores por unidade e por pessoa (09/11/2026)

Por que os números pareciam divergir (09/11/2026): o cartão do topo contava **pessoas** (juntando conversas da mesma pessoa) e obedecia o filtro de unidade; a aba Indicadores contava **conversas** e ignorava o filtro. Agora tudo usa a mesma conta.

## Regras (iguais no topo e em Indicadores)

- **Conversa** = cada conversa aberta no chat. **Pessoa** = conversas da mesma pessoa juntas (mesma regra da lista do Atendimento, tabela `conversa_grupo`).
- **Conversas por pessoa** = conversas ÷ pessoas.
- **Encerradas hoje / Finalizadas** = das conversas que começaram no período, quantas já estão encerradas.
- **Dia** = dia de calendário no fuso de São Paulo. Período "Hoje" = hoje; "7 dias" = hoje e os 6 anteriores.
- **Filtro de unidade do topo** vale nos cartões e em toda a aba Indicadores (pedidos, horários, motivos de encerramento e avaliações). Unidade da pessoa: 1) pedido já agendado e aberto; 2) cartão da Jornada; 3) unidade escolhida no formulário do chat. Sem nenhuma, a pessoa aparece em **todas** as unidades.

## O que tem a mais na aba Indicadores

Conversas por pessoa (média), pessoas por dia e média por dia, linha de total do período, gráfico de conversas por horário de início, período "Hoje" (agora é o padrão), e motivos de encerramento e avaliações já filtrados.

## Banco

`supabase/indicadores-unidade.sql` (aplicado em 09/11/2026 em duas migrações, só `create or replace`): `painel_conversa_pessoa_un()` (interna), `painel_indicadores_unidade(p_dias, p_unidade)` e `painel_indicadores(p_dias)` (continua valendo, sem filtro). Se o SQL não estiver aplicado, o painel cai no resumo antigo e avisa "Clínica toda".

Conferido ao vivo contra a consulta direta: 64 conversas, 51 pessoas e 27 encerradas hoje.

## Teste

`cd testes && npm run test:indicadores` (5 verificações: cartões, filtro de unidade, aba Indicadores, período padrão e queda para o resumo antigo).

## Jornada na clínica de quem veio do chat (10/11/2026)

A tabela **Por dia** da aba Indicadores segue a jornada, da esquerda para a direita: **No chat** (Conversas, Pessoas, Conversas por pessoa, Finalizadas, Pedidos completos, Agendados pelo chat) e **Na clínica, só de quem veio do chat** (Pessoas novas no chat, Marcaram, Confirmaram, Atendidos, Faltaram, Cancelaram ou remarcaram, Ainda por vir). Acima da tabela há cartões com as porcentagens.

- **Só entra quem veio do chat.** Quem marcou direto no Klingo fica de fora (decisão do dono em 10/11/2026).
- **Histórico da pessoa.** A linha é o dia do **primeiro contato** da pessoa no chat. O lado da clínica acompanha tudo o que ela fez no Klingo **depois** desse contato, em qualquer data (inclusive dias seguintes e datas futuras). Por isso os números de dias recentes ainda crescem. Exame marcado antes de a pessoa falar no chat não entra.
- **Ligação chat → Klingo:** mesmo telefone (marca de 8 últimos dígitos + segredo, a de `jornada_paciente.fone_chave`) **e** nome que confere (`nome_confere`); ou marcação reconhecida pelo chat (`pre_agendamentos.klingo_marcacoes`). Quem deu telefone ou nome diferente no Klingo conta em "pessoas novas", mas não em "marcaram": os números de "marcaram" são o **mínimo** garantido.
- **Cada coluna é "a pessoa teve pelo menos um exame assim"**, então a mesma pessoa pode aparecer em mais de uma (ex.: faltou numa data e foi atendida em outra). Confirmaram = algum exame confirmado que não foi cancelado nem remarcado. Ainda por vir = exame futuro ou que o Klingo não atualizou.
- Filtro de unidade do topo vale (mesma regra de unidade da pessoa). Pedidos do chat sem marcação no Klingo (status `pedido`) não contam como marcação.
- **Números reais em 10/11/2026** (transação desfeita): 105 pessoas novas no chat, 23 marcaram, 4 confirmaram, 3 atendidas, 0 faltaram, 1 cancelou/remarcou, 20 ainda por vir. São poucos porque o chat é novo (primeira conversa em 29/10) e só 98 contatos têm telefone.
- Fonte: `jornada_exame`/`jornada_card` (Klingo, relatório #14359). Nenhum relatório novo foi preciso. Só números: nenhum dado de paciente sai.

Banco: `supabase/indicadores-jornada.sql` (aplicado em 10/11/2026; só `create or replace` da função `painel_indicadores_jornada(p_dias, p_unidade)`). Se não estiver aplicado, o painel mostra só o lado do chat, sem erro. ROLLBACK: `drop function public.painel_indicadores_jornada(integer, text);`.

Teste: `cd testes && npm run test:indicadores` (9 verificações: ordem das colunas, totais, filtro de unidade e queda sem o SQL).
