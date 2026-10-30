# Fase 6: unidade, "quem será atendido" e médico de preferência no início do chat

Data: 30/10/2026. SQL: `supabase/fase6-unidade-e-medico.sql`. Chat: `index.html`.

## A ideia

O formulário pergunta **primeiro** o que define o caminho, e o resto do atendimento nasce já certo. São duas perguntas antes do nome e uma depois dos contatos:

1. **Unidade** (antes do nome): Desenvoar, CSI, CSI RM/TC ou "Ainda não sei".
2. **Quem será atendido?** (antes do nome): "Eu mesmo(a)" ou "Meu filho ou filha (sou o responsável)". A Desenvoar já vem com "filho(a)" marcado; as outras vêm com "eu mesmo(a)". Quem mexeu na pergunta não perde a escolha ao trocar de unidade.
3. **Médico de preferência** (depois do e-mail, antes da mensagem): opcional, só aparece se a unidade tem médicos com consulta.

| Caminho | O que muda |
|---|---|
| **Filho(a)** (qualquer unidade) | Aparece "Seu nome (responsável)" e "Nome completo da criança". A IA fala com o responsável, registra os dados da CRIANÇA (nome, nascimento, sexo, mãe), usa o celular do responsável, confere a idade da criança e trata emergência pediátrica (192). Um atendimento por criança. |
| **Desenvoar** | Sem mapa do corpo. Motivo em lista (pediatria/puericultura, neuro, endócrino, gastro, orto, EEG, outro). |
| **CSI** | Se não ficou claro, pergunta "consulta ou exame?". Exame de imagem vai para o mapa do corpo; consulta, para a lista de especialidades. |
| **CSI RM/TC** | Vai direto ao mapa do corpo (só ressonância e tomografia na agenda). |
| **Ainda não sei** | A IA descobre o que ele precisa e **sugere** a unidade (criança: Desenvoar; RM/TC; resto: CSI). |

Os textos ficam nas tabelas `unidade_config` (por unidade) e `atendimento_tipo` (próprio x filho). Para ajustar um atendimento basta editar a tabela, sem mexer no prompt do n8n.

A lista de médicos vem da agenda vigente do Klingo (só quem tem **consulta** na unidade; ficam de fora agenda de teste, "Eletrocardiograma" e anestesiologia). Hoje: Desenvoar 13, CSI 15, RM/TC nenhum (a pergunta não aparece nessa unidade).

## Responsável com vários filhos

**Uma conversa por criança.** Cada filho tem o próprio pré-agendamento, os próprios horários (a regra "o mesmo paciente não fica em dois lugares" vale por criança, então dois irmãos podem ser agendados em horários diferentes sem se bloquearem) e o próprio cadastro.

- No menu (três pontinhos) do chat aparece **Agendar para outro filho(a)**: abre o formulário já com os dados do responsável, a unidade e "filho(a)" marcados; só falta o nome da criança. O médico não é repetido.
- A IA avisa isso ao final do pedido (está na instrução `filho`). Não há limite de filhos; o limite do sistema é de 5 conversas por hora por telefone.
- **Identidade**: com "filho(a)", a conferência de cadastro usa o nome da CRIANÇA + o telefone do responsável. Sem isso, o responsável que já é paciente casaria com o próprio cadastro e a IA reaproveitaria o CPF, o endereço e o nascimento dele no pedido da criança. Testado: responsável adulta cadastrada = reconhecida na conversa dela; a mesma pessoa como responsável de um filho sem cadastro = novo; filho já cadastrado = reconhecido; irmão com outro nome = novo (e o pedido pela metade de um irmão nunca é oferecido ao outro).
- Criança que volta: reconhecida por nome + telefone do responsável e confirmada pela data de nascimento, como qualquer paciente.

## O que o paciente vê

1. **Em qual unidade você quer ser atendido?** (obrigatório escolher uma; "Ainda não sei" vale), logo no topo.
2. **Quem será atendido?** (aparece depois de escolher a unidade).
3. Nome (ou "Seu nome (responsável)" + "Nome completo da criança"), telefone, e-mail.
4. **Tem médico de preferência? (opcional)**, com "Sem preferência" e a especialidade de cada médico.
5. Mensagem e aceite.
Se a lista de unidades não carregar, o formulário volta ao comportamento antigo e a IA pergunta a unidade no chat.

No calendário de horários:
- A unidade escolhida já vem selecionada (o paciente pode trocar para "Qualquer unidade").
- O médico escolhido filtra os horários. Se ele não tem horário para aquele pedido, o calendário mostra os de outros médicos e avisa. Com o filtro ativo, o botão **Ver outros médicos** tira o filtro.

## Como aplicar (nesta ordem)

1. **Banco**: rodar `supabase/fase6-unidade-e-medico.sql` no SQL Editor do projeto `webchat-atendimento`. É aditivo e pode rodar de novo. Já foi testado em transação revertida no projeto (nada ficou gravado): unidade e médico gravados na criação da conversa, médico de outra unidade recusado, catálogo restrito à Desenvoar, filtro de médico no calendário com volta para os demais.
2. **Limpeza** (depois do passo 1, uma vez): `drop function public.chat_iniciar(text, text, text, text, boolean, text);` Sem isso, chamadas com 6 argumentos ficam ambíguas com a versão nova de 8. O Supabase pede confirmação humana para `drop`.
3. **n8n**, fluxo `Triagem IA - Atendimento` (ver abaixo). Sem este passo o banco e o chat já guardam e filtram a escolha, mas a IA ainda não lê a instrução.
4. **Chat**: merge do PR (GitHub Pages publica o `index.html`). O banco tem de estar atualizado antes.

## Mudança no n8n

**a)** No nó **Triagem com Claude**, na mensagem do usuário, logo depois da linha `Origem: ...`, acrescentar:

```
Escolha feita no início do chat (unidade e médico de preferência; a "instrucao" é regra da clínica para esta conversa):
{{ JSON.stringify($('Buscar histórico no Supabase').first().json.inicio ?? {}) }}
```

**b)** No prompt de sistema (campo `system`), antes de "ETAPAS DO PRÉ-AGENDAMENTO", acrescentar:

```
UNIDADE, QUEM SERÁ ATENDIDO E MÉDICO: em "Escolha feita no início do chat" você recebe a unidade que o paciente escolheu no formulário (unidade, unidade_catalogo, fluxo), o médico de preferência (medico_preferido, pode ser nulo), quem será atendido (paciente_tipo "proprio" ou "filho"; paciente_nome é o nome da criança quando for filho) e duas instruções da clínica: "instrucao" (da unidade) e "instrucao_paciente" (de quem será atendido). Siga as duas; elas valem mais que o roteiro genérico abaixo, exceto nas REGRAS DE SEGURANÇA.
- Se unidade_catalogo vier preenchida, NÃO pergunte a unidade nem ofereça outra, a menos que o paciente peça ou o catálogo mostre que o exame não existe lá. Na primeira vez que enviar pre_agendamento, inclua unidade com o valor exato de unidade_catalogo.
- Se medico_preferido vier preenchido, NÃO pergunte médico: inclua profissional com esse nome exato. Se agenda mostrar que ele não atende o que o paciente pediu, diga isso com delicadeza e ofereça outro da mesma especialidade (só nomes que estejam no catálogo).
- Se fluxo for "indefinido", siga a instrucao para sugerir a unidade antes da etapa preferencias.
- Se paciente_tipo for "filho", quem conversa é o responsável: no campo paciente.nome vai o nome da CRIANÇA e a idade usada para conferir o procedimento é a dela. Em "Situação do paciente" e em "Histórico", o que vale é a criança. Atenda uma criança por conversa.
```

**c)** Publicar a nova versão do fluxo (o rascunho não atende ninguém).

## Limites conhecidos (para decidir depois)

- **Dois filhos com o mesmo nome** do mesmo responsável (gêmeos com nome igual não existem na prática, mas "Maria Eduarda" e "Maria Eduarda Souza" sim) seriam tratados como a mesma criança. A data de nascimento, pedida antes de reaproveitar qualquer dado, é a segunda trava.
- **CPF da criança**: a instrução manda aceitar o CPF do responsável e avisar no resumo; o cadastro dessa criança fica marcado `revisar` se o CPF já existir em outro cadastro (acontece com irmãos). O painel ainda não tem um campo "responsável" nem mostra o nome da criança na lista de conversas (a lista mostra o nome do responsável; o nome da criança aparece no resumo da IA e no cartão do pré-agendamento).
- **EEG e anestesia na Desenvoar** aparecem como exames/atendimentos, mas não como "médico" na lista de preferência (são salas, não médicos).
- O filtro de médico no calendário olha só a grade do Klingo; o horário continua sendo previsão e quem confirma é o atendente.
- Adolescente que conversa sozinho: escolher "Eu mesmo(a)" (a Desenvoar vem com "filho(a)" marcado, mas dá para trocar).
