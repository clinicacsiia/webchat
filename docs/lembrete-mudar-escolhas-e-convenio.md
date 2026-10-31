# Lembrete: mudar escolhas ao vivo e convênio de quem volta

Registrado em 31/10/2026, a pedido da equipe, **para fazer depois**. Público: pessoas de 70 anos ou mais, com pouca prática no celular. Tudo precisa ser de tocar, com caixas grandes, e o sistema precisa entender e refazer as contas sozinho quando a pessoa muda de ideia.

## 1. O que foi pedido

1. **Caixas de marcar (checkbox) para todas as escolhas**, para facilitar.
2. **Mudar ao vivo**: a pessoa altera uma escolha e o sistema entende a alteração e recalcula na hora (como está tudo em tabelas, é possível).
3. **Cuidado para anular, ou não, as escolhas anteriores** que dependem da que mudou.
4. **Login automático com convênio trocado**: quem volta pelo link (cache do aparelho) pode ter mudado de convênio.

## 2. O que já existe

- **Pedido de exames**: na busca e na foto do pedido já há caixas grandes, e o total ("Enviar pedido (3 exames)") e as perguntas pendentes se recalculam a cada toque. A Fase 8 aplicou a regra "o que o paciente decidiu nunca é desfeito por uma leitura automática".
- **Correção no fim**: na confirmação existem "Corrigir o pedido", "Corrigir o plano", "Corrigir o horário" e "Corrigir os dados" (`fluxo_aplicar`, passo `confirmar`, em `supabase/fase7-motor.sql`).

## 3. Problemas encontrados no código (para corrigir)

1. **O convênio de quem volta é copiado sem perguntar.** Em "Repetir o último exame", `pre_reaproveitar` faz `plano = coalesce(pa.plano, <plano do pedido anterior>)` (`supabase/fase4-paciente-que-volta.sql:156`). Com o plano preenchido, o motor pula a pergunta do plano (`fluxo_proximo`: `if pa.plano is null then return 'plano'`). Quem trocou de convênio segue com o antigo até a leitura final, e só percebe se ler com atenção.
2. **"Os dados continuam os mesmos" também mantém a carteirinha antiga**, mesmo que o convênio tenha mudado.
3. **"Corrigir o plano" apaga só o plano.** O horário escolhido (`escolha_horario`) e a carteirinha (`matricula`) continuam, mas podem depender do convênio: a unidade ou o médico podem não atender o convênio novo, a carteirinha é de outro plano e o preparo ou a autorização podem mudar.
4. **"Corrigir o pedido" não refaz o horário.** Trocar RM por TC muda a duração e a sala (`agenda_regra_duracao`, `agenda_modalidade_local`), e o horário guardado pode não servir mais.

## 4. Proposta

### 4.1 Mapa de dependências: o que cada mudança anula

Uma tabela pequena no banco (ex.: `fluxo_dependencia`) diz o que cai quando algo muda. O motor aplica a regra sozinho, sem a pessoa precisar entender:

| Mudou | Anula sempre | Confere e só anula se não servir mais | Mantém |
|---|---|---|---|
| Exame (incluir, tirar, trocar) | — | Horário: duração, sala e se o médico faz o exame; preparo | Plano, dados |
| Lado do exame | — | Quantidade (bilateral = 2 unidades) | Horário, se a duração couber |
| Plano / convênio | Carteirinha | Horário: o médico ou a unidade atende o convênio? Exame coberto? | Exame, dados pessoais |
| Unidade ou médico | Horário | — | Exame, plano |
| Data de nascimento (adulto ↔ criança) | — | Unidade (Desenvoar ↔ CSI) e exames pediátricos | Plano |

Quando algo é anulado, a pessoa vê **por que** em uma frase, por exemplo: "Como o convênio mudou, escolha o horário de novo: o Dr. Fulano não atende Bradesco." Nunca anular em silêncio.

### 4.2 Resumo vivo em vez de "Corrigir" só no fim

- Um cartão "Seu pedido" fixo no alto do chat, com as caixas já marcadas (exames, lado, plano, unidade, horário). Tocar numa linha abre só aquele pedaço para mudar.
- Ao mudar, o servidor recalcula numa chamada só (`chat_alterar(conversa, campo, valor)`): aplica o mapa da seção 4.1, refaz o que depende e devolve o resumo novo, já com os avisos. Nada de recomeçar a conversa.
- O que caiu volta como pergunta aberta (ex.: o horário aparece vazio, com "Escolher de novo").
- Toda mudança fica registrada (`fluxo_evento`), para a equipe ver o que a pessoa trocou e quando.

### 4.3 Convênio de quem volta (login automático)

- Ao reaproveitar o pedido anterior, **não copiar o plano em silêncio**. Perguntar com dois botões grandes: "Seu convênio continua sendo **Bradesco Saúde**?" com "Sim, continua" e "Não, mudou". Se mudou, abrir a lista de convênios com o filtro.
- Se o convênio mudou: a carteirinha é pedida de novo (aplica a seção 4.1) e "os dados continuam os mesmos" deixa de valer para a carteirinha.
- Mesmo cuidado na tela "Olá de novo, {nome}!": o convênio aparece junto dos dados guardados para a pessoa conferir com um toque.
- Opcional: se a carteirinha tem validade guardada e já venceu, perguntar mesmo que o convênio seja o mesmo.

### 4.4 Para quem tem 70 anos ou mais (vale para tudo)

- Caixas e botões de pelo menos 48 px de altura, letra de 17 px ou mais, uma pergunta por vez.
- Toda escolha pode ser desfeita com um toque e nada é apagado sem avisar.
- Sempre há a saída "Não sei, quero falar com o atendente".
- Mensagens curtas, sem sigla ("Ressonância", não "RM").
- Testar com 3 a 5 pessoas de 70 anos ou mais antes de ligar para todos, observando onde travam.

## 5. Ordem sugerida

1. Convênio de quem volta (4.3): é o risco maior, porque um agendamento no convênio errado gera glosa e retrabalho. A mudança é pequena: o motor e `pre_reaproveitar`.
2. Mapa de dependências (4.1) aplicado aos "Corrigir…" que já existem.
3. Resumo vivo com mudança em qualquer ponto (4.2).
