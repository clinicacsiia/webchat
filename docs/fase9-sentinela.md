# Fase 9: Sentinela do chat, correções do teste da paciente e mensagens empáticas

Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial

## O que a paciente de teste encontrou e o que causava cada problema

| O que aconteceu | Causa encontrada no código | O que mudou |
|---|---|---|
| Conversa com "coisa antiga" e foi preciso sair e voltar | O chat reabria com a **cópia de mensagens guardada no aparelho** (`webchat.msgs.v1`), sem saber de que versão do chat ela veio, e o service worker abria a página pela cópia guardada sem avisar quando havia versão nova | A cópia ganhou a marca da versão (`VERSAO_APP`): cópia de outra versão é descartada e a conversa vem do servidor. O service worker agora avisa a página quando a versão da rede é outra (ETag) e a página atualiza no formulário vazio ou oferece "Atualizar agora" no meio da conversa. Conversa parada há mais de 6 h com pergunta aberta pergunta se a pessoa quer continuar ou começar um pedido novo |
| Tocou em "Exame", a resposta apareceu **antes** da mensagem dela e a conversa "bugou" | `chat_responder` devolve a mensagem do paciente **e** a resposta. O chat apagava a bolha provisória e só depois desenhava as duas. Se o aviso instantâneo trouxesse a resposta antes da chamada voltar, ela ficava na tela acima da mensagem do paciente. A pergunta nova era então tratada como "já respondida" (vinha antes da última fala do paciente) e ficava apagada. Além disso, o cursor de consulta (`p_apos`) avançava pelo aviso instantâneo e podia **pular** a mensagem do paciente para sempre | A mensagem oficial do paciente **assume o lugar da bolha provisória**; mensagem que chega depois de uma mais nova é encaixada pelo número do banco; o cursor `p_apos` só anda pelo que a **consulta ao servidor** entregou |
| A lista do desenho do corpo estava "feia" | Grade `1fr auto auto` sem agrupamento: botões de tamanhos diferentes e colunas que não alinhavam | Lista agrupada (Cabeça e pescoço, Tronco, Braços e mãos, Pernas e pés, Coluna), nome à esquerda e dois botões do mesmo tamanho (Direito, Esquerdo) à direita |
| Opções do pedido de exames sem padrão | Chips, checkboxes e rádios pequenos misturados | Três passos numerados (Tipo, Parte, Exame); tipo de exame em botões grandes iguais; parte do corpo por **Desenho** ou **Lista** (alternância no topo); exames em cartões grandes iguais |
| No final não ficou claro que é previsão, que um atendente atende e que a confirmação vem depois | Texto `pronto_online` dizia só "Recebemos tudo" | Mensagem final, cartão de acompanhamento e textos do assistente dizem: é uma **previsão**, **ainda não está confirmada**, **uma pessoa da equipe** envia a confirmação de data, horário e valor neste chat, e dá para escrever a qualquer momento |
| Letra pequena | Muitos textos de 11 a 14 px | Todos os tamanhos subiram (mínimo 13,5 px; texto corrido 17 px) e o menu (⋮) tem "Letra maior", em três níveis, guardado no aparelho |
| Faltava avisar que é uma IA e que um humano acompanha | Nada dizia isso | Aviso na tela inicial, aviso fixo no topo da conversa, status "Assistente virtual (IA) · equipe acompanhando" e botão "Falar com um atendente" sempre à vista |

## Sentinela (`sentinela.js`)

Fica de olho na conversa, ajuda quem trava e deixa um código para rastrear. Se o arquivo não carregar, o chat funciona igual.

| Regra | Como detecta | O que faz sozinha | O que o paciente vê | Código |
|---|---|---|---|---|
| Mensagens fora de ordem | números de `data-id` na tela não crescem | refaz a conversa na ordem do banco | "Organizei as mensagens" | `ORD` |
| Resposta demorando | bolha do paciente pendente, ou última fala é do paciente e o assistente não respondeu, além do limite aprendido | consulta o servidor de novo | aviso; ao dobrar o limite, botões "Conferir de novo" e "Chamar um atendente" | `LNT` |
| Tela travada | pergunta ativa com todos os botões desligados e nenhuma chamada em andamento | religa os botões e recarrega | só se não curar: "Recarregar a conversa" | `TRV` |
| Falha ao falar com o servidor | chamada do Supabase com erro (status 0, 4xx, 5xx) | — | pede desculpas e oferece "Tentar de novo" e "Chamar um atendente" | `RPC` |
| Pergunta já respondida | erro `22023` | recarrega a conversa | "Atualizei a conversa" | `DES` |
| Erro de JavaScript | `error` e `unhandledrejection` | — | "Algo não saiu como esperado" | `JS` |
| Paciente parado | sem toque há 3× a mediana da etapa (60 a 180 s) | — | "Posso ajudar?" com uma dica da etapa e botão de atendente (uma vez por pergunta) | sem código |
| Conversa antiga | última mensagem há mais de 6 h com pergunta aberta | — | "Continuar ou começar um pedido novo?" | sem código |
| Sem internet | `offline` | volta a consultar quando a internet volta | "Não se preocupe, o que você fez está guardado" | sem código |

### Código de rastreio

Formato: `CSI-AAMMDD-HHMM-TIPO-XXXX`, por exemplo `CSI-261031-1432-RPC-AB23` (data e hora **do aparelho do paciente**; as letras do final não usam 0, O, 1, I, L para dar para ditar por telefone). Aparece na faixa acima do campo de mensagem, com botão "Copiar", e no menu (⋮) > "Código de suporte" (que gera um código `DIA` de diagnóstico quando não houve erro).

Cada erro vira um incidente enviado ao Supabase (`public.incidente_chat`) com: tipo, etapa, versão do chat, id da conversa (se o token for o da própria conversa), tempos e status das últimas chamadas, últimos 25 eventos e o estado da tela. A conversa também ganha uma **nota** para o atendente ("Problema técnico no chat do paciente, código ...").

**Para achar um caso:** painel > Aprendizado > "Problemas técnicos do chat", digitar o código (ou só o final). Ou no SQL: `select * from public.incidente_chat where codigo like '%AB23%';`

**Privacidade (LGPD):** a Sentinela **não** guarda o texto das mensagens, CPF, telefone, e-mail nem o token. Números com 6 ou mais dígitos e e-mails são mascarados antes de gravar. Coberto por teste.

### O que "aprende"

É um aprendizado **local e simples**, não um modelo de IA: cada aparelho guarda os tempos das chamadas (últimas 40 por tipo) e o tempo que as respostas levam em cada etapa (últimas 20). "Lento" passa a ser 2,5× o p90 do que aquele aparelho já viu (8 a 30 s) e "parado" passa a ser 3× a mediana da etapa (60 a 180 s). Também conta em quais etapas as pessoas mais param (`Sentinela.relatorio()` no console). Não aprende nada entre aparelhos.

## Como colocar no ar

1. **Publicar** o repositório no GitHub Pages (já é assim): `index.html`, `sentinela.js` e `sw.js` mudaram.
2. **Rodar no Supabase** (SQL Editor) o arquivo `supabase/fase9-sentinela.sql`. Pode rodar mais de uma vez. Ele cria a tabela e as funções de incidentes e troca os textos do assistente (abertura, confirmação, mensagem final, transferência, erro) **somente os que ainda são os originais da Fase 7**; textos que a equipe já editou no painel ficam como estão.
3. Antes do passo 2 o chat funciona normalmente: os incidentes ficam guardados no aparelho e são reenviados quando a função existir (a Sentinela tenta de novo a cada hora).

## Testes (`testes/`)

| Comando | O que prova |
|---|---|
| `npm run test:corrida` | Reproduz o defeito da paciente: com a resposta chegando antes da chamada, a ordem é cliente, assistente e a pergunta nova fica ativa; cópia de outra versão é descartada; o cursor não pula mensagem |
| `npm run test:sentinela` | Funções puras: formato do código, limiares aprendidos, ordem, classificação de erro, privacidade |
| `npm run test:sentinela-navegador` | Cada regra no navegador (travada, erro 500, 22023, lenta, fora de ordem, parada), código na tela igual ao gravado no servidor, aviso de IA, mensagem final, letra e lista do corpo alinhada |
| `npm run test:sql9` | `fase9-sentinela.sql` num Postgres embutido: grava, recusa código inválido, liga à conversa só com o token certo, limita volume, painel só para a equipe, textos trocados só se forem os originais (lidos de `fase7-motor.sql`) |
| `npm run test:sw` | Inclui o aviso de versão nova pelo ETag |

O teste da corrida **falhava antes da correção** (`ordem=AAC`, pergunta nova desativada) e passa depois.

## O que não foi provado

- O aviso instantâneo (Realtime por WebSocket) é simulado: o teste reproduz o efeito (resposta antes da mensagem) por outro caminho, mas o WebSocket real não foi exercitado.
- O SQL foi testado em Postgres embutido com *stubs*, **não foi aplicado no Supabase de produção**.
- O fluxo antigo do n8n (motor `ia`) tem texto próprio no prompt do n8n e **não foi alterado**. O texto "inteligência artificial (IA)" vale para o motor `fluxo` e para o aviso na tela.
- Os limites (6 h de conversa antiga, 60 a 180 s de parado, 8 a 30 s de lento) são ponto de partida; ajuste depois de ver os incidentes reais.
