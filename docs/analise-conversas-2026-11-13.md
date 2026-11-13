# Análise das conversas do chat (13/11/2026)

Feita para preparar o treino de um chatbot que siga o jeito do paciente conversar e ajude a **prever pedidos**.

**Como foi feita:** só consultas agregadas (contagens, tempos, frases que se repetem 6 vezes ou mais). Nenhuma conversa foi lida inteira e nenhum dado pessoal entra neste relatório. Conversas de teste (`teste = true`) ficaram de fora. Fonte: tabelas `mensagens`, `conversas`, `pre_agendamentos`, `pre_agendamento_itens`.

## 1. O tamanho real da base (o ponto mais importante)

| Item | Valor |
|---|---|
| Período com dados | 29/10 a 12/11/2026, mas **quase tudo vem de 06/11 e de 09 a 12/11** (5 dias úteis) |
| Conversas (sem teste) | **302** |
| Mensagens | **6.709** (paciente 2.769 · motor do chat 2.165 · atendente humano 1.142 · sistema 633) |
| Conversas com ao menos 1 atendente humano | 275 (87%) |

**Conclusão:** é pouco para treinar um modelo do zero ou ajustar (fine-tune) um modelo de verdade, e é uma semana só, então não dá para ver sazonalidade (mês, feriado, volta às aulas). Serve muito bem para: (a) entender o padrão, (b) montar exemplos de conversa para um assistente que consulta o histórico, (c) uma previsão simples de volume. Veja a seção 8.

## 2. Perfil da clínica nos dados

- É a unidade **Desenvoar (núcleo pediátrico)**: 141 pedidos na Desenvoar, 10 na CSI, 100 sem unidade.
- **98% dos pedidos são consulta** (247 consultas contra 4 exames). O chat hoje é, na prática, um agendador de consultas pediátricas.
- Especialidades mais pedidas (pelas mensagens "Pedido de consulta"): **Pediatria 131 · Neuropediatria 54 · Ortopediatria 30 · Endocrinopediatria 15 · Gastropediatria 7**.

## 3. Quando as pessoas escrevem

- Horário (Brasília): começa às 7h, pico às **10h** (444 mensagens, 78 conversas), segundo pico ao meio-dia (303), depois cai: 17h = 110, 18h = 57, depois das 19h quase nada.
- 95% das mensagens do paciente ficam entre **7h e 17h59**. Fora disso são casos isolados.
- Conversas novas por dia útil: **31 (sex 06/11), 79 (seg), 54 (ter), 58 (qua), 75 (qui)**. Média de uns 60 a 70 por dia útil.
- Sábado quase não tem conversa nova e **nenhuma mensagem de paciente**. (Cuidado: a conta por dia da semana tem só uma semana de dados.)

## 4. Como o paciente escreve

**Mensagens curtas.** Média de 36 caracteres (atendente humano 76, motor 105). O paciente responde ao motor em **10 segundos** (mediana; 90% em até 63 s).

**O que o paciente responde a cada tipo de pergunta do chat:**

| Responde a | Mensagens | Tamanho médio |
|---|---|---|
| Botões de escolha | 798 | 15 caracteres |
| Atendente humano | 508 | 26 |
| Outra mensagem dele mesmo (escreve em pedaços) | 389 | 29 |
| Campos (nome, carteirinha etc.) | 349 | 63 |
| Pedido de consulta | 265 | 44 |
| Calendário | 164 | 101 |

**Tipos de mensagem do paciente (classificação por palavras-chave, 2.771 mensagens):**

| Tipo | Mensagens | Conversas |
|---|---|---|
| Consulta / médico | 726 | 280 |
| Convênio / plano | 315 | 221 |
| Data / horário | 327 | 192 |
| Saudação (oi, bom dia) | 89 | 69 |
| Agradecimento | 76 | 67 |
| Resposta curta (sim, não, ok) | 87 | 60 |
| Preço / particular | 39 | 29 |
| Exame | 20 | 14 |
| Cancelar / remarcar | 19 | 14 |
| Só números (CPF, data, telefone) | 12 | 12 |
| Resultado / laudo | 3 | 3 |
| Outros (nomes, textos soltos, fotos) | 958 | 255 |

**Frases que mais se repetem** (quase todas vêm dos botões do chat, por isso são idênticas):

- "Consulta" (265) · "Está tudo certo" (86) · **"Quero falar com um atendente"** (81) · "Tanto faz (qualquer médico)" (45) · "Prefiro deixar para depois" (27) · "Particular (sem convênio)" (14) · "Nenhum horário serve para mim" (9) · "Outro assunto" (14).
- Convênios digitados: **SulAmérica 56 · Bradesco Saúde 50 · Central Nacional Unimed 33 · Unimed Seguros 22 · Amil 20 · Hapvida 9 · Planserv 7**.
- Texto livre típico: "oi", "bom dia", "obrigada", "ok", "sim", "?", "enviado", "foto enviada", "carteirinha: número / validade: data".
- Quem escreve livre costuma mandar **nome completo** da criança ou do responsável sozinho na mensagem. Isso é dado pessoal e **não pode entrar no treino sem tirar**.

## 5. Como a equipe responde (o "jeito da casa")

Frases fixas que os atendentes repetem (6 vezes ou mais):

- Abertura: "Olá! Seja bem-vindo(a) à Desenvoar Núcleo Pediátrico 💚 Meu nome é … e será um prazer ajudar você. Como posso te ajudar hoje?" (várias versões, ~80 vezes no total).
- Pergunta de triagem: "Já é paciente da neuropediatra ou será primeira vez?" · "Qual o convênio?" · "Tem preferência de turno?".
- Fechamento: "Disponha." / "Disponha :)" (45) · "Marcado." (13) · "Prontinho! Seu agendamento foi concluído 😊 Agradecemos o contato e a confiança em nossa equipe. Até breve!" (11).
- Retomada de quem sumiu: "Estamos finalizando o nosso atendimento por enquanto, pois não tivemos retorno…" (27 variações somadas).
- Cutucada curta: "Olá?" (14), "?" (14).

Tom: educado, com emoji 💚, tratamento por "você", frases curtas, sempre se apresentando pelo primeiro nome.

**Tempos:** o motor responde na hora (0 s). O **atendente humano leva 1,7 min (mediana)**, mas **90% das respostas saem em até 16 min**, e há cauda longa.

## 6. Onde a conversa termina (funil)

| Etapa | Resultado |
|---|---|
| Conversas | 302 |
| Passaram a `humano` (pediram atendente ou o motor passou) | 87 (29%) |
| Pedido criado | 251 |
| Pedido ficou em rascunho (paciente parou no meio) | 134 (**53%** dos pedidos) |
| Pedido pronto para a equipe | 49 (19%) |
| Pedido agendado | 67 (27%) |
| Marcações reconhecidas automaticamente | 63 |

Motivos de encerramento: **não respondido 86**, agendado 81, apenas informações 36, outro 4, desistiu 3, nova conversa 2, ainda abertas ou sem motivo 90.

Passos onde as conversas abertas estão paradas: horário (60), dados de identificação (14), carteirinha (10), consulta (10), plano (7), confirmar (7), motivo (6), médico (6).

**Leitura:** o maior vazamento é **parar antes de terminar o pedido** (metade dos pedidos) e **sumir sem responder** (86 conversas, 28%). O passo do **horário** concentra mais conversas paradas, e 9 pacientes disseram que nenhum horário servia.

## 7. Planos mais pedidos (pedidos de consulta)

SulAmérica 50 · Bradesco Saúde 46 · Central Nacional Unimed 30 · Unimed Seguros 23 · Amil 19 · Particular 12 · Hapvida 8 · Petrobras 4 · Planserv 4 (+ Planserv escrito de outro jeito) · sem plano informado 31. Os nomes aparecem escritos de várias formas (maiúscula, minúscula, abreviação), então o treino precisa de uma lista de nomes normalizados.

## 8. O que dá para treinar e como "prever pedidos"

### O que a base sustenta hoje
1. **Classificador de intenção** (consulta, convênio, horário, preço, cancelar, atendente, saudação, agradecimento): viável. Já existe rótulo implícito: a pergunta do motor (`opcoes.tipo`) diz a que o paciente respondeu.
2. **Assistente que sugere resposta ao atendente** usando as frases acima como exemplos (poucos exemplos no prompt, sem treinar modelo): viável e o caminho mais barato.
3. **Previsão de volume** (quantas conversas por hora e por dia, quantas viram agendamento): viável só como **média por dia útil e hora**, sem sazonalidade. Referência atual: 55 a 80 conversas novas por dia útil, pico 10h, ~20% viram agendamento no mesmo dia.
4. **Previsão de abandono** (quem vai parar no meio): viável de forma simples, usando passo atual, hora do dia e se pediu atendente.

### O que ainda não dá
- Modelo próprio ou ajuste fino de linguagem: **poucos dados** (6,7 mil mensagens, 1 semana, 1 clínica, 98% consultas).
- Prever **exames**: só 4 pedidos.
- Prever **sazonalidade**: precisa de pelo menos 2 a 3 meses, melhor 12.

### Formato recomendado dos exemplos de treino
Uma linha por turno: `conversa_anonima`, `ordem`, `quem`, `passo_do_fluxo`, `tipo_da_pergunta`, `texto_limpo`, `hora`, `dia_da_semana`, `desfecho_da_conversa` (agendado / não respondido / informação). A exportação deve ser **feita por uma função no banco** que já troque nome, CPF, telefone, e-mail, carteirinha, data de nascimento e nome de criança por marcadores (`[NOME]`, `[CPF]`, `[CARTEIRINHA]`…).

## 9. Cuidados antes de usar texto de paciente no treino

1. **LGPD:** são dados de saúde de crianças. Usar a conversa para treino precisa estar na política de privacidade (hoje em rascunho, `privacidade.html`) e ter base legal. Isso depende de revisão jurídica.
2. **Anonimização obrigatória** antes de sair do banco. Nesta análise já apareceram nomes completos de pessoas repetidos, então a limpeza por regras precisa de revisão por amostra.
3. **Não enviar a base crua** para serviço externo de IA sem acordo.
4. O texto da conversa **não deve ser lido na produção por rotina**: a regra do projeto continua valendo. Esta análise usou apenas contagens.

## 10. Próximos passos sugeridos

1. Você decidir se autoriza criar a **função de exportação anonimizada** (migração nova, com teste no clone, como manda o `CLAUDE.md`).
2. Deixar o chat **acumulando** pelo menos 2 meses antes de tentar previsão com sazonalidade.
3. Começar por duas coisas baratas: **sugestão de resposta para o atendente** e **painel de previsão de volume por hora**.
4. Corrigir o funil: rascunhos parados (53%) e "não respondido" (28%) são onde mais se perde pedido.

*Os números vêm de consultas feitas em 13/11/2026 e mudam todo dia.*
