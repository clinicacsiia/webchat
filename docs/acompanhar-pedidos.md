# Acompanhe seus pedidos (check-in com login automático)

Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial. **Banco aplicado na produção em 15/11/2026; telas só na branch `claude/order-exam-tracking-psehjh` (publicam quando entrarem na `main`).**

**Banco:** `supabase/acompanhar-pedidos.sql` (6 partes aplicadas). **Telas:** `index.html` (botão grande e balão), `minha-vez/index.html` (o check-in, agora com os pedidos), `acesso/index.html` (volta para o check-in). **Edge Function:** `app-resultados-vigiar` (no ar, **desligada**). **Testes:** `npm run test:acompanhar-sql` (35), `npm run test:acompanhar` (20, páginas reais num Chromium), `npm run test:edge` (inclui a vigia).

## O que a pessoa vê
1. **Tela principal do chat** (quem já tem o acesso rápido salvo no celular): um **botão grande "Acompanhe seus pedidos"**, com um **balão vermelho** com o número de novidades. No chat aberto o mesmo acesso fica no menu (⋮).
2. Tocar leva ao **check-in** (`minha-vez/?acompanhar=1`) e a página **entra sozinha** com o código do aparelho. O PIN só é pedido depois de 30 minutos sem uso (regra do acesso rápido; não dá para tirar sem abrir mão da segurança).
3. Lá: **Fazer check-in com um toque** (usa nome, e-mail e celular do cadastro; só pede o e-mail se faltar) e a lista de **todos os pedidos** da pessoa e dos filhos, com filtro Todos / Eu / cada filho. Cada exame mostra o passo (Pedido → Agendado → Confirmado → Chegada → Exame feito → Laudo), a data, a hora e a unidade.
4. **Tocar no pedido oferece levar até a conversa** ("Sim, abrir a conversa"). No mesmo cartão: **Remarcar** e **Cancelar** (só exame marcado/confirmado; o cancelamento pede confirmação) e, em exame feito, **Pedir meu resultado**.
5. A tela **atualiza sozinha** a cada 20 s (e ao voltar para a aba), a partir do que o Klingo já traz para a Jornada a cada 30 s.
6. **Resultados guardados:** seção à parte com tudo que a equipe já entregou; "Ver o resultado" baixa o arquivo.

## Balão de novidades
Cada conversa guarda uma "assinatura" do que a pessoa já viu (passos, datas, resultado). Mudou o Klingo → assinatura diferente → conta 1 no balão. Ao abrir o portal por 3,5 s tudo é marcado como visto e o balão some. O que já existia quando a conversa foi ligada ao cadastro **não** conta. O balão e a recarga automática **não estendem** o PIN dos 30 minutos (`p_renova = false`).

## Como cada ação funciona (sem regra nova: reaproveita o chat)
`app_pedido_acao(token, conversa, ação, exame)`:
| Situação | O que acontece |
|---|---|
| `conversa` | Devolve o código da conversa; o portal grava no celular e abre o chat nela |
| Conversa **aberta** (com a equipe) + remarcar / cancelar / ver / resultado | A mensagem do paciente ("Quero cancelar: RM … do dia …") entra nela; ninguém é encerrado |
| Conversa **encerrada** | Abre conversa nova do mesmo paciente (`chat_nova_conversa`), responde CPF + nascimento com o cadastro, escolhe "Outro assunto" e o assunto (Remarcar / Cancelar / Minhas marcações / Resultado de exame). O resto é o fluxo do chat que já existia: consulta o Klingo, lista as marcações, regra de 24 h, confirmação, conferência |
O cancelamento e a remarcação **só valem depois da confirmação dentro do chat**, que é onde o Klingo é consultado e a marcação escolhida.

## Resultado de exame
Estados por exame feito: `aguardando` → `disponivel` → `solicitado` → `entregue`.
- **disponivel:** vem do Klingo (relatório C #14026, "laudo pronto" = data ou Id do laudo preenchido, casado pelo **Id do atendimento**), conferido pela Edge Function `app-resultados-vigiar` a cada 10 min **só se `config.app_resultado_vigia = 'sim'`**. Antes de aceitar, ela confere o **nascimento no relatório A** (prontuário do cartão da Jornada): se não bate, nunca marca. **Nasce desligada porque nunca foi provada com um laudo real.** Ligar: `update public.config set valor = 'sim' where chave = 'app_resultado_vigia';` Desligar: `'nao'`.
- **solicitado:** o paciente tocou em "Pedir meu resultado"; a conversa abre já no assunto e vai para a equipe.
- **entregue:** a equipe manda um **arquivo** (botão de arquivo do painel) ou uma **mensagem com link** na conversa do pedido; o banco marca sozinho (gatilhos em `conversa_anexo` e `mensagens`). Daí em diante a vigia **não confere mais** esse exame e o resultado fica na lista "Resultados guardados". Entrega sem arquivo nem link (ex.: "retire na recepção"): `select public.painel_resultado_entregue('<id da conversa>');` (admin/atendente; ainda sem botão no painel).
- Sem link nem senha no Klingo (limite já conhecido), a entrega é sempre pela equipe, dentro da conversa.

## Privacidade (por que a lista não aparece só com o celular)
O celular **não é confirmado** (sem SMS, decisão do dono). Por isso só entram as conversas que o aparelho **provou ter** (id + código da conversa + celular do contato igual ao do cadastro), ligadas por `app_conversa_vincular` quando o PIN está ativo. Pedidos de outros aparelhos não aparecem sozinhos. O código da conversa só sai em `app_pedido_acao`. As tabelas `app_conversa` e `app_resultado` têm RLS sem regra; as funções internas (`app_pedido_dados`, vigia) só o `service_role` executa.

## Limites conhecidos
- Pedidos feitos **antes** do acesso rápido, em outro aparelho, só aparecem se o chat deste aparelho ainda tiver a conversa (guarda as últimas 5).
- **Remarcar/Cancelar** abrem a conversa e o chat pergunta qual marcação (a escolha do exame no portal não pré-seleciona a do Klingo).
- A marcação feita pelo próprio chat também conta como novidade na primeira vez (passa de "pedido" para "marcado").
- O arquivo do resultado fica em `conversa_anexo` (limite do painel: 5 MB, 20 por conversa). Prazo de guarda: ainda não definido (jurídico, item 2.5 das pendências).
- `privacidade.html` precisa citar o acompanhamento de pedidos e a guarda de resultados (jurídico).

## Voltar atrás
Comandos no cabeçalho de `supabase/acompanhar-pedidos.sql`. Só esconder as telas: o botão some sozinho com `app_acesso_modo = 'nao'`.
