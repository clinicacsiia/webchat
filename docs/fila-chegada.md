# Fila de chegada + portal "Minha vez" (01/11/2026)

O paciente abre o portal no celular, **permite os avisos**, **entra com a conta** e toca em **Cheguei**. A recepção vê na hora, a fila mostra a posição dele, e ele é avisado quando faltam **2 pessoas** e quando é **a vez dele**.

| Peça | Arquivo |
|---|---|
| Portal do paciente (`.../minha-vez/`) | `minha-vez/index.html`, `sw.js`, `manifest.webmanifest` |
| Banco (tabelas, funções, avisos) | `supabase/fila-chegada.sql` |
| Envio do push com o site fechado | `supabase/functions/fila-avisar/index.ts` |
| Aba **Fila** da equipe | `painel/index.html` |
| Testes | `testes/sql-chegada.test.mjs`, `testes/minha-vez.navegador.mjs` |

## Como funciona

1. **Portal, passo 1:** pede permissão de notificação antes de qualquer coisa. Sem ela, o portal não segue (no iPhone só funciona instalado: "Adicionar à Tela de Início").
2. **Passo 2:** login com o mesmo e-mail e senha do chat (mesma sessão). Conta que não é de paciente é recusada.
3. **Cheguei** (`fila_cheguei`): entra na fila do dia com uma senha. A aba **Fila** do painel toca e mostra "Cliente chegou" em qualquer aba. A recepção também pode registrar quem chegou sem o celular.
4. **Posição:** quantos aguardando chegaram antes + 1. A tela atualiza sozinha (tempo real + conferência a cada 15 s).
5. **Avisos** (uma vez cada, garantido pelo banco): *chegada* ("você está na posição N"), *perto* (restam `config.fila_aviso_antes` pessoas à frente, padrão **2**) e *vez* (a equipe clicou em Chamar).
6. **Equipe** (aba Fila): Chamar o próximo, Chamar, Atendido, Tirar, Registrar chegada.

A fila **zera todo dia** (fuso de Brasília). O paciente nunca lê a tabela da fila: só a própria posição. Os avisos não levam nome nem dado de saúde.

## Estado em 01/11/2026

`supabase/fila-chegada.sql` **já está aplicado** no Supabase (em 6 partes; tabelas, RLS, funções, gatilho e tempo real conferidos). Os avisos com o portal aberto já funcionam. A recepção confirma a chegada pelo QR code do portal, por isso `fila_autochegada` fica em `sim`.

## O que falta ligar

1. ~~Aplicar o SQL~~ (feito).
2. Para o aviso chegar **com o celular bloqueado ou o site fechado** (Web Push), faça também:
   1. Gerar as chaves: `npx web-push generate-vapid-keys`.
   2. Ativar a extensão `pg_net` (Database > Extensions) e criar no Vault o segredo `fila_aviso_segredo` (um texto longo qualquer).
   3. `supabase secrets set FILA_AVISO_SEGREDO=<o mesmo texto> VAPID_PUBLICA=... VAPID_PRIVADA=... VAPID_CONTATO=mailto:seu@email`
   4. `supabase functions deploy fila-avisar --no-verify-jwt` (a função se protege pelo cabeçalho `x-fila-aviso-segredo`).
   5. No SQL: `update public.config set valor = '<URL da função>' where chave = 'fila_push_url'; update public.config set valor = '<VAPID_PUBLICA>' where chave = 'fila_vapid_publica';`
3. Publicar no GitHub Pages (a pasta `minha-vez/` já está no repositório) e divulgar o link `.../webchat/minha-vez/` (um QR code na recepção funciona bem).

## Ajustes

- `config.fila_aviso_antes`: quantas pessoas à frente disparam o "perto" (padrão 2).
- `config.fila_autochegada`: `nao` obriga o paciente a avisar a recepção (evita alguém tocar Cheguei de casa). O portal passa a só mostrar a posição.

## Pontos de atenção

- **Tocar "Cheguei" de longe:** hoje nada prova que a pessoa está na clínica. Se isso virar problema, desligue `fila_autochegada` ou peça ao dono do sistema para exigir um código do QR da recepção.
- **iPhone:** notificação só com o portal instalado na Tela de Início (iOS 16.4+).
- Este módulo é **separado** da fila de assinatura biométrica (`docs/fila-biometria.md`), que continua pendente.
- Testes: `npm run test:chegada-sql` e `npm run test:minha-vez` (em `testes/`).
