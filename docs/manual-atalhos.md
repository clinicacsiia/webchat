# Manual: Atalhos (respostas prontas)

Atualizado em 11/11/2026.

Resposta pronta é um texto pré-escrito que o atendente coloca na conversa digitando `/` e o nome do atalho. Serve para não digitar sempre as mesmas frases (bom dia, orientação de preparo, endereço, etc.). O texto pode ter **variáveis**, que viram os dados de cada paciente.

## Quem faz o quê

| Quem | O que pode |
|---|---|
| Administrador | Ver a aba **Atalhos**, criar, editar e apagar respostas |
| Atendente | Usar as respostas na conversa (digitando `/`). Não vê a aba Atalhos |

## 1. Criar uma resposta pronta (administrador)

1. No menu da esquerda, abra **Atalhos** (fica logo abaixo de Configurações).
2. Clique em **Adicionar resposta pronta**.
3. Em **Atalho**, escreva o nome curto, sem a barra. Exemplo: `bomdia`.
   - Só letras minúsculas sem acento, números, `-` e `_`, até 30 caracteres.
   - Não pode haver dois atalhos com o mesmo nome.
4. Em **Resposta**, escreva o texto.
5. Para colocar uma variável, clique no botão dela em **Inserir variável** (ela entra onde está o cursor). Também dá para digitar à mão, com chaves, por exemplo `{nome}`.
6. Clique em **Salvar**.

Para mudar uma resposta, clique em **Editar**. Para tirar, clique em **Apagar** e confirme.

## 2. Usar na conversa (todos da equipe)

1. Abra a conversa e clique na caixa de resposta.
2. Digite `/`. Aparece a lista das respostas. Continue digitando para filtrar (por exemplo `/bom`).
3. Escolha com as setas do teclado e aperte **Enter** ou **Tab**, ou clique com o mouse.
4. O texto entra na caixa, já com as variáveis trocadas. **Leia antes de enviar** e aperte Enter para mandar.
5. **Esc** fecha a lista sem inserir nada.

A `/` funciona no começo da caixa ou depois de um espaço, e a resposta pode ser inserida no meio de um texto que você já está escrevendo.

## 3. Variáveis

| Variável | Vira |
|---|---|
| `{nome}` | Primeiro nome de quem está escrevendo no chat |
| `{paciente}` | Primeiro nome do paciente (se quem escreve é o responsável, o nome da criança) |
| `{nome_completo}` | Nome completo de quem está escrevendo |
| `{atendente}` | Seu primeiro nome |
| `{saudacao}` | Bom dia, Boa tarde ou Boa noite, conforme a hora |
| `{exame}` | Exame(s) do pedido |
| `{data}` | Data do horário (escolhido, ou desejado pelo paciente) |
| `{hora}` | Hora do horário |
| `{unidade}` | Unidade |
| `{plano}` | Convênio / plano |
| `{medico}` | Profissional (ou médico de preferência) |

De onde vem cada dado:
- `{exame}`, `{plano}`: pedido (pré-agendamento) da conversa.
- `{data}` e `{hora}`: horário que o paciente escolheu no calendário; se ainda não escolheu, a data e hora que ele pediu; se não houver, o exame já agendado em aberto.
- `{unidade}`: horário escolhido, depois a unidade do pedido, depois a unidade que o paciente indicou no início.
- `{medico}`: profissional do pedido, depois o do horário escolhido, depois o médico de preferência.

### Quando falta o dado
Se a conversa não tem o dado, a variável **continua escrita** no texto (por exemplo `{data}`) e aparece um aviso no topo: "Sem dado nesta conversa para {data}…". Preencha à mão antes de enviar. Isso evita mandar uma frase errada ao paciente.

## 4. Exemplos prontos

- **bomdia**: `{saudacao}, {nome}! Aqui é {atendente}, da CSI. Como posso ajudar?`
- **confirmado**: `{saudacao}, {nome}! Seu exame {exame} está marcado para {data} às {hora}, na unidade {unidade}. Chegue 15 minutos antes e traga um documento com foto.`
- **plano**: `{nome}, o seu convênio é {plano}. Confirma para mim?`

## 5. Dicas

- Use atalhos curtos e fáceis de lembrar. Quem digita `/` vê todos.
- Revise o texto antes de enviar, principalmente quando aparecer o aviso de dado faltando.
- Se uma variável vier errada ou vazia em uma conversa que tem o dado, avise a TI com o exemplo.
- Se a aba **Atalhos** não aparecer após uma atualização, recarregue a página com Ctrl+F5.

## Dados técnicos (para a TI)

- Tabela `respostas_prontas` (script `supabase/respostas-prontas.sql`): leitura para toda a equipe, escrita só para administrador.
- O painel troca as variáveis na hora de inserir o texto (`valoresAtalho` e `aplicarVariaveis` em `painel/index.html`). Nada é gravado com os dados do paciente além da própria mensagem enviada.
