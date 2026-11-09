# Despedida configurável (WC-05 e WC-06, 09/11/2026)

**Estado: pronto no repositório e testado. SQL aplicado no Supabase em 09/11/2026 (tudo desligado).** Arquivo: `supabase/despedida.sql` (depende de `encerramento-motivo.sql`).

## O que muda
- Em **Configurações > Despedida do atendimento** o **administrador** escreve um texto (até 600 caracteres) e/ou escolhe uma imagem (JPG, PNG ou WebP, reduzida no aparelho), vê a **prévia** e salva. Os dois vazios = a frase de sempre ("Atendimento encerrado. Se precisar, é só mandar uma nova mensagem.").
- Cada salvamento cria uma **versão nova e imutável** (`despedida_versao`). Mudar depois **não altera** o que já foi entregue.
- Em **todo encerramento** (manual ou, depois, automático) o gatilho grava **uma** mensagem de sistema com a versão vigente. Repetir o evento não duplica (índice único por conversa + instante do fechamento).
- O chat do paciente mostra o texto como **texto puro** e a imagem com texto alternativo; a imagem só é entregue com o **token da própria conversa**. A equipe vê a mesma imagem no histórico.
- Só imagem: o texto é a frase padrão. Só texto: sem imagem.

## Chave (começa desligada)
Configurações > **Despedida do atendimento** > "Usar a despedida configurada" (`config.despedida_configurada`). Desligada, continua a frase padrão (agora marcada como despedida no histórico, o que prepara a avaliação).

## Como colocar no ar
1. Aplicar `supabase/despedida.sql` (depois do SQL do motivo).
2. Publicar o site (chat `sw.js` v13, painel `painel/sw.js` v7).
3. Em Configurações, salvar a despedida, conferir a prévia e ligar a chave.
4. Encerrar uma conversa de teste e conferir no chat do paciente.

Desfazer: desligar a chave (imediato).

## Testes
`npm run test:despedida-sql` (14), `npm run test:despedida` (4, chat) e `npm run test:encerramento` (10, painel).
