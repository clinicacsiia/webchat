# Fase 6: unidade, "quem será atendido", filhos e médico de preferência no início do chat

Data: 30/10/2026. SQL: `supabase/fase6-unidade-e-medico.sql`. Chat: `index.html`. **Banco aplicado no projeto em 30/10/2026** (migrações `fase6_*`). **Falta o n8n** (ver "Mudança no n8n").

## A ideia

O formulário pergunta **primeiro** o que define o caminho, e o resto do atendimento nasce já certo:

1. **Unidade** (antes do nome): Desenvoar, CSI, CSI RM/TC ou "Ainda não sei".
2. **Quem será atendido?** (antes do nome): "Eu mesmo(a)" ou "Meu filho ou filha (sou o responsável)". A Desenvoar já vem com "filho(a)" marcado; as outras vêm com "eu mesmo(a)". Quem mexeu na pergunta não perde a escolha ao trocar de unidade.
3. Nome (ou "Seu nome (responsável)" + "Nome completo da criança" + outros filhos), telefone, e-mail.
4. **Médico de preferência** (depois do e-mail, antes da mensagem): opcional, só aparece se a unidade tem médicos com consulta.

| Caminho | O que muda |
|---|---|
| **Filho(a)** (qualquer unidade) | A IA chama o responsável e a criança **pelo primeiro nome** desde a primeira resposta ("Olá, Maria! Vamos agendar para o Lucas."), registra os dados da CRIANÇA (nome, nascimento, sexo, mãe), usa o celular do responsável, confere a idade da criança e trata emergência pediátrica (192). Um atendimento por criança. |
| **Desenvoar** | Sem mapa do corpo. Motivo em lista; consulta pelo seletor de consulta (abaixo). |
| **CSI** | Se não ficou claro, pergunta "consulta ou exame?". Exame de imagem vai para o mapa do corpo; consulta, para o seletor de consulta. |
| **CSI RM/TC** | Vai direto ao mapa do corpo (só ressonância e tomografia na agenda). |
| **Ainda não sei** | A IA descobre o que ele precisa e **sugere** a unidade (criança: Desenvoar; RM/TC; resto: CSI). |

Os textos ficam nas tabelas `unidade_config` (por unidade) e `atendimento_tipo` (próprio x filho). Para ajustar um atendimento basta editar a tabela, sem mexer no prompt do n8n.

A lista de médicos vem da agenda vigente do Klingo (só quem tem **consulta** na unidade; ficam de fora agenda de teste, "Eletrocardiograma" e anestesiologia). Hoje: Desenvoar 13, CSI 15, RM/TC nenhum (a pergunta não aparece nessa unidade).

## Mais de um filho: um de cada vez ou juntos

No formulário, em "Nome completo da criança", o botão **+ Tenho outro filho(a) para agendar** (até 5 filhos) abre um campo por irmão e a pergunta **Como você prefere agendar?**

| Escolha | O que acontece |
|---|---|
| **Um de cada vez** | Atende o primeiro filho do início ao fim. Depois, a faixa verde acima do campo de mensagem oferece **Agendar para Pedro**: abre a conversa do próximo, sem preencher o formulário de novo, com o pedido do zero. |
| **Os dois juntos** (ou "Todos juntos") | Igual, mas o pedido (consulta ou exames, plano, unidade e médico) é **copiado** para o irmão, e o calendário já abre com o horário **logo depois** do que o irmão anterior escolheu (mesmo dia, mesmo médico quando houver vaga; o responsável pode escolher outro). |

- **Uma conversa por criança.** Cada filho tem o próprio pré-agendamento, os próprios horários, o próprio cadastro e a própria conferência com o Klingo. Dois irmãos no mesmo horário com o mesmo médico não são possíveis; por isso "juntos" é **em sequência** (08:20 e 08:40, por exemplo).
- A conversa do irmão já nasce com "Agora vamos agendar para Pedro, com o mesmo pedido de Lucas." e a IA cumprimenta pelos nomes.
- O clique em "Agendar para Pedro" é idempotente (clique duplo ou recarregar a página não cria duas conversas).
- Quem não informou os irmãos no começo ainda tem, no menu (três pontinhos), **Agendar para outro filho(a)**: formulário com responsável e unidade preenchidos.
- O limite do sistema é de 5 conversas por hora por telefone (quem tem 5 filhos usa todas).
- **Identidade**: com "filho(a)", a conferência de cadastro usa o nome da CRIANÇA + o telefone do responsável. Sem isso, o responsável que já é paciente casaria com o próprio cadastro e a IA reaproveitaria CPF, endereço e nascimento dele no pedido da criança. O pedido pela metade de um irmão nunca é oferecido ao outro. Criança que volta é reconhecida por nome + telefone e confirmada pela data de nascimento.

## Consulta no chat (o que faltava para a Desenvoar agendar)

O pedido só aceitava **exames de imagem**; sem item no pedido o calendário não abria, então nenhuma consulta chegava ao calendário. Agora a IA envia `opcoes {"tipo":"pedido_consulta"}` e o chat abre **Escolher o tipo de consulta** (funções `chat_consultas` e `chat_consulta_salvar`):

- Lista as consultas da unidade com agenda vigente, com o nome que o paciente entende (o cadastro do Klingo tem vários procedimentos chamados só "CONSULTA"): hoje, na Desenvoar, Consulta de Pediatria, Consulta Pediátrica Pré-Natal, Puericultura, Teleconsulta de Pediatria, Ortopediatra, Endocrino, Gastro e Neuropediatria. A "CONSULTA" genérica some quando já existe uma específica para os mesmos médicos.
- As consultas do médico de preferência vêm primeiro ("do seu médico").
- O pedido guarda o **nome exato do Klingo** (é com ele que a conferência automática procura a marcação), e o calendário passa a funcionar para consulta (testado no banco: Desenvoar, puericultura, médica preferida).
- **EEG e outros exames da Desenvoar** ainda não passam pelo calendário (a IA registra o pedido e o atendente agenda); `chat_pedido_salvar` só conhece as 6 modalidades de imagem.

## O que o paciente vê no formulário

1. **Em qual unidade você quer ser atendido?**
2. **Quem será atendido?** (aparece depois de escolher a unidade).
3. Nome, nome da criança (+ outros filhos e "como prefere agendar"), telefone, e-mail.
4. **Tem médico de preferência? (opcional)**, com "Sem preferência" e a especialidade de cada médico.
5. Mensagem e aceite. (Para filho, mensagem em branco vira "Olá! Quero agendar para Lucas." e a IA já responde pelos nomes.)

Se a lista de unidades não carregar, o formulário volta ao comportamento antigo e a IA pergunta a unidade no chat.

No calendário: a unidade escolhida já vem selecionada; o médico filtra os horários (sem vaga, mostra os de outros médicos e avisa; com o filtro ativo há o botão **Ver outros médicos**).

## Preço: a IA não fala; o sistema vigia o atendente (Fase 6b)

- A IA **nunca** informa preço: `ia_catalogo` devolve a lista de preços vazia (ela nem recebe o valor) e o prompt manda dizer que o atendente informa o valor certo na hora de confirmar.
- Os preços continuam no banco (`catalogo_preco`) só como **referência de conferência**.
- Quando um **atendente** (mensagem com autor da equipe; não vale IA nem paciente) escreve um valor no chat ("R$ 1.200,00", "R$180", "300 reais"), o sistema compara com a referência do pedido e do plano. Fora da faixa de referência por **10% ou mais** (ajustável em `config.alerta_preco_tolerancia_pct`), grava um alerta.
- Aceita o valor de um exame, o valor vezes a quantidade, ou a soma de todos os exames do pedido. Só julga quando **todos** os exames do pedido têm preço de confiança alta ou média para o plano informado; sem plano ou sem referência, não alerta (não há como julgar).
- O alerta é **só da equipe**: fica na tabela `alerta_preco` (regra de acesso: administrador e atendente), nada é escrito em `mensagens`, então o paciente nunca vê, nem o marketing nem quem não está logado (testado: `anon` e usuário logado sem papel enxergam 0 linhas).
- No painel: selo vermelho **Conferir valor** na lista e uma faixa na conversa: "Você informou R$ 1.200,00, que está ABAIXO do valor de referência (Particular). Referência: RM ...: R$ 2.350,00", com o botão **Conferi, está certo**.
- Limites: "entrada de R$ 100", parcelas e descontos combinados também disparam o alerta (a atendente marca "Conferi"); o valor do catálogo pode estar defasado (a aba Aprendizado mostra onde diverge do Klingo, e hoje são 18 de 104 pares).
- SQL: `supabase/fase6b-alerta-preco.sql` (independente do `fase6-unidade-e-medico.sql`; aditivo).

## Como aplicar (nesta ordem)

1. **Banco**: rodar `supabase/fase6-unidade-e-medico.sql` e depois `supabase/fase6b-alerta-preco.sql`, inteiros no SQL Editor do projeto `webchat-atendimento`. É aditivo e pode rodar de novo. Foi testado no projeto em transações revertidas (nada ficou gravado), ver "Testes".
2. **Limpeza** (depois do passo 1, uma vez): `drop function public.chat_iniciar(text, text, text, text, boolean, text);` Sem isso, chamadas com 6 argumentos ficam ambíguas com a versão nova. O Supabase pede confirmação humana para `drop`.
3. **n8n**, fluxo `Triagem IA - Atendimento` (abaixo). Sem este passo o banco e o chat já guardam e filtram tudo, mas a IA não lê as instruções (e não sabe abrir o seletor de consulta).
4. **Chat**: merge do PR (GitHub Pages publica o `index.html`). O banco tem de estar atualizado antes.

## Mudança no n8n

**a)** Nó **Triagem com Claude**, mensagem do usuário: logo depois da linha `Origem: ...`, acrescentar:

```
Escolha feita no início do chat (unidade, médico de preferência, quem será atendido, outros filhos; "instrucao" e "instrucao_paciente" são regras da clínica para esta conversa):
{{ JSON.stringify($('Buscar histórico no Supabase').first().json.inicio ?? {}) }}
```

Na mesma mensagem, trocar o rótulo `Paciente:` (que traz `nome`, o de quem escreve) por `Quem escreve no chat:`; para filho, o paciente é a criança e o nome dela vem em `paciente_nome`.

**b)** Prompt de sistema (campo `system`):

1. Em "COMPONENTES DO CHAT", acrescentar o formato: `- {"tipo":"pedido_consulta"} — abre a ESCOLHA DO TIPO DE CONSULTA (pediatria, puericultura, neuropediatria, ginecologia...) com os dados do cadastro da unidade; é o que libera o calendário para consultas.`
2. Na etapa 1 ("pedido"), trocar "Consulta ou outros exames: use uma lista com as especialidades ou exames do catálogo, ou pergunte normalmente." por "Consulta: envie opcoes {\"tipo\":\"pedido_consulta\"} (não use lista de especialidades). Outros exames: pergunte normalmente." O resto do pedido de consulta (nome do procedimento) o chat grava sozinho.
3. Antes de "ETAPAS DO PRÉ-AGENDAMENTO", acrescentar:

```
UNIDADE, QUEM SERÁ ATENDIDO E MÉDICO: em "Escolha feita no início do chat" você recebe a unidade que o paciente escolheu (unidade, unidade_catalogo, fluxo), o médico de preferência (medico_preferido, pode ser nulo), quem será atendido (paciente_tipo "proprio" ou "filho"; paciente_nome é a criança), os outros filhos (irmaos_que_faltam, irmaos_modo, irmao_anterior, pedido_copiado_do_irmao) e duas instruções da clínica: "instrucao" (da unidade) e "instrucao_paciente" (de quem será atendido). Siga as duas; elas valem mais que o roteiro genérico abaixo, exceto nas REGRAS DE SEGURANÇA.
- Se unidade_catalogo vier preenchida, NÃO pergunte a unidade nem ofereça outra, a menos que o paciente peça ou o catálogo mostre que o exame não existe lá. Na primeira vez que enviar pre_agendamento, inclua unidade com o valor exato de unidade_catalogo.
- Se medico_preferido vier preenchido, NÃO pergunte médico: inclua profissional com esse nome exato. Se agenda mostrar que ele não atende o que o paciente pediu, diga isso com delicadeza e ofereça outro da mesma especialidade (só nomes que estejam no catálogo).
- Se fluxo for "indefinido", siga a instrucao para sugerir a unidade antes da etapa preferencias.
- Se paciente_tipo for "filho", quem conversa é o responsável: no campo paciente.nome vai o nome da CRIANÇA e a idade usada para conferir o procedimento é a dela. Em "Situação do paciente" e em "Histórico", o que vale é a criança. Chame sempre o responsável e a criança pelo primeiro nome.
- Se pedido_copiado_do_irmao for true, o pedido já está em pre_agendamento e pedido_itens: confirme em uma frase e siga direto para o calendário (etapa data_hora). O calendário já vem com o horário sugerido logo depois do irmão.
```

**c)** Nó **Ler resposta da IA** (código): na função `componente`, aceitar o novo tipo. Trocar
`if (o.tipo === 'pedido_exames' || o.tipo === 'calendario') return { tipo: o.tipo };` por
`if (o.tipo === 'pedido_exames' || o.tipo === 'pedido_consulta' || o.tipo === 'calendario') return { tipo: o.tipo };`

**d)** Preço (a IA não fala valor). No prompt de sistema:
1. Trocar o item "- Preço (sempre uma PREVISÃO): ..." (inteiro) por: `- Preço: NUNCA informe, estime ou comente valores, descontos ou formas de pagamento. Se o paciente perguntar, diga com simpatia que o atendente informa o valor certo na hora de confirmar o agendamento, e siga o roteiro. Você não recebe preços.`
2. Na descrição do catálogo, tirar "precos (valores de referência)".
3. Em REGRAS DE SEGURANÇA, trocar "Não invente preços: só cite valores que estejam em precos, seguindo a regra de Preço (sempre como previsão)." por "Nunca informe preços."
4. Na etapa 6 ("confirmacao"), tirar "o valor de referência se foi informado,".
5. No campo `resumo` do formato de resposta, trocar "valor e data citados ao paciente como previsão" por "data citada ao paciente como previsão".
6. Em "PACIENTE QUE VOLTA", trocar "O histórico não traz preços: não cite valores antigos; preço segue a regra de Preço (sempre previsão)." por "O histórico não traz preços."

**e)** Publicar a nova versão do fluxo (o rascunho não atende ninguém).

## Testes feitos

No projeto real, dentro de transações revertidas (nada gravado):
- Médico de outra unidade recusado; catálogo restrito à Desenvoar; filtro de médico no calendário com volta para os demais.
- Responsável adulta cadastrada = reconhecida; a mesma pessoa como responsável de um filho sem cadastro = novo; filho cadastrado = reconhecido; irmão com outro nome = novo; sem pedido pela metade cruzado.
- Fila de filhos: responsável + 3 filhos, modo "juntos": primeira mensagem "Olá! Quero agendar para Lucas.", consulta de puericultura salva, calendário com 4 dias de horários da médica escolhida, horário 08:20 escolhido, conversa do Pedro criada com o pedido copiado (etapa data_hora, plano mantido), calendário do Pedro com sugestão 08:40 (mesma médica), clique repetido devolve a mesma conversa, o último filho encerra a fila, "outros filhos" para paciente próprio recusado, consulta inexistente recusada. No modo "um de cada vez" nada é copiado.
- Formulário, chat e painel, no navegador com servidor simulado: unidade e "quem será atendido", campos de irmãos e modo, faixa "Agendar para Pedro", troca de conversa, seletor de consulta, calendário com a sugestão marcada e o filtro de médico. **Não** foi testado contra o Supabase de verdade nem com o Klingo.

## Limites conhecidos (para decidir depois)

- **Dois filhos com o mesmo nome** do mesmo responsável seriam tratados como a mesma criança. A data de nascimento, pedida antes de reaproveitar qualquer dado, é a segunda trava.
- **CPF da criança**: aceita-se o do responsável (avisado no resumo); o cadastro fica `revisar` se o CPF já existir (acontece com irmãos). O painel ainda não tem um campo "responsável".
- **Painel**: a lista mostra "Maria · Lucas" (responsável · criança) e o topo da conversa mostra paciente, unidade e médico de preferência. Se o painel for publicado antes do SQL, ele volta sozinho para a lista antiga em vez de quebrar (o alerta de valor também some sem erro).
- **Confirmação automática de consulta** (`agenda-conferir`): depende de o nome do procedimento no relatório #7 do Klingo ser o do cadastro; validar com a primeira consulta real da Desenvoar, como as demais fases.
- O filtro de médico e a sugestão de horário olham só a grade do Klingo; o horário continua sendo previsão e quem confirma é o atendente.
- "Juntos" é em sequência (horários seguidos), não no mesmo minuto, e só quando o irmão já escolheu o horário antes de o responsável avançar. Se o irmão ainda não escolheu horário, a sugestão não aparece.
- Adolescente que conversa sozinho: escolher "Eu mesmo(a)" (a Desenvoar vem com "filho(a)" marcado, mas dá para trocar).
