# Aba Médicos (05/11/2026, v1.1)

Aba só do administrador no painel. Mostra cada médico por unidade com a agenda do Klingo (relatório #13984, já sincronizado) **já preenchida**, e deixa limitar dias e horário (ex.: só segunda e quarta; só das 8h às 12h).

- **Regra = filtro sobre a grade do Klingo.** Só reduz: o chat nunca oferece horário que o Klingo não tem. O atendimento precisa terminar até a hora final. Sem regra, vale o Klingo. Tabela `medico_regra` (a sincronização não apaga).
- **Atende / Bloqueado no chat:** usa o bloqueio que já existe (`profissional_bloqueio`, `supabase/agenda-medica-bloqueio.sql`, PR #69). Bloquear avisa quem já tinha escolhido o médico.
- **Aviso de mudança:** ao fim de cada sincronização da agenda, o banco compara com a grade que a equipe conferiu por último (`medico_base`). Mudou, médico novo ou médico que saiu → aviso pendente + selo vermelho no menu "Médicos".
  - *Aceitar e atualizar a agenda:* vale a grade nova (a regra de dias/horas do médico sai; a observação fica).
  - *Manter como estava:* a grade anterior vira regra, e o chat segue oferecendo só o que valia. Em médico novo, "Não liberar" bloqueia no chat.
  - O primeiro uso só guarda a base: nenhum aviso falso para a agenda de hoje.
- Salas e equipamentos (RM, TC, RX, ultrassom, mamografia…) ficam escondidos e não geram aviso.
- Não depende dos relatórios pendentes do Klingo (usa só o #13984 e o catálogo de procedimentos, que já existiam).

## Os três módulos (v1.1)

**A. 🔔 Pendência de Validação (exame novo ligado ao médico).** Quando a sincronização traz um exame ou consulta que o Klingo ainda não ligava a um médico já conferido, aparece no topo da aba: "O médico X aceitou realizar o exame Y via Klingo. Deseja validar esta regra para os próximos agendamentos?" com **Confirmar e Ativar** (grava a validação) ou **Ajustar Regras Antes de Ativar** (abre o médico para ajustar horários e convênios; depois volta e confirma). O selo vermelho do menu "Médicos" conta médicos com pendência + avisos de grade. Médico novo continua tendo só o aviso de médico (os exames dele entram na base quando a equipe responde). O primeiro uso só guarda a base: nenhuma pendência falsa.
  - Importante: enquanto a pendência está aberta o chat **já usa** o que o Klingo mandou (igual ao aviso de grade). Para segurar um médico, use o interruptor "Atende/Bloqueado".

**B. Convênios e particularidades** (botão "Particularidades" → aba *Convênios e particularidades*).
  - Uma chave liga/desliga por convênio para aquele médico (vale na hora).
  - "Não aceitar neste exame": o médico aceita o convênio em geral, mas não para um exame específico (a lista traz só os exames que o Klingo liga a ele).
  - **Atendimento 100% particular**: convênios deixam de ver o médico; quem escolhe Particular sempre vê.
  - Convênio desligado na aba *Convênios* (clínica toda) aparece travado.
  - Como o chat aplica: lê o convênio da conversa (`pre_agendamentos.plano`, via `app.conversa`, que o chat já grava antes de pedir horários). Sem convênio ou Particular = sem filtro. Exame do pedido com restrição tira o médico daquele pedido.
  - O Klingo quase não preenche a coluna "operadoras" da agenda (40 de 16.446 linhas), por isso a regra por médico é manual no painel.

**C. Horários por dia e folgas.**
  - *Horários por dia*: uma linha por dia da semana, já preenchida com a grade do Klingo; cada dia pode ter mais de um turno (ex.: 08:00–12:00 e 14:00–18:00) ou ficar indisponível. Só reduz a grade do Klingo; o atendimento precisa terminar até a hora final do turno. Salvar uma grade igual à do Klingo apaga a regra. A grade por dia substitui a regra simples de dias/horas (a observação fica).
  - *Folgas e bloqueios*: datas (um dia ou período) em que o médico não atende em nenhuma unidade (folga, congresso, feriado). O chat deixa de oferecer horários nelas. Quem já tem horário marcado nesse dia **não** é avisado automaticamente.
  - Aceitar uma mudança de grade do Klingo apaga também os turnos por dia daquele médico/unidade.

## Como aplicar (SQL Editor ou migração em partes; o arquivo não tem `drop`)
1. `supabase/agenda-medica-bloqueio.sql` (as partes 1, 2 e 3a já estão no banco; falta a **3b**: `profissional_bloquear` e `profissional_liberar`).
2. `supabase/medicos-regras.sql`, seções 1, 2, 3 e 4, nessa ordem.
3. Publicar o painel (`painel/index.html`).

Para a v1.1 reaplique o `supabase/medicos-regras.sql` (seções 1, 2, 3 e 4, em partes; tudo é `create or replace`/`if not exists`) **antes** de publicar o painel. A seção 3 recria `agenda_horarios` (o chat passa a respeitar turnos, folgas e convênios) e a 4 traz as funções novas: `medico_detalhe`, `medico_turnos_salvar`, `medico_excecao_salvar/remover`, `medico_convenio_salvar`, `medico_particular_salvar`, `medico_proc_resolver`.

Testes: `npm run test:medicos-sql` (69 casos, banco embutido) e `npm run test:medicos` (9 casos, navegador).
