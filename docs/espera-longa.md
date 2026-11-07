# Espera longa pela equipe (07/11/2026)

**Problema:** houve esperas de 154 e 83 minutos sem nenhum alerta, e o chat dizia "a equipe está online e acompanhando". O cronômetro de resposta zerava com qualquer mensagem de `autor = 'agente'`, inclusive as do assistente virtual (que não têm `agente_id`).

## O que mudou (`supabase/espera-longa.sql`)
| Regra | Valor |
|---|---|
| O cronômetro (`conversas.cliente_aguarda_desde`) só zera com resposta de **pessoa** (`agente_id` preenchido) | Mensagem do assistente não zera mais |
| Alerta à equipe (admins e atendentes, por push) | Aos **10 min** de espera, **só em horário de trabalho**. Um push só, com a contagem ("N pacientes esperam…"), sem nome nem texto. Repete a cada 15 min enquanto durar |
| Aviso ao paciente (mensagem no chat + linha no cartão) | Aos **20 min**, **uma vez por espera**. Dentro do horário: "Estamos com muitas conversas, seu pedido segue na fila e já foi sinalizado à equipe". Fora: "No momento não estamos em horário de trabalho… entraremos em contato" |
| Cartão do paciente | **Sem relógio** e sem "a equipe está online". Mostra só o estado e, se for o caso, o aviso de fila |
| Horário de trabalho | `config.horario_trabalho` (JSON). Hoje: segunda a sexta, 8h às 18h, Brasília. Feriados não entram |

A rotina é `espera_vigiar()` (pg_cron `espera-vigia`, todo minuto). Os textos do aviso ficam em `fluxo_texto` (`espera_longa_dentro`, `espera_longa_fora`) e podem ser editados pela equipe.

Também foram trocados (só se ainda estiverem no texto original) `pronto_online`, `transferir_online`, `ola_proprio` e `ola_filho`, que prometiam "equipe online e acompanhando" e "em instantes". O status do topo do chat agora diz "Assistente virtual (IA) · atendente pelo botão abaixo".

## Para colocar no ar
1. Aplicar `supabase/espera-longa.sql` no Supabase, em partes (Parte 1 a 5).
2. Publicar a Edge Function `avisar-equipe` (versão 1.1, aceita `tipo: 'espera'`).
3. Publicar o `index.html`.
4. Depois de aplicar, rodar uma vez o recálculo da "Parte 4" de `supabase/cronometro-resposta.sql` para corrigir as conversas que ficaram com o relógio zerado pelo assistente.

Teste: `cd testes && npm run test:espera` (18 verificações).
