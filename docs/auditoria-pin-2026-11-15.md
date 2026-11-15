# Auditoria do PIN no sistema todo (15/11/2026)

Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial. Pergunta da auditoria: **todo o sistema funciona no modelo novo (celular + PIN), inclusive para os cadastros antigos, e com cuidado com os novos?** Resposta de partida: **não**. O chat estava certo, mas havia portas fora do PIN. Este documento lista cada porta, o que foi fechado e o que sobra.

## Resumo
| | Antes da auditoria | Depois |
|---|---|---|
| Chat | PIN só na tela; uma cópia velha do chat no celular abria sem PIN | Tela + servidor (49 funções exigem o aparelho com PIN; trava ligável em `app_pin_servidor`) |
| Página `/acesso/` | Verde, sem logo; aceitava PIN `0000` e `1234` | Azul e logo da CSI (um programa só); recusa PIN óbvio |
| `minha-vez` | Check-in sem cadastro e entrada por e-mail e senha, sem PIN | Com PIN obrigatório: só aparelho com PIN (ou o link da fila emitido pela clínica); cadastro antigo vai criar o PIN |
| Cadastros antigos (e-mail e senha) | `conta_paciente_conversas` devolvia os **códigos das conversas** e `conta_paciente_meus_dados` devolvia **CPF e histórico** só com e-mail e senha | Essas funções exigem o PIN no servidor; a conta antiga serve só para a migração ("entra uma última vez e cria o PIN") |
| Cadastros novos | PIN de qualquer jeito | PIN óbvio recusado (1111, 1234, 4321, 1212, 1122...), 5 erros bloqueiam 1 minuto (depois 15 minutos e 1 hora), CPF obrigatório, máximo de cadastros por hora (100) |
| Cópia guardada no celular (service worker) | Servia o chat no lugar de outras páginas e a sobrescrevia | Só atende as páginas da lista (PR #190) |

## Cada porta, uma por uma
| Porta | Como o paciente chega | Estado | Onde está provado |
|---|---|---|---|
| Chat (`index.html`) | Link do WhatsApp, bio, site | **Fechada**: porta do PIN na tela + 49 funções do banco recusam sem aparelho com PIN | `test:acesso-porta`, `test:acesso-pin-total`, `test:acesso-sw`, `test:ao-vivo-pin` |
| `/acesso/` (PIN, cadastro, migração) | Redirecionado pelo chat e pela `minha-vez` | **Fechada**: é onde se cria o PIN; PIN óbvio recusado na tela e no banco | `test:acesso`, `test:acesso-pin-fraco` |
| `minha-vez` com aparelho | Link "Acompanhe seus pedidos" | **Fechada**: entra sozinho com o aparelho, pede o PIN depois de 30 minutos, manda o aparelho em toda chamada | `test:minha-vez-pin`, `test:minha-vez`, `test:acompanhar` |
| `minha-vez` sem aparelho | QR da recepção | **Fechada (com PIN obrigatório)**: vai à página do PIN em vez do check-in sem cadastro | `test:minha-vez-pin` |
| `minha-vez` com link da fila (ticket) | Link que a recepção emite para um paciente | **Aberta de propósito**: o link é uma credencial da clínica e mostra só a posição na fila | `test:minha-vez-pin` |
| Cadastro antigo (e-mail e senha) | "Entrar na conta", senha provisória da recepção | **Fechada**: a conta antiga só vale para migrar (a página `/acesso/` abre direto no passo "entra uma última vez e cria o PIN"); no banco, as funções da conta antiga exigem o PIN | `test:acesso-antiga`, `test:acesso-pin-total` |
| Check-in (`checkin_publico`, `fila_*`, `paciente_jornada`) | `minha-vez` | **Fase 2**: só passam a exigir o PIN depois de a `minha-vez` nova estar publicada (arquivo `supabase/acesso-rapido-pin-fila.sql`). Aplicar antes quebra o check-in da recepção (aconteceu por alguns minutos e foi recuado) | `test:acesso-pin-total` (fases 1 e 2) |
| Painel da equipe | Login de equipe | **Fora do modelo do paciente**: a equipe passa pela trava (papel de equipe) | `test:acesso-pin-total` |
| Funções públicas | `app_porta`, `chat_config`, `chat_saude`, `login_paciente_ativo`, `chat_incidente`, `fila_minha_vez_ticket` | Abertas de propósito (configuração, estado, relato de erro, link da clínica); não leem dado de paciente | `test:acesso-pin-total` |

## O que o servidor recusa sem PIN (com `app_pin_servidor = sim`)
- 5 de "falar com a clínica": `chat_iniciar`, `chat_nova_conversa`, `chat_irmao_iniciar`, `chat_enviar`, `chat_responder` (renovam os 30 minutos).
- 33 do chat que usam só o código da conversa (ler mensagens, enviar foto ou pedido, horários, exames, avaliação, avisos...).
- 11 da conta antiga: `conta_paciente_*` (inclui `conta_paciente_conversas` e `conta_paciente_meus_dados`) e `conta_precisa_trocar_senha`.
- Fase 2 (5): `checkin_publico`, `fila_cheguei`, `fila_minha_vez`, `paciente_jornada`, `fila_push_salvar`.
- Passam sempre: a equipe, `service_role`, as funções `app_*` (já conferem o aparelho) e chamadas internas do banco (rotinas).

## Cuidado com os novos
- **PIN óbvio** recusado na tela e no banco: `0000`...`9999` repetidos, `1234`/`4321` e as outras sequências, `1212`, `1122`. Quem já tem PIN não é mexido.
- **Tentativas:** 5 erros bloqueiam 1 minuto; 10 erros, 15 minutos; mais de 10, 1 hora (por cadastro).
- **Limite:** no máximo `app_cadastros_max_hora` (100) cadastros novos por hora.
- **CPF obrigatório** antes do PIN; cadastro principal só de maior de 18 anos; filhos ligados ao responsável.
- **Prazo do PIN:** 30 minutos sem uso (tela e servidor); o servidor não deixa o prazo ser estendido só por leitura.
- Decisão do dono (continua): **sem SMS**. O celular não é confirmado; por isso o histórico da clínica só é aproveitado quando celular + nome + nascimento batem juntos, e nunca devolve o que achou.

## O que sobra (dito com franqueza)
1. **Fase 2 da fila** (`acesso-rapido-pin-fila.sql`): aplicar depois de a `minha-vez` nova estar publicada (instruções em `pendencias-do-dono.md`, item 12).
2. **Duas Edge Functions do chat** (`ler-pedido`, que lê a foto do pedido, e `chat-agenda-api`, que lista horários) conferem só o código da conversa, não o PIN: elas usam a chave de serviço do servidor, que a trava deixa passar. Só funcionam para uma conversa que já existe (criada com PIN) e não devolvem dado de outra pessoa. Para fechar de vez: mandar o cabeçalho `x-acesso` a elas e conferir com `app_pin_conferir` (exige publicar as duas funções; não foi feito para não arriscar a publicação do código de produção sem teste ao vivo).
3. **Sem internet**, um aparelho já cadastrado abre o chat (não dá para conferir o PIN; o chat também não funciona sem internet).
4. **Novos cadastros por e-mail no Supabase Auth** continuam possíveis pela API pública, mas **não dão acesso a nada** (as funções da conta exigem o PIN). Opcional: desligar "Allow new users to sign up" em https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/auth/providers (cuidado: a recepção cria contas com senha provisória pelo banco; conferir antes se isso depende desse interruptor).
5. **Telas velhas no celular** (cópia antiga guardada) recebem `pin_obrigatorio` e precisam recarregar uma vez.

## Como conferir de novo (sempre depois de publicar)
1. `URL_VIVO=https://clinicacsiia.github.io/webchat npm run test:ao-vivo-pin` (abre o site de verdade, só lê).
2. No celular do dono: abrir o chat, entrar com o PIN, mandar uma mensagem; abrir "Acompanhe seus pedidos".
3. Tudo: `cd testes && npm test`.
