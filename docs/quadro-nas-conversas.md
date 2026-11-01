# Quadro nas conversas (01/11/2026)

> Atualização: além deste quadro (só conversas), existe a aba **Jornada**, com todos os pacientes e o monitoramento de 1 minuto. Veja `docs/jornada-monitoramento.md`. Os itens 1 e 2 do "O que ainda falta" abaixo foram superados por ela.

O quadro (kanban) **não é uma aba**. É uma segunda forma de ver as conversas, dentro do **Atendimento**: o alternador **Lista | Quadro** fica no alto da lista. A escolha fica guardada no aparelho.

## O que o atendente vê

- **Quadro:** colunas com um cartão por conversa que tem pedido de exame. Colunas de antes do agendamento: Em conversa no chat, Pedido pronto, Aguardando autorização, Agendado (veio do chat), Perdido. As de depois do agendamento (A confirmar, Confirmado, Chegou, Em atendimento, Finalizado, laudo, faturamento, NPS, Concluído, Cancelado, Remarcado, Faltou) aparecem quando houver cartão.
- **Filtros:** Todos, Meus, Aguardando, Atrasados e busca por nome ou exame.
- **Clicar no cartão** abre a conversa ao lado (no celular, ocupa a tela, com "Voltar").
- **No alto da conversa**, a barra "Etapa" mostra a coluna, o campo **Mover para…** e o **Responsável**. No computador também dá para arrastar o cartão.
- **Quem vê:** quem já vê o Atendimento (administrador e atendente). Marketing não lê conversas e continua sem ver.

## Regras que o banco impõe

- Só se move à mão para uma coluna permitida (`jornada_transicao`). Colunas do Klingo (Agendado, A confirmar, Confirmado, Em atendimento, Faltou…) não recebem cartão arrastado.
- "Perdido" pede o motivo (mínimo 3 letras).
- Se outra pessoa mexeu antes, a tela avisa ("Outra pessoa mexeu neste cartão") e relê o quadro.

## O que o painel carrega

- Só cartões **ligados a uma conversa** (`conversa_id` não nulo). Os cartões do Klingo sem conversa nunca são pedidos pelo painel.
- O quadro só é pedido ao banco quando alguém abre o modo Quadro; atualiza com a conversa (tempo real) e a cada 30 s enquanto estiver aberto.
- Se o banco não tiver a visão do quadro, o painel avisa e a lista continua funcionando.

## Teste

`cd testes && npm run test:quadro` (9 verificações em navegador, com o Supabase simulado). Entrou também em `npm test`.

## O que ainda falta (nesta ordem)

1. **Klingo só para o que importa.** Decidido em 01/11/2026: não carregar o relatório inteiro. Atualizar só o **status** (chegou, confirmou, faltou, remarcou) de quem já tem conversa e dos agendamentos de hoje, usando os filtros do relatório, sem recadastrar ninguém. Hoje o banco ainda guarda 2.704 cartões do Klingo sem conversa (2.392 pacientes com nome e prontuário). **Não apaguei nada**; apagar é uma decisão separada e precisa de confirmação.
2. **Rotinas agendadas** da sincronização do chat (`jornada_conversas_sincronizar`) e da leitura do Klingo: ainda não existem no banco.
3. **Versionar no repositório** o SQL aplicado em 01/11/2026 (migrações `jornada_01` a `jornada_09`) e a Edge Function `sync-jornada-klingo`, que hoje existem só no Supabase.
4. LGPD: o texto do aviso e a regra "dado de paciente do relatório #13825 só em memória" precisam de decisão (ver `docs/pendencias-e-dependencias.md`, item A8).
5. Tarefas e checklist por cartão: o banco já tem; falta tela dentro da conversa.
