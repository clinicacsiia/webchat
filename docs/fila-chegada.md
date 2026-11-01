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

## Push com o site fechado: ligado (01/11/2026)

- Chaves VAPID geradas; a **chave privada** está só nos segredos da função (`VAPID_PRIVADA`, em https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions/secrets) e a pública em `config.fila_vapid_publica`.
- O segredo de autenticação fica no Vault (`fila_aviso_segredo`); o banco o manda no cabeçalho `x-fila-aviso-segredo` e a função o confere. Sem ele, a função responde 401.
- Função `fila-avisar` publicada (sem verificação de JWT): https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions/fila-avisar (erros de envio em `.../logs`).
- `config.fila_push_url` aponta para a função. Testado: gatilho -> `pg_net` -> função -> 200.
- **Ainda não testado com um celular real** (precisa de um aparelho que aceitou os avisos). Para testar: abrir o portal no celular, permitir, entrar, tocar em Cheguei, bloquear a tela e chamar pela aba Fila.
- Para trocar as chaves: gerar um par novo, atualizar `VAPID_PRIVADA` e `config.fila_vapid_publica`; os celulares reinscrevem sozinhos na próxima abertura do portal.

## Ajustes

- `config.fila_aviso_antes`: quantas pessoas à frente disparam o "perto" (padrão 2).
- `config.fila_autochegada`: `nao` obriga o paciente a avisar a recepção (evita alguém tocar Cheguei de casa). O portal passa a só mostrar a posição.

## Pontos de atenção

- **Tocar "Cheguei" de longe:** hoje nada prova que a pessoa está na clínica. Se isso virar problema, desligue `fila_autochegada` ou peça ao dono do sistema para exigir um código do QR da recepção.
- **iPhone:** notificação só com o portal instalado na Tela de Início (iOS 16.4+).
- Este módulo é **separado** da fila de assinatura biométrica (`docs/fila-biometria.md`), que continua pendente.
- Testes: `npm run test:chegada-sql` e `npm run test:minha-vez` (em `testes/`).
