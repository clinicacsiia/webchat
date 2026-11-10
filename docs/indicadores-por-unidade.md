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

## Jornada do paciente na clínica (10/11/2026)

A tabela **Por dia** da aba Indicadores agora segue a jornada, da esquerda para a direita: **No chat** (Conversas, Pessoas, Conversas por pessoa, Finalizadas, Pedidos completos, Agendados pelo chat) e **Na clínica** (Marcados, Confirmaram, Atendidos, Faltaram, Cancelaram ou remarcaram, Sem desfecho). Acima da tabela há um bloco de cartões "Na clínica: do agendamento ao atendimento" com as porcentagens.

- **Fonte:** `jornada_exame` e `jornada_card`, lidos do Klingo pelo relatório **#14359** (filtro por data do exame). Nenhum relatório novo foi preciso. Só números: nenhum dado de paciente sai.
- **Dia da clínica = dia do exame** (e não o dia da conversa). Não dá para ligar cada conversa ao exame do Klingo (hoje só 100 cartões têm conversa e nenhum com exame do Klingo), então os dois lados da mesma linha podem ser de pessoas diferentes. A tabela inclui pacientes que nunca passaram pelo chat.
- **Paciente** = um cartão da Jornada (paciente + dia + unidade): quem tem 2 exames no mesmo dia conta uma vez.
- **Desfecho do dia:** atendido (algum exame feito) > faltou > sem desfecho (ainda agendado/confirmado: hoje é "ainda por vir"; em dia passado é "o Klingo não registrou") > remarcou > cancelou.
- **Confirmaram** = algum exame com confirmação "Confirmado" no Klingo, entre quem não terminou cancelado nem remarcado.
- Filtro de unidade do topo vale (cartão sem unidade conhecida aparece em todas). Dias futuros não entram. O histórico do Klingo no painel começa em 30/10/2026.
- Conferido ao vivo em 10/11/2026 (transação desfeita): 09/11 = 383 marcados, 249 confirmaram, 254 atendidos, 55 faltaram, 32 cancelaram, 42 remarcaram (254+55+32+42 = 383).

Banco: `supabase/indicadores-jornada.sql` (aplicado em 10/11/2026; só `create or replace` da função `painel_indicadores_jornada(p_dias, p_unidade)`). Se não estiver aplicado, o painel mostra só o lado do chat, sem erro. ROLLBACK: `drop function public.painel_indicadores_jornada(integer, text);`.

Teste: `cd testes && npm run test:indicadores` (agora 9 verificações: ordem das colunas, totais, dia só da clínica, filtro de unidade e queda sem o SQL).
