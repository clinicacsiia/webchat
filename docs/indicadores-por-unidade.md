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

## Filtro "Ontem" (10/11/2026)

O filtro de período da aba Indicadores ganhou **Ontem** (entre Hoje e Últimos 7 dias). No banco ele é `p_dias = -1`: do começo de ontem até o começo de hoje, no fuso de São Paulo, nas funções `painel_indicadores_unidade` e `painel_indicadores_jornada` (aplicado em 10/11/2026; só `create or replace`, ver `supabase/indicadores-unidade.sql` e `supabase/indicadores-jornada.sql`). Conferido ao vivo: ontem (09/11) = 83 conversas, 67 pessoas, 54 finalizadas, 27 pedidos completos e 13 agendados, igual à linha daquele dia na tabela "Por dia". Os cartões do topo continuam sendo de hoje. Sem o SQL novo, escolher "Ontem" mostra um aviso em vez de números errados.

## Aba Indicadores refeita para decidir (11/11/2026)

A aba deixou de ser uma lista de KPIs e virou 3 blocos, sempre comparando com o período anterior de mesmo tamanho (setas verde/vermelha):

1. **O que chama atenção:** até 7 frases escritas por regra a partir dos números (taxa de agendamento, maior perda do funil, pessoas nunca respondidas, queda de marcações, taxa de falta, grupos que mais faltam).
2. **Por que não estão agendando?** Caminho do paciente no chat (procuraram → começaram pedido → escolha de data → horário → pedido pronto → agendaram, com a maior perda marcada), onde pararam e por que a conversa terminou sem agendar.
3. **Por que faltam e cancelam?** (Klingo, toda a clínica, pela data do exame) faltas por confirmação, antecedência, unidade e convênio/particular, e motivos dos cancelamentos (texto livre da recepção, classificação aproximada).

Saíram da tela: tabela Por dia, reentradas, transferências, concluídas atravessando meia-noite, motivos de encerramento, gráfico por horário e avaliações. O banco continua com as funções antigas (`painel_indicadores_v2` etc.).

Banco: `supabase/indicadores-decisao.sql` (aplicado em 11/11/2026; só `create or replace`): `painel_indicadores_decisao(p_de, p_ate, p_unidade, p_incluir_teste)` e a interna `ind_decisao_periodo`. ROLLBACK: ver o cabeçalho do arquivo. Nenhum relatório novo do Klingo foi preciso (usa `jornada_exame`, relatório #14359).
Teste: `cd testes && npm run test:indicadores` (16 verificações).
Atenção: o id da marcação no Klingo tem "m" na frente (`m22544`), diferente do guardado em `pre_agendamentos.klingo_marcacoes` (`22544`).

### Equipe e avaliações na aba Indicadores (11/11/2026)
- **3. Equipe:** três gráficos de barras por atendente: conversas atendidas (escreveu no período), agendamentos feitos (só os que a pessoa marcou como agendado; o que o sistema confirma sozinho não tem dono) e nota média do atendimento (avaliação dada à pessoa que mais escreveu na conversa; menos de 5 avaliações = "poucas"). Quem vê quem segue `painel_indicadores_equipe`: TI e gerência veem todos, supervisão a própria equipe, atendente só a si.
- **4. Avaliações dos pacientes** (só administrador): total, nota do atendimento, nota do site e canal de origem. Voltaram a pedido do dono.
- Banco: `supabase/indicadores-atendentes.sql` (aplicado em 11/11/2026; `painel_indicadores_atendentes`; ROLLBACK no cabeçalho). Sem ele a seção avisa qual arquivo rodar.
- Teste: `npm run test:indicadores` (19 verificações).
- **Quem respondeu primeiro (11/11/2026):** sem registro novo: a primeira mensagem de atendente de cada conversa abre o "primeiro a responder" (vale também para o histórico). A aba mostra, por atendente, quantas conversas respondeu primeiro e a **mediana de minutos** até essa resposta (verde = mais rápido, vermelho > 30 min). Conversas contadas pelo dia em que abriram. Mesmo arquivo `supabase/indicadores-atendentes.sql` (reaplicado).

> Publicação (11/11/2026): a publicação do GitHub Pages do PR #142 travou na fila sem iniciar (0 etapas) e não pôde ser cancelada. Este commit só de documentação existe para gerar uma publicação nova, como em 09/11/2026 (#110 e #111 travaram e o merge seguinte, #112, publicou).


## Aba Indicadores enxugada: uso do site (17/11/2026)

A aba ficou curta e operacional. Só mostra o que o site (chat) produz, com o Klingo como referência. **Saíram:** o veredito "Bom / Atenção / Ruim" e as faixas coloridas, os textos "por quê" e "o que fazer", a equipe por atendente, as avaliações, a conferência Klingo × webchat, a clínica toda (faltas, cancelamentos) e o gráfico mensal. Os dados continuam no banco; é só tela.

Ordem da página:

1. **Resumo (5 números, com seta neutra contra o período anterior):** pessoas que procuraram o chat, começaram um pedido, agendaram pelo chat, marcações do site no Klingo (e que parte das marcações novas da clínica isso é) e tempo mediano da 1ª resposta da equipe.
2. **Onde as pessoas param:** caminho do paciente no chat (com a maior queda marcada), último passo de quem não agendou e como a conversa terminou sem agendar. "Caminho separado por consulta e exame" fica recolhido.
3. **Onde o site mais é usado:** por unidade, mais pedidos e planos (destaca em vermelho só quem tem 8+ pessoas e menos de 15% agendando).
4. **Comparação com o Klingo:** marcações novas da clínica toda × as que vieram do site (consultas, exames, total e a parte do site) e o que aconteceu com as do site (ativas, remarcadas, canceladas; atendidas, faltaram, por vir).
5. **Autoatendimento:** tentativas do chat de marcar sozinho, marcadas, foram para a equipe, horário ocupado, resolvidas sem atendente, tempo médio e cancelar/remarcar pelo chat.

Banco: nada mudou. A tela chama só `painel_indicadores_decisao`, `painel_indicadores_plataforma`, `painel_indicadores_diretoria` e `painel_automacao_resumo`. Nenhum relatório novo do Klingo é necessário. Painel `sw.js` v50. Teste: `cd testes && npm run test:indicadores` (22 verificações).

### Gráfico mês a mês (17/11/2026)
Logo abaixo do resumo há um gráfico de área dos últimos 6 meses (SVG puro com `linearGradient` e `path`, sem biblioteca). Mostra "Pessoas que procuraram o chat" ou "Agendaram pelo chat" (botões), o total dos 6 meses e o melhor mês, tudo calculado do array `dados`; passar o mouse (ou tocar) num mês mostra o valor exato. O último mês é parcial e a dica avisa. Sem mudança no banco: a tela faz uma consulta a `painel_indicadores_decisao` por mês, em paralelo, e o filtro de unidade do topo vale. Painel `sw.js` v53. Teste: `npm run test:indicadores` (25 verificações).

### Evolução a cada 30 dias (17/11/2026, troca o gráfico mês a mês)
O gráfico de 6 meses do calendário foi trocado por **blocos de 30 dias contados do 1º dia de uso** (a 1ª conversa real, sem conversas de teste; se não achar, usa 29/10/2026). Barras por bloco: agendadas que seguem valendo, marcadas sozinhas pelo chat, canceladas e remarcadas. A linha é o total de agendamentos do site no bloco (ativas + canceladas + remarcadas). Botões ligam e desligam cada série; passar o mouse mostra o detalhe; uma tabela abaixo traz os números e a variação do total contra o bloco anterior (o bloco em andamento aparece como "em andamento" e não é comparado). "Marcadas sozinhas" vem de `painel_automacao_resumo` (não separa por unidade) e já está dentro das agendadas. Sem mudança no banco: 2 consultas por bloco (`painel_indicadores_plataforma` e `painel_automacao_resumo`). Painel `sw.js` v54.

### Correção de rótulo: "marcada sozinha" (17/11/2026)
Definição do dono: **marcada sozinha = o cliente marcou pela API, no chat, sem ajuda do atendente.** No gráfico de 30 dias a barra verde agora usa `resolvidas_sem_humano` (marcada pela API no chat e ninguém da equipe escreveu na conversa), com o rótulo "Marcadas pelo chat, sem atendente". Antes usava `agendadas_sozinhas` (origem `chat_api`), que aceitava conversa com atendente. No bloco Autoatendimento, as "tentativas" vêm de `klingo_operacao` (tipo `marcar`) e **misturam chat e equipe** (a tabela tem a coluna `origem` com `chat`, `equipe` e `sistema`, mas `painel_automacao_resumo` não filtra); por isso o rótulo agora é "pela API" e o número "marcadas pelo cliente, sem nenhum atendente na conversa" é o que vale para "sozinho". Para separar por origem na contagem de tentativas falta alterar `painel_automacao_resumo` (mudança de banco, ainda não feita). Painel `sw.js` v55.
