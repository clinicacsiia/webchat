# Fluxograma da conversa do Webchat

Como o paciente conversa com o assistente automático e com a equipe, do formulário inicial ao encerramento.
Desenhado em 14/11/2026 a partir de `supabase/producao/funcoes/` e de `index.html` (`VERSAO_APP` 2026.11.13-7).
Borda **verde** = responde o assistente (o banco); borda **laranja** = responde uma pessoa da equipe; borda tracejada vermelha = erro ou recusa.

## 1. Visão geral: do primeiro toque ao fim do atendimento

O caminho completo de uma conversa. Cada caixa grande tem um fluxograma próprio mais abaixo.

```mermaid
flowchart TD
  A(["Paciente abre o chat"]) --> B["Formulário inicial<br/>nome, celular, e-mail,<br/>para mim ou para filho(a), aceite"]
  B --> C{"Já existe conversa aberta<br/>deste paciente neste aparelho?"}
  C -- "sim, quer continuar" --> H(["Volta para a conversa de onde parou"])
  C -- "não, ou quer uma nova" --> D["O banco cria a conversa<br/>e um token secreto<br/>(fica guardado no aparelho)"]
  D --> E["Assistente automático dá olá<br/>e faz a primeira pergunta"]
  H --> F
  E --> F["Conversa por botões (seções 2 e 3)<br/>o assistente pergunta, o paciente toca"]
  F --> G{"Como termina?"}
  G -- "pedido completo" --> I["Marcação automática<br/>ou pedido pronto para a equipe (seção 4)"]
  G -- "pediu atendente, outro assunto,<br/>emergência ou erro" --> J["Passa para a equipe (seção 5)"]
  I --> K
  J --> K["A equipe atende no painel<br/>o assistente para de responder"]
  K --> L["Equipe encerra, com motivo"]
  L --> M["Despedida e convite<br/>para avaliar (seção 6)"]
  class J,K,L equipe
  class E,F,I auto
  classDef equipe stroke:#d9730d,stroke-width:3px
  classDef auto stroke:#0f8a7e,stroke-width:3px
  classDef problema stroke:#c0392b,stroke-width:2px,stroke-dasharray:5 3
```

- **Borda verde** = quem responde é o assistente automático (o banco); **borda laranja** = quem responde é uma pessoa da equipe.
- O chat só chama funções do banco com o token da conversa. Sem o token, nada aparece.
- Limite de abertura: 5 conversas por hora para o mesmo telefone. Se já havia uma conversa sem atendente da mesma pessoa, ela é encerrada como "nova conversa" e fica só uma.

## 2. O que acontece a cada toque do paciente

Vale para qualquer passo. Tudo isto roda no banco, na mesma chamada que grava a mensagem, e a resposta volta junto.

```mermaid
flowchart TD
  A["Paciente toca num botão,<br/>preenche campos ou escreve"] --> B["A tela chama o banco<br/>(chat_responder ou chat_enviar)"]
  B --> C{"O token da conversa confere?"}
  C -- "não" --> C1["Erro 28000: nada é mostrado"]
  C -- "sim" --> D{"Mais de 20 mensagens<br/>no último minuto?"}
  D -- "sim" --> D1["Pede para aguardar um instante"]
  D -- "não" --> E{"O assistente ainda conduz<br/>e esta é a pergunta atual?"}
  E -- "não" --> E1["#quot;Essa pergunta já foi respondida#quot;:<br/>a tela relê a conversa e se ajusta"]
  E -- "sim" --> F["Grava a mensagem do paciente"]
  F --> G["Gatilho do banco chama o motor<br/>(fluxo_avancar)"]
  G --> R{"Que tipo de entrada?"}
  R -- "pediu atendente<br/>(botão ou palavras como<br/>humano, atendente, recepcionista)" --> T["Transfere para a equipe"]
  R -- "texto com sinal de emergência<br/>(dor no peito, falta de ar, AVC...)" --> U["Orienta ligar 192<br/>e transfere com urgência alta"]
  R -- "texto sobre preço<br/>ou orientação clínica" --> V["Resposta fixa<br/>e repete a pergunta"]
  R -- "botão ou campos" --> W["Aplica a resposta ao pedido"]
  R -- "texto livre" --> X{"O motor entende o texto<br/>neste passo?"}
  X -- "sim" --> W
  X -- "não" --> Y["Diz que não entendeu,<br/>anota para a equipe<br/>e repete a pergunta<br/>(não transfere)"]
  W --> Z{"A resposta é válida?"}
  Z -- "não" --> Z1["Aponta o campo errado<br/>e repete a pergunta"]
  Z -- "sim" --> P["Calcula o próximo passo<br/>(fluxo_proximo, seção 3)"]
  P --> Q["Grava e devolve a próxima pergunta"]
  Q --> S["A resposta volta na mesma chamada<br/>e a tela desenha na hora"]
  G -. "erro técnico no motor" .-> ER["Mensagem de erro<br/>e transfere para a equipe"]
  class T,U,ER equipe
  class P,Q,S auto
  class C1,E1,D1,ER problema
  classDef equipe stroke:#d9730d,stroke-width:3px
  classDef auto stroke:#0f8a7e,stroke-width:3px
  classDef problema stroke:#c0392b,stroke-width:2px,stroke-dasharray:5 3
```

- A checagem de emergência só vale para **texto escrito**, não para botões.
- Pelo botão "Corrigir" (chat_voltar), o paciente volta à pergunta anterior; só funciona enquanto o assistente conduz e não funciona na primeira pergunta.
- Tempo medido: de 3 a 27 ms no servidor por passo (fase 7). O limite do paciente sem login é 3 s por chamada; acima disso dá o erro 57014.

## 3. Os passos do assistente, na ordem

A função fluxo_proximo olha o que o paciente já respondeu e decide qual é a próxima pergunta. Passo já respondido é pulado.

```mermaid
flowchart TD
  I(["Primeira pergunta"]) --> ID{"Cadastro antigo<br/>sem data de nascimento?"}
  ID -- "sim" --> ID1["Pede a data de nascimento"]
  ID -- "não" --> AT
  ID1 --> AT{"Paciente que volta,<br/>com pedido anterior?"}
  AT -- "sim" --> AT1["Atalho: repetir o último exame,<br/>continuar o pedido pela metade<br/>ou começar outro"]
  AT -- "não" --> MO
  AT1 --> MO["Motivo:<br/>Exame, Consulta ou Outro assunto"]
  MO -- "Exame" --> EX["Escolhe o exame:<br/>foto do pedido, mapa do corpo<br/>ou pelo nome"]
  MO -- "Consulta" --> CO["Escolhe a consulta<br/>(criança: pediatria / adulto: consulta)"]
  MO -- "Outro assunto" --> AS(["Seção 5"])
  CO --> ME{"Há mais de um médico<br/>para essa consulta?"}
  ME -- "sim" --> ME1["Escolhe o médico<br/>ou #quot;tanto faz#quot;"]
  ME -- "não" --> CN
  ME1 --> CN
  EX --> CN["CPF e data de nascimento<br/>(obrigatórios; o banco confere o CPF)"]
  CN --> PL["Plano:<br/>Particular ou convênio"]
  PL --> HO["Calendário:<br/>escolhe dia e horário<br/>(um por grupo de exames)"]
  HO -- "nenhum horário serve" --> PV["Lista de previsão (espera por vaga)<br/>ou anota para a equipe procurar"]
  HO --> MU
  PV --> MU{"Cadastro já conferido<br/>e completo?"}
  MU -- "sim" --> CF
  MU -- "conferido, mas<br/>falta algum dado" --> Q1{"Seus dados<br/>continuam os mesmos?"}
  Q1 -- "continuam" --> CF
  Q1 -- "mudaram" --> DI
  MU -- "paciente novo" --> DI["Dados de identificação:<br/>nome, sexo, nascimento, mãe, CPF"]
  DI --> DC["Dados de contato:<br/>celular, telefone, e-mail"]
  DC --> CF["Confirmar:<br/>resumo do pedido"]
  CF -- "corrigir" --> CR["Volta ao passo escolhido:<br/>pedido, plano, horário ou dados"]
  CR --> CN
  CF -- "tudo certo" --> FIM(["Seção 4: marcação ou pedido pronto"])
  class AS,FIM equipe
  classDef equipe stroke:#d9730d,stroke-width:3px
  classDef auto stroke:#0f8a7e,stroke-width:3px
  classDef problema stroke:#c0392b,stroke-width:2px,stroke-dasharray:5 3
```

- O endereço e a carteirinha **não são mais perguntados** (carteirinha saiu em 12/11/2026; o atendente confere o convênio depois).
- Consulta de médico só pergunta o médico se houver mais de um disponível. A conversa de um irmão copiada no modo "juntos" também pula essa pergunta.
- Quando uma oferta de horário já está pendente (pedido sem horário) ou a previsão está em andamento, essas perguntas passam na frente de tudo.

## 4. Depois da confirmação: marcação automática ou pedido para a equipe

Ao confirmar, o banco decide se pode marcar sozinho no Klingo. Se não puder (ou se a chave estiver desligada), o pedido segue para a equipe como sempre.

```mermaid
flowchart TD
  A(["Paciente confirma o pedido"]) --> B{"Dá para marcar sozinho?<br/>(klingo_pode_marcar)"}
  B -- "não" --> C["Pedido pronto para a equipe<br/>com a nota do motivo"]
  C --> D["Cartão de acompanhamento com cronômetro<br/>#quot;Aguardando a confirmação do atendente#quot;"]
  D --> D1["A equipe marca no Klingo<br/>e confirma com o paciente"]
  B -- "sim" --> E["Cria a operação de marcação<br/>(duplo toque vale um só)"]
  E --> F["Chat mostra<br/>#quot;Reservando seu horário…#quot;"]
  F --> G["Função klingo-executar:<br/>confere cadastro, plano e se<br/>o horário ainda existe"]
  G --> H{"Resultado"}
  H -- "marcado, com protocolo" --> I["Cartão do agendamento<br/>e menu"]
  H -- "horário tomado" --> J["Volta ao calendário<br/>com lista nova"]
  H -- "resposta incerta" --> K["Equipe confere ANTES<br/>de marcar de novo"]
  H -- "falha<br/>(convênio, divergência...)" --> L["Pedido vai para a equipe<br/>com o motivo"]
  J --> A
  I --> M{"Menu depois da marcação"}
  M -- "Ver a minha marcação" --> M1["Mostra serviço, dia, hora,<br/>unidade, médico e protocolo"]
  M1 --> M
  M -- "Cancelar" --> N{"Faltam mais de 24 h?"}
  N -- "não" --> NE["Equipe resolve"]
  N -- "sim" --> N1["#quot;Cancelar este agendamento?#quot;"]
  N1 -- "sim" --> N2["Operação de cancelamento no Klingo"]
  N1 -- "não, manter" --> M
  M -- "Remarcar" --> O{"Faltam mais de 24 h?"}
  O -- "não" --> NE
  O -- "sim" --> O1["Volta ao calendário.<br/>O horário atual vale até<br/>o novo ser confirmado"]
  O1 --> A
  M -- "Falar com a equipe" --> NE
  M -- "Está tudo certo" --> P(["Agradece e oferece nova conversa"])
  class C,D1,K,L,NE equipe
  class E,F,G,I,N2 auto
  classDef equipe stroke:#d9730d,stroke-width:3px
  classDef auto stroke:#0f8a7e,stroke-width:3px
  classDef problema stroke:#c0392b,stroke-width:2px,stroke-dasharray:5 3
```

- **Marca sozinho só se:** a chave de marcação está ligada para essa conversa; há 1 só procedimento e 1 só horário; o horário veio da API do Klingo e ainda vale (até 20 min); CPF, nascimento, nome e sexo estão completos; o cadastro não está divergente; o plano tem tradução; e, se for exame, é Particular.
- Nada vira "agendado" sem protocolo (voucher) devolvido pelo Klingo. Resposta perdida vira **incerta**, nunca "tenta de novo".
- Mensagem de texto durante a marcação: "aguarde". Depois dela: reabre o menu.

## 5. Outro assunto: remarcar, cancelar, resultado, dúvida, reclamação

Quando o motivo é "Outro assunto", o assistente não monta pedido. Ele tenta resolver o que dá e passa o resto para a equipe.

```mermaid
flowchart TD
  A["Escolhe o tema"] --> B{"Qual tema?"}
  B -- "Remarcar um horário" --> C{"O chat conhece algum<br/>horário futuro dele?"}
  B -- "Cancelar um horário" --> C
  C -- "sim" --> D["Qual deles?<br/>(ou #quot;nenhum#quot;)"]
  C -- "não" --> H
  D -- "nenhum" --> H
  D -- "remarcar um deles" --> E["Reaproveita o exame<br/>e volta ao calendário<br/>(seção 3); nota para a equipe<br/>cancelar o horário antigo"]
  D -- "cancelar um deles" --> F{"Confirma:<br/>cancelar este?"}
  F -- "sim" --> G["Transfere para a equipe<br/>com o nome do item"]
  F -- "não" --> C
  B -- "Resultado de exame" --> R{"Existe texto de orientação<br/>cadastrado pela clínica?"}
  R -- "sim" --> R1{"A orientação resolveu?"}
  R1 -- "resolveu" --> RF(["Agradece e encerra o assunto"])
  R1 -- "falar com atendente" --> H
  R -- "não" --> H
  B -- "Dúvida, Reclamação<br/>ou Outro" --> H["Paciente escreve o assunto<br/>(o campo de texto aparece)"]
  H --> T["Transfere para a equipe<br/>com urgência baixa"]
  class G,T equipe
  classDef equipe stroke:#d9730d,stroke-width:3px
  classDef auto stroke:#0f8a7e,stroke-width:3px
  classDef problema stroke:#c0392b,stroke-width:2px,stroke-dasharray:5 3
```

- Remarcar por aqui reaproveita o pedido antigo e passa de novo pelos passos da seção 3. A equipe recebe a nota para cancelar o horário antigo.
- Não está desenhado aqui: a pergunta sobre exame em aberto ("você compareceu?"), que existe no motor (passos exame_aberto e remarcar_falta).

## 6. Estados da conversa: quem responde e quando fecha

A conversa passa por três estados. O assistente só responde enquanto está "aguardando" com a automação ligada.

```mermaid
flowchart LR
  A(["Aguardando<br/>o assistente conduz"]) -- "pede atendente, outro assunto,<br/>emergência, erro ou pedido pronto" --> B["Aguardando equipe<br/>o assistente para"]
  B -- "uma pessoa assume e escreve" --> C["Em atendimento"]
  C -- "devolve ao assistente" --> A
  C -- "24 h sem resposta do paciente" --> Z["Marcada: Chamar no WhatsApp<br/>continua aberta"]
  Z -- "paciente responde<br/>ou equipe escreve" --> C
  A -- "equipe encerra" --> E
  B -- "equipe encerra" --> E
  C -- "equipe encerra, com motivo" --> E(["Encerrada"])
  Z -- "equipe encerra" --> E
  E --> D["Despedida e convite<br/>para avaliar"]
  E -- "paciente escreve<br/>em até 2 dias" --> B
  E -- "mais de 2 dias,<br/>ou paciente abriu outra" --> N["Abre uma nova conversa<br/>(o histórico fica salvo)"]
  B -- "paciente escreve depois<br/>de ter o pedido pronto" --> R["Assistente avisa que reabriu<br/>e a equipe é avisada"]
  R --> B
  class B,C,Z,E equipe
  class A auto
  classDef equipe stroke:#d9730d,stroke-width:3px
  classDef auto stroke:#0f8a7e,stroke-width:3px
  classDef problema stroke:#c0392b,stroke-width:2px,stroke-dasharray:5 3
```

- Desde 11/11/2026 a conversa **não fecha sozinha** por falta de resposta: ela fica marcada "Chamar no WhatsApp" para a equipe ir atrás do paciente.
- Encerrar pela equipe exige motivo. Encerrar como "Agendado" confere a agenda antes. O prazo para reabrir é `reabrir_dias` (hoje 2).
- Quando a equipe assume, os botões do assistente na tela do paciente se desligam sozinhos.

## 7. Como a tela do paciente fica em dia

O que mantém o chat atualizado sem o paciente fazer nada, e o que acontece com o chat fechado.

```mermaid
flowchart LR
  A["O banco grava uma mensagem nova<br/>do assistente ou da equipe"] --> B["Aviso em tempo real<br/>no canal da conversa"]
  B --> C["A tela desenha a mensagem<br/>e relê a conversa (chat_listar)"]
  A -. "se o aviso não chegar" .-> D["Consulta de reserva:<br/>4, 8, 15 e 30 s<br/>(45 s quando o aviso funciona)"]
  D --> C
  A -. "chat fechado ou em segundo plano" .-> E["Aviso no celular (push)<br/>sem nome e sem texto:<br/>só #quot;você recebeu uma resposta#quot;"]
  E --> F["Paciente abre o chat"]
  F --> G["Abre na hora com as últimas 80 mensagens<br/>guardadas no aparelho<br/>e busca o que é novo"]
  G --> C
  C --> S["Sentinela vigia:<br/>mensagem fora de ordem, tela travada,<br/>resposta lenta, erro de chamada"]
  S -- "algo errado" --> S1["Tenta curar sozinha,<br/>avisa o paciente e gera o código<br/>CSI-AAMMDD-HHMM-TIPO-XXXX"]
  class S1 problema
  classDef equipe stroke:#d9730d,stroke-width:3px
  classDef auto stroke:#0f8a7e,stroke-width:3px
  classDef problema stroke:#c0392b,stroke-width:2px,stroke-dasharray:5 3
```

- Aba escondida por muito tempo fecha o canal; ao voltar, reabre e consulta na hora.
- A Sentinela nunca registra texto de mensagem nem dado pessoal. Se ela não carregar, o chat funciona igual.

## De onde saiu

- `index.html`: tela do paciente (VERSAO_APP 2026.11.13-7)
- `supabase/producao/funcoes/`: chat_iniciar, chat_responder, chat_enviar, chat_voltar, fluxo_avancar, fluxo_proximo, fluxo_aplicar, fluxo_perguntar, fluxo_finalizar, fluxo_transferir, fluxo_pos_responder, fluxo_assunto_aplicar, klingo_pode_marcar
- `docs/`: DOCUMENTACAO.md, fase7-motor-implementado.md, klingo-autoatendimento.md, autoencerramento.md
