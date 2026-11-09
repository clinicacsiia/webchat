# Avaliação voluntária do atendimento (WC-09 e WC-10, 09/11/2026)

**Estado: pronto no repositório e testado. O SQL ainda NÃO foi aplicado. NÃO ligue antes de o jurídico revisar a privacidade (D5).** Arquivo: `supabase/avaliacao.sql` (depois de `encerramento-motivo.sql` e `despedida.sql`).

## O que o paciente vê
Abaixo da despedida aparece o botão **Avaliar o atendimento**. Ele é opcional: ao tocar, abre um formulário com
1. "De 0 a 10, como foi o seu atendimento?"
2. "De 0 a 10, como você avalia o nosso site?"
3. "Por onde você nos conheceu?" (WhatsApp, Instagram ou Google)

Botões **Enviar avaliação** e **Agora não**. Ignorar, sair da tela ou falhar o envio **não mexe** na conversa encerrada. Depois de enviar, aparece "Obrigado pela sua avaliação!" e o botão não volta. Teclado, leitor de tela e letra grande funcionam; os alvos têm no mínimo 44 px.

## Regras (decisões D4 e D5)
- Convida em todo fechamento que tem despedida, **menos Não respondido** (encerramento automático).
- **0 é nota válida.** Aceita só inteiros de 0 a 10 nas duas perguntas e um dos 3 canais.
- **Uma avaliação por fechamento** (conversa + instante do encerramento). Repetir a mesma solicitação responde "ok" sem gravar de novo. Reabrir e encerrar de novo gera outro convite.
- Só quem tem o **token da própria conversa** avalia. A tabela `avaliacao_atendimento` **não tem nome, telefone nem texto livre**, e quem usa a API não a lê direto.
- Administrador vê **contagens e médias** na aba **Indicadores** (Avaliações dos pacientes) e, para administrador e atendente, os **Motivos de encerramento**.

## Chave (começa desligada)
Configurações > Encerramento e avaliação > "Convite para avaliar o atendimento" (`config.avaliacao_ativa`). Desligada, o botão some e a gravação é recusada na hora.

## Pendência do jurídico (D5)
A avaliação guarda um dado novo (duas notas e o canal, sem identificação). Antes de ligar, o jurídico deve revisar a `privacidade.html` (item 5, retenção). Sugestão de texto para a revisão:

> **Avaliação do atendimento (opcional).** Depois de encerrar um atendimento, você pode dar duas notas de 0 a 10 (atendimento e site) e dizer por onde nos conheceu (WhatsApp, Instagram ou Google). Não pedimos nome, telefone nem comentário. Usamos as notas apenas para melhorar o serviço, em números agregados. Responder é opcional e não muda o seu atendimento.

Eu **não** alterei `privacidade.html`, porque o texto jurídico só muda com revisão.

## Como colocar no ar
1. Aplicar `supabase/avaliacao.sql`. 2. Publicar o site (chat `sw.js` v14, painel v9). 3. Jurídico revisa a privacidade. 4. Ligar a chave. 5. Fechar uma conversa de teste e avaliar.

## Testes
`npm run test:avaliacao-sql` (11) e `npm run test:avaliacao` (9, chat: ignorar, 0 e 10, falha e repetição, clique duplo, teclado, celular com letra grande).
