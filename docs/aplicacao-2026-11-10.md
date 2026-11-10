# Aplicação do planejamento — 10/11/2026

Versão 1.0 — 10/11/2026 / Mudança: primeira rodada de implementação (Etapas 0 e A) conforme `docs/planejamento-auditoria-2026-11-10.md` e as decisões do dono.

Este documento diz **o que já está no ar**, **o que só está no repositório esperando publicação**, **o que ficou parado** e **como desligar ou voltar atrás** cada coisa.

## 1. Já está no ar (banco e funções do Supabase)

| O quê | Efeito | Como desligar ou voltar |
|---|---|---|
| Lista de horários rápida (`agenda-horarios-rapido.sql`) | `agenda_horarios_klingo` usa a versão nova: mesmo resultado em 42 combinações no banco real; ultrassom de 45 dias de **6,9 s para 0,28 s** (o limite do chat é 3 s). O erro `CSI-261110-1126-RPC-2MXV` era esse estouro | A definição antiga está guardada em `agenda_horarios_klingo_v1`. Voltar: `create or replace function public.agenda_horarios_klingo(...)` com o corpo da `_v1` |
| Agenda ao vivo (`agenda-ao-vivo.sql` + Edge Function `chat-agenda-ao-vivo`) | Lê o Klingo (relatório #7) **na hora** em que a paciente chega ao calendário; libera horário cancelado; trava contra relatório vazio ou cortado; uma leitura por dia ao mesmo tempo | `update public.config set valor = 'nao' where chave = 'agenda_ao_vivo';` (o chat mostra o que o banco já tem, com aviso). Validade de reaproveitamento: `agenda_ao_vivo_validade_s` (15 s; 0 = sempre ler) |
| Médico disponível ao vivo (`chat_medicos_disponiveis`) | Devolve o próximo horário livre de cada médico do passo "Tem preferência de médico?" | Sem uso até o chat novo ser publicado |
| Klingo a cada **30 s**, sem sobreposição (`klingo-30s.sql`) | Jornada (`jornada-klingo-30s`) e reconhecimento de agendamentos (`agendamento-reconhecer-klingo`) a cada 30 s; só uma leitura por vez; erro → nova tentativa em 30 s (4 primeiras falhas), depois 2 min, depois 10 min. Ocupação também de madrugada (`agenda-ocupacao-noite`, a cada 30 min) | `select cron.unschedule('jornada-klingo-30s');` e `select cron.alter_job((select jobid from cron.job where jobname = 'agendamento-reconhecer-klingo'), schedule := '*/10 * * * *');` |
| Reconhecimento pelo **prontuário já conferido** (Edge Function `klingo-reconhecer` v1.1) | A marcação do Klingo com o prontuário que o chat/equipe já conferiu vale mesmo com nome ou telefone diferentes (caso do nome corrigido só no Klingo). Em simulação: **9 pedidos** passam a ser reconhecidos, nenhum ambíguo; 5 ficam "só o telefone bate" (vínculo manual) | Chave `agendamento_reconhecer = nao` desliga o reconhecimento inteiro |
| Etapa 0 (`etapa0-eventos-e-teste.sql`) | Linha do tempo da conversa (`conversa_evento`), `primeiro_humano_em` (190 de 199 conversas; só 9 nunca tiveram uma pessoa), marca de teste, contato de teste | Ver o cabeçalho do arquivo (ROLLBACK) |
| Indicadores v2 (`indicadores-v2.sql`) | Funções `painel_indicadores_v2`, `_jornada_v2`, `_extras_v2` + tabelas do congelamento (**desligado**) | As funções antigas continuam; o painel antigo segue funcionando |

## 2. Só no repositório, esperando a publicação (branch `claude/dazzling-goodall-gw9a7f`)

| Arquivo | O que muda para quem usa |
|---|---|
| `index.html` (chat do paciente) | Calendário confere o Klingo ao abrir, ao tocar no dia e ao confirmar; lista de médicos mostra o próximo horário; aviso quando não deu para conferir (com "Conferir de novo") |
| `painel/index.html` (painel da equipe) | Indicadores novos (período livre; pessoas atendidas, reentradas, sem atendimento humano, concluídas pela data real, pedidos e agendamentos com autoria); **sem** "Conversas por pessoa (média)" e **sem** "Confirmaram"; cartões do topo na mesma regra; selo "Teste" |

Publicar = juntar a branch na `main` (GitHub Pages). Os dois arquivos são compatíveis com o banco **já aplicado**.

## 3. Parado, esperando você

1. **Migração `agendado-autoria.sql`** (quem confirmou o agendamento: sistema × atendente): a ferramenta de migração pediu uma confirmação que **ficou sem resposta** e a migração **não foi aplicada**. Até ser aplicada, `painel_indicadores_extras_v2` (que já está no banco) devolve erro de coluna inexistente; **nada usa essa função ainda**, então não há efeito para a equipe. O arquivo já foi trocado para `create or replace trigger` (sem `drop`).
2. **Lista de 30 conversas de teste do passado** (arquivo CSV enviado na conversa): a regra "conta de teste" só marca o passado depois da sua confirmação. 3 são "mistas" (equipe também respondeu).
3. **Congelamento dos indicadores** (`config.indicadores_fechar = 'nao'`): ligar **depois** de confirmar a lista de testes. Ao ligar, a rotina das 00:10 fecha em ordem os dias que já passaram e eles não mudam mais.

## 4. Ainda não feito (depende de decisão ou de próxima rodada)

- Fluxo "nova conversa / voltar ao tema" no chat, motivo da reentrada, janela única de 2 dias, aceite de "previsão" no início (Q-04, Q-05, Q-10) — decisões fechadas, **falta implementar** (mexe no chat e em `chat_iniciar`).
- Aviso e registro do encerramento por inatividade na equipe; transferência reiniciando as 24 h (Q-04).
- Estrutura (unidades, equipes, supervisora, gerência), permissões no servidor, transferência para unidade e em lote (Etapa B): **faltam os nomes das atendentes de cada supervisora e os e-mails de Juliana e Luzia**; a Carla Adrielle teria de deixar de ser administradora.
- Sino e avisos do paciente (NOT-01/02), convênio suspenso (CAT-01), cardápio só com preço particular (CAT-02), indicadores por gerência/unidade/equipe/atendente (MON-01), vínculo manual supervisionado (AGE-02).

## 5. Correções do que eu tinha dito antes

- Eu afirmei que escolhas de outros pacientes não seguravam o horário. **Estava errado**: já existem reservas provisórias (pedido pronto 48 h, rascunho 90 min, agendado +20 min). Nada foi encurtado.
- Eu disse que 20% das conversas não tinham atendimento humano. Contando **"a pessoa assumiu"** como atendimento (e não só "respondeu"), são **9 de 199 (≈5%)**; 30 foram assumidas e nunca respondidas.
- O dono escreveu "Tasy": não há Tasy no código; tratei como **Klingo**.
- Testes antigos que **já falhavam antes** das mudanças (mesmo resultado com os arquivos originais): `test:sentinela-navegador` (17/19), `test:login` (19/23) e `test:jornada` (16/17).

## 6. Como conferir

`cd testes && npm install && npm test` repete tudo. Novos nesta rodada: `test:ao-vivo-sql` (18), `test:ao-vivo` (13 no navegador), `test:etapa0-sql` (17), `test:indicadores-sql` (20), `test:indicadores` (16), `test:autoria-sql` (5), e `casar.test.ts` (17) e `agrupar.test.ts` (6) em `test:edge`.
