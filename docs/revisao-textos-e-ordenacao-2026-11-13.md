# Como as pessoas se comunicam, revisão dos textos automáticos e ordenação das opções (13/11/2026)

Continuação de `analise-conversas-2026-11-13.md`. Mesma regra: só contagens, nenhum texto de paciente, nenhum nome. Conversas de teste ficaram de fora. Base: 302 conversas, 5 dias úteis. **É pouca coisa; tudo abaixo é "indício forte", não prova.**

## 1. Estatísticas de comunicação

| Medida | Valor |
|---|---|
| Conversas em que o paciente apertou "Quero falar com um atendente" | **81 de 299 (27%)** |
| Onde ele aperta (passo anterior) | horário 27 · consulta 15 · motivo 9 · médico 8 · identificação 6 · plano 5 · confirmar 4 |
| Perguntas do chat que o paciente deixou **sem resposta** | horário **11,9%** · identificação 4,2% · os demais 0 a 2,5% |
| Respondeu clicando num botão | motivo 95% · plano 88% · médico 88% · confirmar 89% |
| Respondeu digitando outra coisa | plano 10% (25 de 256) · médico 11% · confirmar 10% |

**Funil por passo (conversas que viram a pergunta):** motivo 294 → consulta 263 → plano 232 → horário 222 → identificação 135 → contato 115 → confirmar 99 → carteirinha 80.
A maior queda está **logo depois do horário**: de 222 para 135 conversas (−39%). O horário também é o passo onde mais gente pede atendente (27) e onde mais deixam sem resposta (11,9%).

**Jeito de escrever:** quem usa botão escreve ~15 caracteres; quem usa campo livre, ~63; quem fala com atendente, ~26, e costuma mandar a ideia **em pedaços** (389 mensagens seguidas do mesmo paciente). Isto importa para IA: ela precisa juntar mensagens seguidas antes de responder.

## 2. Revisão dos textos automáticos (`fluxo_texto`)

O que está bom: frases curtas, tom acolhedor, sempre diz quem confirma (atendente) e que o valor é previsão.

O que melhorar (do mais importante ao menos):

1. **Passo do horário (`horario`)**: "Agora escolha o dia e o horário que preferir. É uma previsão: o atendente confirma." É o ponto de maior perda. Sugestões: dizer **quantos horários há** e **o mais próximo** já na frase ("O primeiro horário livre é … Quer ver outros?"), e tirar a palavra "previsão" daqui, que confunde. Deixar o botão "Nenhum horário serve" como está, mas com texto de saída melhor: "Sem problema, o atendente procura outro horário e te chama aqui."
2. **`pronto_online` e `pronto_offline`**: 380 a 440 caracteres e repetem "PREVISÃO" e "atendente (uma pessoa)". O paciente lê em 10 s. Sugestão de ~180 caracteres: "Pronto, {nome}! Recebemos seu pedido. Ainda não está confirmado: um atendente confere e te manda aqui a data, o horário e o valor." (A versão offline só troca a segunda frase.)
3. **`confirmar`**: o botão "Está tudo certo" leva 82% dos cliques, e as 4 opções "Corrigir…" juntas são 5%. Sugestão: manter o resumo, deixar **um** botão "Corrigir algo" que abre as quatro, para a tela ficar limpa.
4. **`nao_entendi`**: "Desculpe, não consegui entender. Vou avisar um atendente…" já chama a pessoa. Como 27% já pedem atendente, vale oferecer **antes** uma segunda chance com os botões do passo atual.
5. **`atendente`**: "Atendente (uma pessoa)" aparece em 8 textos. Padronizar uma forma só ("um atendente da equipe").
6. **Textos das atendentes**: elas repetem as mesmas 10 frases à mão (abertura, "Qual o convênio?", "Tem preferência de turno?", retomada de quem sumiu). Viram **respostas rápidas** prontas; a retomada de quem sumiu (27 vezes) pode sair automática.
7. **`resultado_orientacao`**: tem dois links com data de corte fixa (31/08 e 01/09/2026). Só 3 pacientes perguntaram; manter, mas revisar quando o portal antigo sair.

## 3. Ordenação das opções: modelo e comparação

Hoje a ordem das opções é fixa e **não segue o que o paciente escolhe**:

| Passo | Ordem de hoje | Problema |
|---|---|---|
| Motivo | Exame, Consulta, Outro assunto | Consulta recebe **93%** dos cliques e está em 2º; Exame só 3% e está em 1º |
| Plano | "Particular" primeiro, depois por **quantidade de planos no catálogo** | Particular tem só 5% dos cliques; SulAmérica (54) está em 2º, Bradesco (48) em 4º, Central Unimed (33) em 6º, Hapvida em 13º, Planserv em 27º |
| Médico | "Tanto faz", depois ordem alfabética | Alfabética não tem relação com a escolha |
| Assunto | Remarcar, Cancelar, Resultado, Dúvida, Reclamação, Outro | "Outro assunto" (último) foi o mais escolhido (5 de 9) |
| Confirmar | "Está tudo certo" primeiro | Já está certo (86 de 105 cliques) |

### Modelos comparados

- **A. Atual** (fixo/catálogo/alfabético).
- **B. Popularidade simples**: ordena pelo número de cliques.
- **C. Popularidade suavizada** (recomendada): nota = (cliques + 1) / (vezes mostrada + 20). Isso impede que uma opção com 2 cliques em 2 exibições passe na frente de outra com 50 em 200. Itens novos entram no meio da lista, não no fim.

### Resultado (posição média do botão que o paciente clicou; quanto menor, melhor)

| Passo | Cliques | A. Atual | B. Popularidade | Ganho |
|---|---|---|---|---|
| Motivo | 284 | 2,00 | 1,10 | −45% |
| Plano | 225 | 5,63 | 3,81 | −32% |
| Assunto | 9 | 3,78 | 1,44 | amostra pequena demais |
| Médico | 154 | 3,73 | 4,32 | **pior** (ver abaixo) |

**Teste honesto (treina até 10/11, testa em 11 e 12/11, só plano):** posição média 5,09 → **3,66**; a opção certa dentro das 5 primeiras passou de 75% para 79%. O ganho se mantém fora da amostra.

**Médico: não reordenar por popularidade ainda.** Cada consulta tem uma lista diferente de médicos, 154 cliques espalhados em dezenas de listas dão ruído, e ordenar por popularidade **empurra mais gente para o mesmo médico** (carga desigual na agenda). Manter "Tanto faz" em 1º (29% dos cliques) e a ordem alfabética, ou ordenar pela **agenda mais próxima livre**, que serve melhor ao paciente e à clínica.

### Regras de segurança para qualquer ordenação automática
1. Janela dos **últimos 30 dias**, recalculada à noite.
2. **Itens fixos** onde a ordem tem sentido de negócio ("Está tudo certo", "Tanto faz").
3. Mínimo de **30 exibições** na lista antes de usar a popularidade; abaixo disso, ordem de hoje.
4. Nunca esconder opção, só reordenar. A caixa de busca de plano continua.
5. Medir de novo depois: posição média e % de cliques entre as 5 primeiras.

## 4. Como melhorar o jeito de a IA agir com esses dados

O chat de hoje **não tem IA**; é um motor de regras. Há dois lugares onde a IA ajudaria e os dados já sustentam:

1. **Entender o texto livre quando o botão não serve** (10% no plano, 11% no médico, 12% fora dos botões em geral). Em vez de cair em "não entendi", a IA lê a frase, escolhe o botão provável e **pergunta de volta** ("Você quis dizer Bradesco Saúde?"). Dá para treinar com os pares "pergunta do chat → texto digitado → botão que a equipe acabou usando".
2. **Juntar mensagens em pedaços** antes de decidir (389 casos).
3. **Prever quem vai sumir no horário** (11,9% sem resposta) e oferecer ajuda antes: o sinal é estar no passo horário há mais de ~60 s sem clique (o paciente costuma responder em 10 s; o percentil 90 é 63 s).
4. **Sugerir ao atendente** a próxima frase (já são 10 frases repetidas) e **resumir** a conversa quando ele entra.
5. **Limites**: a IA nunca confirma data, horário ou valor, não dá orientação médica (já existe o texto `clinico`), e fala sempre "um atendente confirma". Nada de enviar texto de paciente a serviço externo sem anonimizar e sem revisão jurídica.

## 5. O que fazer e em que ordem

1. Reordenar **motivo, plano e assunto** por popularidade suavizada (migração nova em `fluxo_perguntar`, com teste no clone, `VERSAO_APP` não muda porque é só banco).
2. Reescrever os textos `horario`, `pronto_online/offline`, `confirmar` (migração em `fluxo_texto`).
3. Pôr respostas rápidas para as atendentes.
4. Medir 1 semana depois: cliques entre as 5 primeiras, pedidos de atendente no horário, queda depois do horário.
5. Só depois pensar em IA para texto livre.

*Dados de 13/11/2026; mudam todo dia.*
