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
