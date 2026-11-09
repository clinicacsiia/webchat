# Topo da conversa mais baixo (WC-07, 09/11/2026)

**Só tela (`painel/index.html`); sem SQL.** Medido no navegador com um paciente de nome e e-mail muito longos (o pior caso), somando o topo, a faixa "Próximo passo" e o botão de detalhes:

| Tela | Antes | Depois |
|---|---|---|
| 1280×720 | 176 px | 90 px |
| 1366×768 | 188 px | 94 px |
| 1920×1080 | 123 px | 94 px |
| Celular 390×780 | 232 px | 163 px |

## O que mudou
- **Computador (a partir de 641 px):** nome e contato em uma linha, com reticências quando não cabem; paddings menores nas telas com altura acima de 720 px; a faixa "Próximo passo" também em uma linha. O texto completo continua no `title` do bloco do paciente e do passo, e o bloco do paciente recebe foco por teclado (`aria-label` com tudo).
- **Celular:** o contato mostra 2 linhas; tocar no nome (ou Enter) **abre tudo** e toca de novo recolhe. O telefone continua sendo link do WhatsApp.
- **Não mudou:** o tamanho da letra das mensagens, os botões Assumir/Reabrir/Transferir/Encerrar, a coluna lateral de 1280 px e a área de detalhes recolhível.

## Teste
`cd testes && npm run test:cabecalho` (7 verificações). As alturas "antes" ficam no teste; ele falha se o topo voltar a ocupar mais de (antes − 20 px).
