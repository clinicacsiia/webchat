# Fase 6: unidade e médico de preferência no início do chat

Data: 30/10/2026. SQL: `supabase/fase6-unidade-e-medico.sql`. Chat: `index.html`.

## A ideia

A unidade que o paciente escolhe já diz o que ele quer. Em vez de a IA descobrir isso em 3 ou 4 mensagens, o formulário pergunta **primeiro**, e o resto do atendimento nasce já no caminho certo:

| Unidade | Tipo de atendimento previsto (`fluxo`) | O que a IA faz diferente |
|---|---|---|
| **Desenvoar** | `pediatria` | Sem mapa do corpo. Pergunta o motivo em lista (pediatria/puericultura, neuro, endócrino, gastro, orto, EEG, outro). O paciente é a criança: pede nome e nascimento da criança, nome da mãe e contato do responsável. Emergência pediátrica vai para o 192. |
| **CSI** | `exame_consulta` | Se não ficou claro, pergunta "consulta ou exame?". Exame de imagem vai para o mapa do corpo; consulta, para a lista de especialidades. |
| **CSI RM/TC** | `exame_consulta` | Vai direto ao mapa do corpo (só ressonância e tomografia na agenda). Se pedirem consulta, orienta a ir à CSI. |
| **Ainda não sei** | `indefinido` | A IA descobre o que ele precisa e **sugere** a unidade (criança: Desenvoar; RM/TC; resto: CSI). |

Os textos de cada caminho ficam na tabela `unidade_config.instrucao`. Para ajustar um atendimento (ou abrir uma unidade nova) basta editar a tabela, sem mexer no prompt do n8n.

A lista de médicos vem da agenda vigente do Klingo (só quem tem **consulta** na unidade; ficam de fora agenda de teste, "Eletrocardiograma" e anestesiologia). Hoje: Desenvoar 13, CSI 15, RM/TC nenhum (a pergunta de médico não aparece nessa unidade). Quem cadastrar uma consulta nova no Klingo aparece sozinho na lista na próxima sincronização do catálogo.

## O que o paciente vê

1. Primeira coisa do formulário: **Em qual unidade você quer ser atendido?** (Desenvoar / CSI / CSI RM/TC / Ainda não sei). Obrigatório escolher uma, mas "Ainda não sei" vale.
2. Escolhida uma unidade com médicos: **Tem médico de preferência? (opcional)**, com "Sem preferência" e a lista com a especialidade de cada um.
3. Se o catálogo não carregar, o formulário volta ao comportamento antigo (sem as perguntas) e a IA pergunta a unidade no chat.

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
UNIDADE E MÉDICO ESCOLHIDOS NO INÍCIO: em "Escolha feita no início do chat" você recebe a unidade que o paciente escolheu no formulário (unidade, unidade_catalogo, fluxo), o médico de preferência (medico_preferido, pode ser nulo) e a "instrucao" da clínica para esse tipo de atendimento. Siga a instrucao; ela vale mais que o roteiro genérico abaixo, exceto nas REGRAS DE SEGURANÇA.
- Se unidade_catalogo vier preenchida, NÃO pergunte a unidade nem ofereça outra, a menos que o paciente peça ou o catálogo mostre que o exame não existe lá. Na primeira vez que enviar pre_agendamento, inclua unidade com o valor exato de unidade_catalogo.
- Se medico_preferido vier preenchido, NÃO pergunte médico: inclua profissional com esse nome exato. Se agenda mostrar que ele não atende o que o paciente pediu, diga isso com delicadeza e ofereça outro da mesma especialidade (só nomes que estejam no catálogo).
- Se fluxo for "indefinido", siga a instrucao para sugerir a unidade antes da etapa preferencias.
- No fluxo "pediatria" o paciente é a criança: o campo paciente leva os dados dela (nome, dt_nasc, sexo, mae) e o celular do responsável.
```

**c)** Publicar a nova versão do fluxo (o rascunho não atende ninguém).

## Limites conhecidos (para decidir depois)

- **Identidade na pediatria**: o chat identifica o paciente por nome + telefone + e-mail de quem preenche o formulário, que na Desenvoar é o responsável. Se o mesmo responsável trouxer dois filhos, a conferência de identidade (`paciente_conferir`) não distingue as crianças. Só vale mexer com dados reais de pacientes pediátricos.
- **CPF da criança**: o prompt manda aceitar o CPF do responsável e avisar no resumo. O cartão do painel ainda não tem um campo "responsável".
- **EEG e anestesia na Desenvoar** aparecem como exames/atendimentos, mas não como "médico" na lista de preferência (são salas, não médicos).
- O filtro de médico no calendário olha só a grade do Klingo; o horário continua sendo previsão e quem confirma é o atendente.
- Painel: o atendente ainda não vê a unidade escolhida na lista de conversas (ela já aparece no resumo da IA e no cartão do pré-agendamento quando a IA registra `unidade` e `profissional`).
