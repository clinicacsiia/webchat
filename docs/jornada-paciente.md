# Jornada do paciente no portal "Minha vez" (01/11/2026)

Arquivos: `supabase/jornada-paciente.sql` (**aplicado em produção**), `minha-vez/index.html`, testes `npm run test:jornada-paciente` (8) e `npm run test:minha-vez` (13).

Quem está logado vê, abaixo da fila, o cartão **Seus exames**: "1 de 3 exames feitos · faltam 2", uma barra de progresso e, para cada exame, 6 passos: **Pedido, Agendado, Confirmado, Chegada, Exame feito, Laudo**. Os feitos têm ✓ verde; o que está acontecendo agora gira e diz "em andamento"; cada exame tem uma frase calma ("Tudo certo! Falta só você chegar à clínica."). **Nenhum horário** aparece: só "Hoje", "Amanhã" ou o dia/mês.

## De onde vem o passo (cada exame tem o seu)

| Banco (`jornada_exame` + coluna do cartão da visita) | Passo cumprido |
|---|---|
| pedido (feito pelo chat) | 1 |
| agendado, A Confirmar / Sem Resposta | 2 |
| agendado ou confirmado, Confirmado | 3 |
| visita na coluna Chegou ou Em atendimento | 4 (em atendimento: "sendo feito agora") |
| atendido | 5 |
| atendido + visita em Laudo entregue / Faturamento / NPS / Concluído | 6 |
| cancelado, remarcado, faltou | fora da conta; aparece uma frase de ajuda |

A coluna (Chegou, Em atendimento, Laudo) é da **visita inteira**: a equipe a move à mão. Por isso, numa visita com vários exames, os que ainda não foram feitos acompanham a visita (por exemplo "em atendimento").

## Quais exames aparecem (privacidade)

- Sempre: os exames das **próprias conversas do chat** da conta.
- Exames do **Klingo**: só se a conta tem `identidade_conferida_em` (a recepção conferiu quem é: contas criadas ou liberadas por **Criar conta / Redefinir senha** ficam conferidas) **e** o nome e o telefone da conta batem com o paciente do Klingo (mesma marca de telefone usada pela Jornada). Telefone e nome são digitados pelo próprio paciente; sem a conferência, qualquer pessoa veria os exames de outra.
- Contas antigas (criadas só pelo chat) não têm a conferência: veem só os exames do chat até a recepção liberar pela fila.
- Janela: visitas dos últimos 30 dias em diante.

## Padrão visual

O portal passou a usar os tokens `--csi-*` do painel (cores, raios, sombra, fonte Inter/system-ui) com modo escuro. A biblioteca **Bootstrap** não foi adicionada: o projeto não usa framework de CSS e não há Bootstrap em nenhum arquivo.

## Limites

- A atualização é a cada 15 s (e ao abrir o portal). O dado vem do Klingo (lido a cada minuto) e da equipe.
- Laudo: o sistema ainda não guarda o laudo; o passo 6 depende de a equipe mover a visita para Laudo entregue.
- Quem fez check-in sem conta só vê a fila; os exames aparecem depois que entra na conta.
