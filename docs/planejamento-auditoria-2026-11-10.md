# Auditoria e planejamento de mudanças — Webchat e integração Klingo

Versão 1.0 — 10/11/2026 / Mudança: diagnóstico inicial, matriz de requisitos e plano (nada implementado)

**Escopo:** responder à "Solicitação de auditoria e planejamento de mudanças v1.0 (10/11/2026)". **Nenhuma linha de código, tabela, permissão ou dado foi alterada.** No banco real só houve leituras de estrutura e **contagens** (nenhum nome, telefone, CPF ou texto de conversa foi lido ou copiado para cá).

**Como ler os selos**

| Selo | Significa |
|---|---|
| **FATO** | Visto no código deste repositório ou consultado no banco real em 10/11/2026 (com a consulta descrita). |
| **HIPÓTESE** | Causa provável, ainda não provada. Sempre vem com "como confirmar". |
| **DECISÃO** | Regra de negócio que o código não responde. Precisa do dono (lista na Fase 8). |

> **Aviso obrigatório sobre os relatórios do Klingo** (regra do `CLAUDE.md`): os 5 relatórios A–E e o #14359 já existem. Mas **4 perguntas ao suporte do Klingo continuam sem resposta** (`docs/klingo-relatorios-pendentes.md`) e afetam este plano:
> 1. Onde fica o **preço Particular** (o relatório D #14027 não traz) → trava **CAT-02**.
> 2. Se existe campo/relatório de **convênio inativado/suspenso** (o relatório E #14028 não traz situação do convênio) → limita **CAT-01**.
> 3. **Última atualização do cadastro** e **hora real do atendimento** → limitam **AGE-01** (reconciliação após correção cadastral) e **MON-01** (tempo real de atendimento na clínica).
> 4. Profundidade do histórico: o relatório B deu o **mesmo total com 3 e com 12 meses**, e o Klingo recusa períodos maiores que 12 meses por chamada → trava **REL-01** (lembrete "um ano depois").
>
> Nenhum relatório novo é necessário para a Etapa A. Os pontos acima precisam ser resolvidos antes das etapas indicadas.

---

## FASE 1 — Diagnóstico da aplicação

### 1.1 Arquitetura real (FATO)

| Camada | O que é | Onde |
|---|---|---|
| Chat do paciente | Página única em HTML/CSS/JS puro (PWA), sem framework, servida pelo GitHub Pages | `index.html` (≈209 KB), `sentinela.js`, `nomes-exame.js`, `paciente-status.js`, `sw.js` |
| Painel da equipe | Página única em JS puro (≈347 KB), mesmo estilo | `painel/index.html`, `painel/sw.js` |
| Portal "Minha vez" | Fila de chegada do paciente | `minha-vez/index.html` |
| Servidor | **Supabase** (Postgres 15 + PostgREST + Realtime + Auth + Edge Functions em Deno/TypeScript). Projeto `nrvuynjwcgwpjdptkiay` (sa-east-1) | `supabase/*.sql` (≈90 arquivos aplicados à mão), `supabase/functions/*` |
| Regras de negócio | Quase todas **no banco**: funções `security definer`, gatilhos e rotinas `pg_cron`. O "motor" que conversa com o paciente é SQL (`fase7-motor.sql`) | |
| Integração Klingo | **Só leitura**, pela API de relatórios (`/api/info/relatorio`) com `KLINGO_APP_TOKEN` (segredo do Supabase). **O sistema não marca nada no Klingo**: quem marca é a equipe | Edge Functions `sync-catalogo-klingo`, `sync-jornada-klingo`, `klingo-reconhecer`, `klingo-paciente` |
| Avisos | Web Push (VAPID) para equipe (`avisar-equipe`) e paciente (`chat-avisar`), disparados pelo banco via `pg_net` | |
| Testes | `testes/` (Node 22): Postgres embutido (PGlite) para SQL, Playwright para as páginas, `node --test` para as Edge Functions, pytest para a biometria | `testes/package.json` (≈50 suítes) |
| n8n | Desligado desde 03/11/2026 | — |

Não há servidor próprio, nem fila de mensagens, nem ORM, nem migrações versionadas pelo Supabase CLI: os arquivos `.sql` são aplicados um a um, e o histórico está nos documentos `docs/*.md`.

### 1.2 Inventário do banco (FATO, `list_tables` em 10/11/2026)

Principais tabelas e volumes atuais:

| Área | Tabelas (linhas) |
|---|---|
| Equipe | `agentes` (5): só `id, nome, email, papel, ativo`. **Papéis existentes: `admin`, `atendente`, `marketing`.** Não há unidade, equipe, supervisor nem gerente |
| Conversas | `contatos` (126, único por telefone), `conversas` (182: 3 aguardando, 32 em atendimento, 147 encerradas), `mensagens` (3.663), `conversa_encerramento` (158 — uma linha por fechamento; reabrir e fechar de novo cria outra), `conversa_grupo` (73 conversas em 24 "pessoas"), `conversa_fluxo`, `fluxo_evento` |
| Pedidos | `pre_agendamentos` (150, um por conversa), `pre_agendamento_itens`, `agendamento_fechamento`, `conversa_agendado_conferencia` |
| Pacientes | `pacientes` (55, com `dt_nasc`, CPF), `paciente_klingo_vinculo` (71, por CPF + nascimento), `pessoa_klingo_vinculo` (21, confirmado pela equipe), `paciente_historico`, `paciente_aviso` |
| Jornada (Klingo) | `jornada_paciente` (4.847), `jornada_card` (5.825), `jornada_exame` (5.798), `jornada_evento` (18.602) |
| Agenda | `catalogo_agenda` (grade semanal), `agenda_ocupacao` (horários ocupados vindos dos relatórios #7/#47), `agenda_ocupacao_meta` |
| Catálogo | `catalogo_procedimento`, `catalogo_plano`, `catalogo_preco`, `catalogo_preco_revisao`, `convenio_config` (4) |
| Ciclo de vida | `autoencerramento_execucao` (313), `autoencerramento_fechada` (0), `despedida_versao`, `avaliacao_atendimento` |
| Diagnóstico | `incidente_chat` (112 — códigos `CSI-AAMMDD-HHMM-TIPO-XXXX` da Sentinela) |

Rotinas automáticas (FATO, `cron.job`): `agenda-conferir` (15 s, quando há trabalho), `agenda-ocupacao` (10 min, **só das 05h às 22h de Brasília**), `agenda-revisar` (10 min), `agendado-vigia` (5 min), `agendamento-klingo` (10 min), `agendamento-reconhecer-klingo` (10 min), `autoencerrar-vigia` (5 min), `espera-vigia` (1 min), `jornada-vigia` (1 min), `pessoa-agrupar` (5 min), catálogo e preços (diários, 03h–03h40 de Brasília), `fluxo-exames` (diário).

Tempo-limite por papel (FATO, `pg_roles`): **`anon` = 3 s** (o chat do paciente), **`authenticated` = 8 s** (o painel), `service_role` sem limite.

### 1.3 Como cada módulo funciona hoje

**Autenticação e permissões (FATO).** Equipe entra pelo Supabase Auth; `papel_atual()` lê `agentes.papel`. As regras de acesso (RLS) olham **só o papel**:
- `conversas`: qualquer papel ativo (inclusive `marketing`) **lê todas**; `admin` e `atendente` **alteram qualquer coluna de qualquer conversa** direto pela API (`conversas_update`).
- `mensagens`, `pacientes`, `pre_agendamentos`: `admin` e `atendente` leem **tudo**.
- O filtro de unidade do topo do painel (`seletorUnidade`, `passaUnidade` em `painel/index.html` ~linha 925) é **só visual**: fica no `localStorage` e não protege nada no servidor.
- O paciente não tem login obrigatório: acessa a própria conversa por um token (`conversa_segredo`) e só por funções `chat_*`.

**Abas do painel (FATO, `montarApp`, linha ~868):** Atendimento, Jornada, Fila, Avisos, Indicadores (admin e atendente); Contatos (todos); Equipe, Convênios, Médicos, Catálogo, Aprendizado, Configurações (só admin). **Não existe aba "Guia"** (busca por "Guia" no código inteiro: nenhuma ocorrência de aba ou tela).

**Ciclo de vida da conversa (FATO).**
- `chat_iniciar` sempre cria **uma conversa nova** (com novo id) e não mexe nas anteriores; limite de 5 por hora por telefone.
- Estados de `conversas.status`: `aguardando` → `em_atendimento` → `encerrada` (pode voltar para `aguardando` ao reabrir).
- Gatilho `conversa_antes_update`: ao encerrar grava `encerrada_em = now()`, `encerramento_origem` (`equipe` ou `sistema`) e exige motivo; **ao reabrir apaga `encerrada_em`, motivo e origem da conversa** (o fechamento anterior fica só em `conversa_encerramento`).
- Gatilho `conversa_status_mudou`: ao assumir, grava a mensagem de sistema "X entrou na conversa"; ao encerrar, publica a despedida e grava `conversa_encerramento`.
- **Transferência** (`transferir`, linha ~2484): é um `update conversas set agente_id = ...` feito pelo navegador. Como o status não muda (já está em atendimento), **nenhum registro de transferência é gravado** — nem mensagem, nem tabela, nem origem/destino.
- "Uma pessoa, uma conversa" (`pessoa-unica*.sql`): conversas da mesma pessoa são **unidas por ligação** (`conversa_grupo`), sem mover mensagens. Assumir, transferir e encerrar no painel mudam **todas** as conversas unidas (`atualizarConversa`, linha ~2427).
- Encerramento automático (WC-08, `supabase/autoencerrar.sql`): **já existe e está LIGADO** (`autoencerrar_modo = ligado`, 24 h). Relógio = última mensagem de uma **pessoa** da equipe sem resposta do paciente; não fecha com exame em aberto ou remarcação pendente; motivo "Não respondido", origem `inatividade`; despedida enviada pelo gatilho. Ligado há ≈26 h (313 execuções), **fechou 0** porque nenhuma conversa completou 24 h com o novo marco.
- Painel carrega só as **300 conversas mais recentes** (`carregarConversas`, linha ~1604).

**Indicadores (FATO, `supabase/indicadores-unidade.sql`, `indicadores-jornada.sql`, `viewIndicadores` linha ~3651).**
- Períodos fixos: Hoje, Ontem, 7, 30, 90 dias e Desde o início. **Não há data inicial/final livre.**
- "Conversas", "Pessoas", "Finalizadas", "Em andamento" e a tabela "Por dia" usam **só a data de criação da conversa** (`criado_em`). "Finalizadas" é o **status de agora** (`status = 'encerrada'`) das conversas que **começaram** no período.
- "Encerramentos" e "Motivos" usam outra data: `conversa_encerramento.encerrada_em`.
- Pedidos/agendados usam `pre_agendamentos.criado_em` (data em que o pedido começou, não a da marcação).
- "Pessoa" = grupo de `conversa_grupo`; o agrupamento automático roda a cada 5 min e pode **mudar números de dias passados**.
- Unidade desconhecida aparece em **todas** as unidades (a soma por unidade passa do total).
- O texto da tela já admite: "Inclui conversas de teste da equipe".
- Não existe exportação de indicadores (a única exportação do painel é o CSV de Contatos, liberado também para `marketing`).

**Agendamentos e Klingo (FATO).**
- O paciente monta o pedido e escolhe um horário no chat (`chat_horarios` / `chat_horario_escolher`). Isso é **previsão**: a equipe marca no Klingo.
- O pedido vira `agendado` de 3 formas: botão da equipe; conferência automática pelo horário (`agenda-conferir`); reconhecimento por **nome completo + exame** (`klingo-reconhecer`, v3 de 10/11/2026), que olha os pedidos dos **últimos 14 dias** ainda sem marcação.
- Há **três vínculos pessoa ↔ Klingo separados**: `paciente_klingo_vinculo` (CPF + nascimento, 22 "confere", 7 "divergente", 44 "não encontrado"), `pessoa_klingo_vinculo` (confirmado pela equipe, 21) e `pre_agendamentos.klingo_marcacoes` (ids de marcação, 19 pedidos). **O reconhecimento por nome não usa o prontuário já conferido** (em `casar.ts` o prontuário só serve para contar cadastros homônimos).
- Horários livres: grade do Klingo (`catalogo_agenda`) menos o ocupado (`agenda_ocupacao`, relatório #7, a cada 10 min no expediente) menos as escolhas **do mesmo paciente/irmãos**. **Escolhas de outros pacientes do chat ainda não marcadas no Klingo não bloqueiam o horário** (conferido na definição em produção de `agenda_horarios` e `chat_horarios`).

**Diagnóstico (FATO).** A Sentinela (`sentinela.js`) grava cada falha do chat em `incidente_chat` com as últimas chamadas e tempos, e mostra o código ao paciente.

**Notificações (FATO).** Paciente: push por conversa (`chat_push_inscricao` por `conversa_id`); pedido de permissão em momentos fixos; **não há sino nem opção de silenciar**. Equipe: push (`avisar-equipe`), som e botão "Ativar avisos".

**Convênios (FATO, `convenios-e-foto.sql`).** `convenio_config.ativo = false` faz o convênio **sumir da lista do chat**; se o paciente digitar o nome, recebe a `mensagem_inativo`. Existe campo `motivo`. Não há estado "suspenso".

**Catálogo/preços (FATO).** Aba Catálogo > "Cardápio de preços" (`catalogo_cardapio_dados`) mostra convênio e particular. Particular é **deduzido** das marcações dos últimos 90 dias (relatório #13825), porque a tabela Particular não aparece no relatório D.

---

## FASE 2 — Matriz de requisitos

Prioridade: **P1** = corrige erro que afeta paciente ou número oficial; **P2** = controle operacional; **P3** = melhoria; **P4** = depende de validação externa.
Situação: **C** confirmado no código/dados; **PC** parcialmente confirmado; **P** pendente (falta dado ou decisão).

| ID | Área | Comportamento atual | Solicitado | Tipo | Prior. | Depende de | Arquivos afetados | Critério de aceitação | Sit. |
|---|---|---|---|---|---|---|---|---|---|
| IND-01 | Indicadores | Tudo pela data de **início**; "Finalizadas" = status atual; encerramentos por outra data | Iniciadas, encerradas, em andamento, atravessou meia-noite, >24 h, pessoas únicas, reabertas, transferidas, auto-encerradas, com datas coerentes | bug + alteração | P1 | Q-01, Q-09 (teste), TRANS-01 (para "transferidas") | `supabase/indicadores-unidade.sql`, `painel/index.html` (`viewIndicadores`) | Conversa de 09/11 23:50 encerrada 10/11 00:20 conta 1 entrada em 09/11 e 1 conclusão em 10/11; total de conclusões do período = soma dos dias; número de dia já fechado não muda sem registro | C |
| IND-02 | Indicadores | Cartão e coluna "Conversas por pessoa (média)" | Remover | alteração | P3 | — | `painel/index.html` (cartão e `COL_CHAT`); SQL pode manter o campo | Cartão e coluna não aparecem; nenhum outro número muda | C |
| IND-03 | Indicadores | Coluna "Confirmaram" (lado clínica) e cartão "confirmaram" | Remover | alteração | P3 | Q-02 (só tabela ou também cartão?) | `painel/index.html` (`COL_CLINICA`, cartões); `indicadores-jornada.sql` **sem mudança** | Coluna some; dados de confirmação seguem no banco e na Jornada; nenhuma exportação quebra (não há exportação de indicadores) | C |
| IND-04 | Indicadores | 6 períodos fixos | Data inicial e final livres, dia específico, mês anterior, mesma regra em tudo | alteração | P2 | IND-01 | mesmos de IND-01 + `indicadores-jornada.sql` | Escolher 01/10–31/10 dá os mesmos números na tabela, nos cartões e nos motivos; fuso de Brasília; nada fora do intervalo entra (exceto "em andamento agora", rotulado) | C |
| IND-05 | Indicadores | "Conversas iniciadas" mistura novas pessoas, retornos e conversas unidas | Separar entradas de pacientes, novas jornadas, novas conversas e retornos | alteração | P2 | IND-01, Q-03 | idem | Cada número tem definição escrita na tela e teste que o reproduz | PC |
| CONV-01 | Ciclo de vida | **Já existe e está ligado** (24 h, só mensagem humana conta, não fecha com exame aberto) | Encerrar após 24 h sem resposta, avisar paciente e atendente, sem duplicar | ajuste | P2 | Q-04, TRANS-01 | `supabase/autoencerrar.sql`, `despedida.sql`, `avisar-equipe` | Regra confirmada pelo dono; atendente avisado; nenhum fechamento duplo; conversa transferida ou "aguardando processo interno" tratada conforme decisão | PC |
| CONV-02 | Ciclo de vida | Despedida única para qualquer encerramento (`despedida_versao`, editável) | Mensagem própria para inatividade, com orientação para recomeçar | alteração | P2 | Q-04 | `despedida.sql`, Configurações | Fechamento por inatividade entrega o texto próprio, uma vez | C |
| CONV-03 | Ciclo de vida | Nova conversa nunca fecha a anterior; pessoa é **unida** depois (4 telefones hoje com 2+ conversas abertas) | Fechar/concluir a anterior, avisar que o histórico está salvo, abrir conversa independente | nova função (conflita com "uma pessoa, uma conversa") | P2 | Q-05 | `chat_iniciar` (base), `pessoa-unica*.sql`, `index.html` | Decisão registrada; nenhuma mensagem muda de conversa; pedido agendado não é duplicado; duas abas não criam duas conversas | P |
| CONV-04 | Histórico | Paciente vê as últimas 5 conversas **do aparelho**; equipe vê histórico do cadastro (`paciente_historico`) e conversas unidas | Histórico completo com datas, status, atendente, unidade, transferências, agendamentos, motivo | alteração | P2 | TRANS-01, PERF-02 | `painel/index.html`, nova função de leitura | Ficha da pessoa mostra todas as conversas (não só as 300 recentes) com os campos pedidos, respeitando permissão | PC |
| CONV-05 | Atendimento | Filtros Aguardando, Meus, Abertas (agrupada por atendente), Encerradas | Separar "ao vivo" de "histórico" e "por atendente", sem duplicar | alteração | P2 | PERF-02 | `painel/index.html` (`renderLista`) | Mesma conversa nunca aparece em duas listas ao mesmo tempo | PC |
| CONV-06 | Estados | Conversa encerrada como "Agendado" com pedido em `rascunho` (13) ou `pronto` (2); 100 cartões da Jornada ativos de conversas encerradas | Estados coerentes entre conversa, pedido, Jornada e Klingo | bug | P1 | AGE-03, Q-06 | `encerramento-agendado.sql`, `pessoa-unica.sql`, `painel/index.html` (`encerrar`) | Toda conversa encerrada tem pedido num estado final ou num estado "aguardando Klingo" explícito, com alerta | C |
| AGE-01 | Vínculo | Reconhecimento por nome completo; nome do pedido ou do contato; prontuário conferido por CPF não é usado; só 14 dias | Vincular corretamente após correção de nome/telefone | bug | P1 | Q-07 | `agendamento-reconhecer-v3.sql`, `klingo-reconhecer/*`, `klingo-vinculo.sql` | Caso de teste "nome errado → corrigido" vira agendado em ≤10 min, sem dado de outra pessoa | PC |
| AGE-02 | Vínculo | Equipe confirma prontuário (`pessoa_klingo_confirmar`) e pode desfazer; "Voltar para pronto" | Vínculo manual supervisionado com candidatos, ambiguidade, confirmação e auditoria | nova função (base existe) | P2 | AGE-01, PERF-04 | `pessoa-unica-jornada.sql`, `painel/index.html` | Vínculo grava quem, quando, antes e depois; recusa vincular 2 prontuários diferentes à mesma pessoa sem aviso | PC |
| AGE-03 | Klingo | Conferência por horário, reconhecimento e `agendado-vigia` já reconsultam o Klingo | Reconfirmar existência, id, paciente, data, exame, status e vínculos | alteração | P1 | AGE-01 | `encerramento-agendado.sql`, `fase3-conferencia-automatica.sql` | "Agendado" só fica verde quando o Klingo confirma; senão fica "aguardando Klingo" com prazo e alerta | PC |
| AGE-04 | Agenda | Ocupação do Klingo a cada 10 min (05h–22h); escolhas de outros pacientes não bloqueiam | Não oferecer horário ocupado | bug | P1 | Q-08 | `fase2-pedido-e-agenda.sql`, `medicos-regras.sql`, `sync-catalogo-klingo` | Dois pacientes não conseguem escolher o mesmo horário; horário marcado no Klingo some do chat em ≤ X min (X decidido) | C |
| AGE-05 | Histórico | `paciente_klingo_vinculo.historico` (resumo 12 meses) só nas notas da equipe; `klingo-paciente` tem ação `historico` | Pacientes agendados localizáveis pela conversa/histórico | alteração | P2 | AGE-01, PERF-02 | `klingo-vinculo.sql`, `painel/index.html` | Na conversa, a equipe vê os exames marcados da pessoa com status atual | PC |
| AGE-06 | Erro | Código **CSI-261110-1126-RPC-2MXV** encontrado (ver Fase 3) | Achar a falha, tratar timeout | bug | P1 | — | `chat_horarios` e funções chamadas | `chat_horarios` p95 < 1 s; zero incidentes 57014 em 7 dias de uso | C |
| AGE-07 | Envio | — | "Revisar o envio" (vago) | investigação | P3 | Q-10 | — | Dono define qual envio | P |
| PERF-01 | Organização | Só papéis admin/atendente/marketing; 5 contas | Representar TI, Gerência, Supervisão, Call Center | nova função | P2 | Q-11, Q-12 | novas tabelas + `agentes` | Estrutura cadastrada e conferida pelo dono; nenhuma conta criada automaticamente | P |
| PERF-02 | Permissões | Todos (admin/atendente) veem tudo; filtro de unidade só visual | Visibilidade por gerência/unidade/equipe/atendente, aplicada no banco | nova função | P2 | PERF-01, Q-13 | RLS de `conversas`, `mensagens`, `pacientes`, `pre_agendamentos`, `contatos`, funções `painel_*` | Atendente de uma unidade recebe 0 linhas de outra unidade pela API direta | C (falta) |
| PERF-03 | Configuração | **Aba "Guia" não existe** | Centralizar na aba Guia | conflito | P2 | Q-14 | `painel/index.html` | Dono indica a tela | P |
| PERF-04 | Segurança | `conversas_update` deixa atendente mudar qualquer coluna pela API | Matriz explícita, sem elevação, com auditoria e revogação | bug de segurança + nova função | P1 | PERF-01 | RLS e funções novas | Tentativas por id/parâmetro de outra unidade falham no servidor; supervisor não concede o que não tem | C |
| MON-01 | Indicadores | Só chat e jornada, sem atendente/equipe | Indicadores por gerência, unidade, equipe, supervisor, atendente | nova função | P3 | PERF-01, IND-01, MON-03 | novas funções SQL | Cada número com definição e teste | P |
| MON-02 | Indicadores | Indicadores recalculam tudo a cada minuto; KPIs do topo ao vivo | Separar ao vivo, histórico e consolidado | alteração | P3 | IND-01, Q-01 | idem | Ao vivo não altera período passado | PC |
| MON-03 | Atribuição | `mensagens.agente_id` por mensagem; `conversas.agente_id` só o dono atual; `conversa_encerramento.por`; transferência não registrada | Quem recebeu, respondeu, agendou, transferiu, encerrou, tempo de cada um | nova função | P3 | TRANS-01, Q-15 | nova tabela de eventos | Conversa com 2 atendentes conta 1 no total e frações corretas por pessoa | PC |
| MON-04 | Desempenho | Relato de travamento "por atendente" | Achar gargalo | investigação | P2 | Q-16 | `painel/index.html` | Gargalo medido antes de otimizar | P |
| NOT-01 | Paciente | Sem sino; push pedido em momentos fixos; inscrição por conversa | Sino com estado, silenciar, reativar, orientar bloqueio | nova função | P3 | — | `index.html`, `chat-push.sql` | Sino mostra os 3 estados; silenciar para de enviar push daquela conversa | C (falta) |
| NOT-02 | Avisos | Push para equipe em transferência para pessoa; paciente recebe push de mensagens | Avisos de nova mensagem, inatividade, transferência, agendamento, falha, responsável | alteração | P3 | CONV-01, TRANS-01 | `chat_push_trg`, `avisar-equipe` | Sem aviso duplicado; aviso sem dado sensível na tela bloqueada | PC |
| CAT-01 | Convênios | Inativo some da lista | Mostrar "Temporariamente suspenso — decisão administrativa", sem permitir agendar | alteração | P3 | Q-17, suporte Klingo (pergunta 3) | `convenios-e-foto.sql`, aba Convênios | Suspenso aparece com rótulo e não deixa seguir; desativado some; nada é gravado no Klingo | C |
| CAT-02 | Catálogo | Cardápio mostra convênio e particular (particular deduzido) | Só particular; "último exame como referência" | alteração | P4 | Q-18, suporte Klingo (pergunta 1) | `catalogo-cardapio.sql`, aba Catálogo | Só a tela muda; cálculo e alerta de preço intactos | PC |
| TRANS-01 | Transferência | Só para pessoa (lista de atendentes); sem registro; sem verificar autorização | Para pessoa ou unidade, com histórico e autorização | alteração + nova função | P2 | PERF-01/02 | `painel/index.html` (`transferir`), nova função SQL e tabela | Transferência gravada (origem, destino, quem, quando, motivo); não autorizado é recusado no servidor | C |
| TRANS-02 | Transferência | Não existe em lote | Seleção múltipla e execução segura | nova função | P3 | TRANS-01 | idem | Lote de 10 conversas: tudo ou nada, com resumo | C (falta) |
| REL-01 | Relacionamento | Não existe | Lembrete preventivo anual (mamografia etc.) | nova função | P4 | jurídico, clínico, Klingo (histórico), Q-19 | novo | Só depois de protocolo aprovado | P |
| REL-02 | Relacionamento | Não existe; `pacientes.dt_nasc` (55) e relatório A têm nascimento | Mensagem de aniversário | nova função | P4 | jurídico, canal (Q-20) | novo | Só com base legal e opção de cancelar | P |
| TEST-01 (seção 12) | Dados de teste | Nenhum marcador; Alisson é admin com 22 conversas como dono | Marcar teste sem apagar; tirar de relatórios | nova função | P1 | Q-09 | `conversas` (coluna nova), indicadores | Conversa marcada como teste some dos indicadores e continua no histórico | C (falta) |

---

## FASE 3 — Investigação de causa raiz (bugs)

### AGE-06 — Erro `csi231110-1126-rpc-2mxv` → **achado: `CSI-261110-1126-RPC-2MXV`** (FATO)
O código anotado tinha "23"; o real é **26**1110 (10/11/2026, 11:26 de Brasília). Registro em `incidente_chat` (lido só o diagnóstico técnico, sem mensagens):
- Chamada `chat_horarios` (lista de horários do calendário do chat), passo `horario`, status da conversa `aguardando`.
- Erro do banco **57014 "canceling statement due to statement timeout"**, HTTP 500, depois de **3.064 ms**.
- Sequência: `chat_horarios` OK em **2.119 ms** → paciente escolheu horário (`chat_horario_escolher` OK, 268 ms) → nova `chat_horarios` (próximo exame do pedido) → **estourou 3 s**.
- **Causa confirmada:** o papel do chat (`anon`) tem limite de 3 s, e `chat_horarios` está no limite (2,1 s numa chamada normal). Não é falha do Klingo (essa função não chama o Klingo) nem de rede.
- **Não houve risco de agendamento duplicado** nesse caso: `chat_horarios` só lê; a escolha anterior já tinha sido gravada.
- **Não é caso isolado** (contagem de `incidente_chat`, 31/10 a 10/11): timeout 57014 em `chat_responder` (10), `chat_horarios` (8), `chat_consulta_salvar` (7), `chat_corpo` (2). Também 29 falhas de rede em `chat_listar` e 6 lentidões de `chat_listar` entre 8 e 35 s (essas parecem rede do celular: tempo do servidor nas chamadas vizinhas é baixo — **HIPÓTESE**).
- **Causa técnica provável (HIPÓTESE):** `agenda_horarios_klingo` gera todos os blocos de cada dia × profissional e chama `norm_nome()` linha a linha contra `agenda_ocupacao`; o filtro de `medico_regra/medico_turno` repete `norm_nome` por linha. **Como confirmar:** `explain (analyze, buffers)` da mesma chamada em transação de leitura, com um conjunto de exames de teste; medir antes/depois.
- **Riscos da correção:** mudar o resultado (oferecer horário que não devia). Por isso o teste compara a lista de horários antes e depois para 20 combinações fixas.

### IND-01 — Divergência nas quantidades (FATO + HIPÓTESE)
Evidências (contagens no banco real):
- **74 das 147** conversas encerradas fecharam **em dia diferente** do dia em que começaram; **40** duraram mais de 24 h.
- **5** conversas foram encerradas mais de uma vez (reabertas); 60 fechamentos antigos sem motivo/origem.
- **Causas confirmadas no código:**
  1. "Finalizadas" é o status **de agora** das conversas que **começaram** no período. Uma conversa de 09/11 encerrada em 10/11 **aumenta o "Finalizadas" do dia 09/11 depois que o dia acabou** (o número do passado muda) e **não aparece** nas finalizações de 10/11.
  2. "Encerramentos" usa a data do fechamento → **dois números de "finalizadas" diferentes na mesma tela** para o mesmo período.
  3. Reabrir apaga `encerrada_em` da conversa; o fechamento antigo só fica em `conversa_encerramento`.
  4. "Pessoas" depende do agrupamento automático (a cada 5 min), que pode juntar conversas depois → muda dias passados.
  5. Unidade desconhecida conta em todas as unidades (soma por unidade ≠ total).
  6. Conversas de teste entram nos números.
- **Hipótese adicional:** o painel conta "hoje" pela lista das 300 conversas carregadas (KPIs do topo), e os Indicadores pelo banco inteiro → números diferentes entre topo e aba. **Confirmar** comparando `atualizarKpis` com `painel_indicadores_unidade(1)`.
- **Fuso:** indicadores usam `America/Sao_Paulo`, agenda usa `America/Bahia`. Hoje ambos são UTC−3 (sem horário de verão), então não há erro atual; unificar evita erro futuro.

### AGE-01 — Paciente com nome corrigido sem vínculo (HIPÓTESE forte)
Fluxo examinado: `agendamento_reconhecer_alvos` → `klingo-reconhecer/casar.ts`.
- O nome comparado é `pre_agendamentos.paciente->>'nome'` ou, se vazio, `contatos.nome`. **`contatos.nome` nunca é atualizado** (contato é único por telefone; o nome digitado fica em `conversas.nome_informado`).
- A regra exige **nome completo igual** (ou contido, com 2+ palavras). Telefone igual com nome só parecido **não conta**.
- **O prontuário já conferido por CPF + nascimento (`paciente_klingo_vinculo`, 22 "confere") e o confirmado pela equipe (`pessoa_klingo_vinculo`, 21) não entram na comparação**, mas o relatório #13825 traz o prontuário (col2). Ou seja, a forma mais estável de identificar está disponível e não é usada.
- Só pedidos dos **últimos 14 dias**, sem marcação, em `pronto`/`rascunho`.
- **Causas possíveis:** (a) a correção foi feita só no Klingo, e o chat manteve o nome errado; (b) a correção foi feita no chat em um campo que o reconhecimento não lê; (c) o pedido passou de 14 dias; (d) dois cadastros com o mesmo nome (ambíguo → nada é escolhido); (e) a marcação foi criada **antes** do início da conversa (regra recusa).
- **Como confirmar:** com autorização do dono, pegar **o caso real** (só o id técnico da conversa) e rodar `klingo-reconhecer` com `{"aplicar": false}`, que devolve o veredito sem gravar. Saber **onde** o nome foi corrigido (chat, painel ou Klingo).
- **Riscos:** aceitar mais casamentos aumenta o risco de ligar a pessoa errada. Mitigação: o prontuário conferido vira a chave **mais forte**; nome sozinho continua sem bastar quando há homônimo.

### "Jornada não encerrada após atualização" e CONV-06 (FATO + HIPÓTESE)
- **FATO:** das 30 conversas encerradas com motivo "Agendado", **15 têm o pedido em `rascunho` (13) ou `pronto` (2)**; 2 conferências de "Agendado" estão em `problema` e 2 em `verificando`.
- **FATO:** desde 09/11 (commit `5c8e661`) encerrar **nunca é barrado** por exame em aberto; a conferência acontece em segundo plano (`conversa_agendado_conferencia`). Então "conversa encerrada" e "pedido agendado" podem ficar diferentes por desenho.
- **FATO:** 100 cartões da Jornada ligados a conversas encerradas continuam ativos (pode ser intencional: o exame segue na Jornada).
- **Estados envolvidos:** `conversas.status` (3), `pre_agendamentos.status` (rascunho, pronto, agendado, cancelado) e `etapa`, `conferencia_status`, `conversa_agendado_conferencia.situacao` (verificando, confirmado, concluido, problema), `agendamento_fechamento.desfecho`, `jornada_card.coluna`, `jornada_exame.status`.
- **HIPÓTESE:** o "formulário" do relato é o cartão Pré-agendamento. **Confirmar com o dono** qual tela mostrava o estado errado (Q-06).

### AGE-04 — Horário ocupado continua disponível (FATO)
- Ocupado = relatório #7/#47 do Klingo, lido a cada **10 min**, **só das 05h às 22h**. Uma marcação feita no Klingo leva **até ~10 min** (mais o tempo do relatório) para sumir do chat. Marcações feitas das 22h às 05h só aparecem na manhã seguinte.
- **Escolhas de outros pacientes no chat não bloqueiam** o horário (a trava `pg_advisory_xact_lock` em `chat_horario_escolher` só evita gravação simultânea, não "reserva").
- A conferência de 15 s (`agenda-conferir`) grava ocupação nova só para os dias que estão sendo conferidos.
- **Como medir a latência:** comparar `agenda_ocupacao.visto_em` com a hora em que a recepção marcou (horário do relatório #13825, col3 "Agendado Em") para 1 semana.
- **Risco:** bloquear por escolha do chat pode esconder horários de pedidos abandonados; precisa de validade da reserva (Q-08).

### Timeout em pedido
Ver AGE-06 acima.

### MON-04 — Travamento por atendente (HIPÓTESE, sem evidência)
Pontos suspeitos: `renderLista` redesenha a lista inteira a cada evento de tempo real; `carregarPessoas` + `pessoa_sugestoes` (já otimizada de 4,7 s para 60 ms em 08/11); 300 conversas carregadas; o agrupamento por atendente é feito no navegador. **Como confirmar:** gravar um perfil de desempenho (Chrome DevTools) no aparelho de quem trava, e saber qual tela (Q-16).

### Encerramento incorreto por inatividade (HIPÓTESE de risco)
Até hoje **0** fechamentos automáticos. Riscos vistos no código: conversa transferida conta o relógio da última mensagem humana (não da transferência); conversa "aguardando processo interno" (ex.: autorização de convênio) fecharia. Transferência não muda o marco. **Confirmar** com a regra Q-04.

### Segregação por unidade (FATO)
Hoje **não existe** no servidor: qualquer atendente lê tudo pela API, e o papel `marketing` lê metadados de todas as conversas. O filtro do topo é só visual.

---

## FASE 4 — Proposta de arquitetura e dados

Princípio: **somar, não reescrever.** Tudo novo em tabelas e funções novas; colunas novas com valor padrão; nada apagado. Cada SQL em partes pequenas, com `create or replace` (regra do `CLAUDE.md`).

### 4.1 Modelo de dados (novo)
1. **`conversa_evento`** (linha do tempo única, só ids técnicos): `conversa_id, tipo (criada, assumida, transferida_pessoa, transferida_unidade, encerrada, reaberta, autoencerrada, agendada, vinculo_alterado), de_agente, para_agente, de_unidade, para_unidade, por, motivo, em`. Alimentada por gatilho em `conversas` (inclusive mudança de `agente_id` sem mudar status). Base para IND-01, MON-03, CONV-04, TRANS-01.
2. **Estrutura organizacional:** `org_unidade` (csi, rmtc, desenvoar + "call_center" se for equipe e não local — Q-12), `org_equipe` (nome, unidade, gerente/supervisor), `org_membro` (agente, equipe, função: `ti`, `gerente`, `supervisor`, `atendente`; vigência início/fim), `org_alteracao_log`.
3. **Marcador de teste:** `conversas.teste boolean default false` + `teste_marcado_por/em`. Marcação manual (nunca automática por nome); indicadores têm "incluir teste" desligado por padrão.
4. **Responsável por unidade:** `conversas.unidade_responsavel` (preenchida por transferência para unidade ou pela regra de unidade atual), separada de `unidade_inicial` (o que o paciente escolheu).
5. **Reserva provisória (AGE-04):** usar o próprio `pre_agendamentos.escolha_horario` dos outros pacientes como bloqueio, com validade (Q-08), em vez de tabela nova.
6. **Vínculo unificado (AGE-01/02):** visão `v_pessoa_prontuario` que junta `paciente_klingo_vinculo (confere)`, `pessoa_klingo_vinculo` e marcações reconhecidas, com prioridade: equipe > CPF+nascimento > marcação reconhecida. `vinculo_log` para cada mudança (antes/depois, quem, quando).
7. **Fechamento de período (IND-01):** `indicador_fechamento (dia, unidade, metricas jsonb, versao_regra, gerado_em)` gravado no dia seguinte. Relatório mostra o fechado e, se o recálculo de hoje diferir, mostra a diferença (recálculo auditável, sem alterar em silêncio). **Alternativa:** só recálculo ao vivo (mais simples, mas números do passado mudam). Recomendo o fechamento.

### 4.2 Regras de contabilização propostas (dependem de Q-01)
| Métrica | Data usada |
|---|---|
| Entradas (conversas iniciadas) | `conversas.criado_em` |
| Concluídas | data **real** do fechamento em `conversa_encerramento.encerrada_em` (cada fechamento conta uma vez; reaberta e fechada de novo = 2 fechamentos, mostrados como "reencerradas") |
| Em andamento | foto de **agora** (estoque), separada e rotulada "agora" |
| Atravessou meia-noite | `date(criado_em) < date(encerrada_em)` |
| > 24 h | `encerrada_em − criado_em > 24 h` ou aberta há > 24 h |
| Pessoas únicas | grupo de pessoa **congelado** no fechamento do dia (evita mudança retroativa) |
| Auto-encerradas | `origem = 'inatividade'` |
| Transferidas | eventos em `conversa_evento` |
Fuso único: `America/Sao_Paulo` em todo o sistema.

### 4.3 Sincronização com o Klingo
- Continua **só leitura** (a API de marcação não está liberada).
- AGE-01: prontuário conferido entra primeiro na comparação; nome completo continua como segunda via; janela de 14 dias passa a valer da **última atividade** do pedido, não da criação (a decidir).
- AGE-03: "Agendado" passa a ter 3 estados visíveis: `aguardando Klingo`, `confirmado no Klingo`, `divergente/não encontrado` (com prazo e alerta). Já há base em `conversa_agendado_conferencia`.
- AGE-04: depois que a equipe marca "Agendado", gravar a ocupação **na hora** (sem esperar 10 min) a partir da escolha conferida; manter leitura do #7; avaliar estender a rotina para 24 h (custo: chamadas ao Klingo).
- AGE-06: nenhuma operação de agendamento é repetida automaticamente; leitura de horários pode ser repetida 1 vez pelo chat com aviso "carregando" (é só leitura).

### 4.4 Atribuição (MON-03) — proposta
Recebeu = primeiro a assumir; respondeu = cada mensagem humana com `agente_id`; agendou = quem marcou "Agendado" (ou "reconhecido automaticamente"); transferiu/encerrou = `conversa_evento.por`; tempo de cada pessoa = intervalos entre eventos de posse. O **total global conta a conversa uma vez**; por pessoa, cada um conta "participou", sem somar no total.

### 4.5 Modelo de permissões (PERF-02/04) — proposta
| Recurso | TI | Gerente | Supervisor | Atendente | Marketing |
|---|---|---|---|---|---|
| Conversas ao vivo | todas | todas | suas equipes/unidades | próprias + sem dono da sua unidade + transferidas a ele | não |
| Histórico | todas | todas | suas unidades | as que participou | não |
| Indicadores | global | global/unidade/equipe/pessoa | suas equipes e pessoas | os próprios | não |
| Dados de paciente | sim (auditado) | sim | suas unidades | só das conversas que pode ver | não |
| Transferir | sim | sim | dentro das suas unidades | para pessoas/unidades autorizadas | não |
| Exportar | sim | sim | só suas unidades | não | contatos (como hoje? Q-13) |
| Configurações / Equipe | TI | gerente | delegação limitada à equipe | não | não |
| Diagnóstico | TI | leitura | não | não | não |

Implementação: uma função `pode_ver_conversa(conversa_id)` usada pelas RLS e por todas as funções `painel_*`; **remover o `update` direto de `conversas` pelo navegador** e trocar por funções (`conversa_assumir`, `conversa_transferir`, `conversa_encerrar`) que validam e registram. Regra "nenhum supervisor concede mais do que tem" aplicada na função que altera `org_membro`. **Conflito:** a regra de ouro atual ("sem unidade conhecida aparece em todas") vaza dados se a visibilidade for por unidade (Q-13).

### 4.6 Serviços automáticos
Reaproveitar `pg_cron`: fechamento diário dos indicadores (00h10), vigia de reserva expirada (5 min), e o `autoencerrar-vigia` existente com aviso à equipe. Nenhuma infraestrutura nova: Realtime + atualização a cada minuto já existem.

### 4.7 Recuperação e auditoria
Toda mudança sensível (vínculo, permissão, transferência, marcação de teste) grava log imutável (mesmo padrão de `registro_assinaturas`: gatilho que impede update/delete). Desfazer sempre por função que grava novo evento, nunca apagando.

---

## FASE 5 — Plano de execução por etapas

**Mudança proposta na ordem sugerida** (com justificativa): incluir uma **Etapa 0** curta antes da A, porque (1) sem marcador de teste qualquer correção de indicador já nasce contaminada, e (2) a tabela de eventos é pré-requisito de indicadores, transferências e produtividade. Também mover **"Transferências com registro" para a Etapa A** (só o registro, sem mudar a tela), pelo mesmo motivo.

### Etapa 0 — Base (sem mudar o que o usuário vê)
- **Faz:** `conversa_evento` + gatilho (inclusive troca de `agente_id`); `conversas.teste`; função de backup lógico (contagens antes/depois).
- **Depende de:** Q-09.
- **Riscos:** gatilho novo em `conversas` deixar o update lento → medir; não pode falhar o update (gatilho com tratamento de erro).
- **Testes:** PGlite: cada mudança de status/dono gera 1 evento; falha do gatilho não impede a operação.
- **Pronto quando:** 3 dias em produção com eventos coerentes com `conversa_encerramento`.

### Etapa A — Estabilização
1. **AGE-06:** otimizar `agenda_horarios_klingo`/`chat_horarios` (normalizar nomes uma vez, índice em `agenda_ocupacao(unidade, inicio)`), idem `chat_responder`, `chat_consulta_salvar`, `chat_corpo`. Mensagem do chat clara ("horários demorando, tente de novo"). **Não** subir o limite de 3 s do `anon` sem decisão (protege o banco).
2. **AGE-04:** escolha de outro paciente bloqueia por tempo limitado; ocupação gravada na hora ao marcar "Agendado".
3. **AGE-01 / AGE-03:** prontuário conferido no reconhecimento; estados visíveis do "Agendado".
4. **CONV-06:** encerramento "Agendado" com pedido em rascunho/pronto vira "aguardando Klingo" visível + alerta.
5. **IND-01, IND-04, IND-05, IND-02, IND-03:** nova função de indicadores (mantendo a antiga até a troca), intervalo livre, remoção das duas colunas.
- **Módulos:** `fase2-pedido-e-agenda.sql`, `medicos-regras.sql`, `agendamento-reconhecer-v3.sql`, `klingo-reconhecer`, `encerramento-agendado.sql`, `indicadores-*.sql`, `painel/index.html`, `index.html`.
- **Pronto quando:** zero 57014 em 7 dias; caso real do AGE-01 resolvido; indicadores de outubro batem com contagem manual feita por SQL.

### Etapa B — Controle operacional
PERF-01 (estrutura), PERF-04/02 (matriz e RLS, primeiro em **modo observação**: registra o que seria bloqueado sem bloquear, por 1 semana), PERF-03 (tela, onde o dono decidir), TRANS-01 (pessoa/unidade), TRANS-02 (lote).
- **Riscos:** atendente perder acesso no meio do expediente → modo observação + liberação por unidade.
- **Pronto quando:** testes de segurança (Fase 6) passam pela API direta.

### Etapa C — Fluxos de atendimento
CONV-01 (ajustes decididos), CONV-02, CONV-03 (conforme decisão), CONV-04/05, NOT-01, NOT-02.

### Etapa D — Gestão e indicadores
MON-01, MON-02 (fechamento diário), MON-03, MON-04 (depois de medir).

### Etapa E — Complementares
CAT-01 (após resposta do Klingo sobre convênio inativo, ou só com controle local), CAT-02 (após Q-18 e resposta do Klingo), REL-02 e REL-01 (após parecer jurídico/clínico).

---

## FASE 6 — Plano de testes

Todos com dados **inventados** (PGlite e Supabase simulado em `testes/`). Nenhum dado real de paciente.

| # | Cenário | Esperado | Aprovação |
|---|---|---|---|
| T1 | Conversa criada 09/11 23:50, encerrada 10/11 00:20 | Entrada em 09/11; conclusão em 10/11; fechamento de 09/11 não muda | Números exatos |
| T2 | Reabrir e fechar de novo | 2 fechamentos; 1 conversa; 1 "reencerrada" | Exato |
| T3 | Conversa marcada como teste | Fora dos indicadores; presente no histórico | Exato |
| T4 | Intervalo 01/10–31/10 vs soma dos dias | Iguais em tabela, cartões e motivos | Exato |
| T5 | Dois pacientes escolhem o mesmo horário ao mesmo tempo | Só 1 consegue; o outro recebe lista nova | 100 repetições, 0 duplos |
| T6 | Marcação gravada no Klingo simulado | Horário some do chat no prazo decidido | Medido |
| T7 | `chat_horarios` com 3 exames, 62 dias | < 1 s; mesma lista de antes da otimização | p95 em 200 chamadas |
| T8 | Nome errado no chat, certo no Klingo, CPF conferido | Reconhecido pelo prontuário | Veredito "forte" |
| T9 | Dois cadastros homônimos sem CPF | Ambíguo, nada vinculado, alerta | Exato |
| T10 | Encerrar "Agendado" com pedido em rascunho | Estado "aguardando Klingo" + alerta | Exato |
| T11 | Atendente da unidade A chama a API com id de conversa da B | 0 linhas / erro 42501 | Para cada tabela e função |
| T12 | Supervisor tenta dar papel de gerente | Recusado e registrado | Exato |
| T13 | Transferir para pessoa e para unidade | Evento gravado com origem/destino; aviso único | Exato |
| T14 | Transferência em lote com 1 inválida | Nada transferido ou só válidas (decisão), com resumo | Exato |
| T15 | Paciente responde 1 min antes das 24 h | Não fecha | Exato |
| T16 | Duas execuções do vigia ao mesmo tempo | 1 fechamento | Exato |
| T17 | Mensagem atrasada (rede) chega depois do fechamento | Decisão Q-04 aplicada (reabre ou nova conversa) | Exato |
| T18 | Falha de rede durante "Marcar como agendado" | Nenhuma duplicação; estado reconciliado | Exato |
| T19 | Sino do paciente: permitido, bloqueado, silenciado | Textos e envio corretos | Navegador |
| T20 | Regressão completa | `npm test` inteiro passa | 100% |

Testes de regressão obrigatórios em cada etapa: `test:encerramento*`, `test:autoencerrar-sql`, `test:reconhecer-sql`, `test:agendado-sql`, `test:indicadores`, `test:pessoa*`, `test:medicos*`, `test:lista-agrupada`, `test:navegador`.

---

## FASE 7 — Implantação segura

- **Pré-requisitos:** decisões da Fase 8 marcadas como bloqueantes para a etapa; testes verdes.
- **Migrações:** só aditivas (`add column if not exists`, `create or replace`), em partes pequenas; cada arquivo com seção ROLLBACK, como já é o padrão do projeto.
- **Cópia de segurança:** confirmar no painel do Supabase que o backup diário está ativo antes de cada etapa (https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/database/backups/scheduled); guardar as definições atuais das funções alteradas (`pg_get_functiondef`) em `docs/` antes de trocar.
- **Compatibilidade:** painel antigo aberto no navegador continua funcionando (funções antigas mantidas até a troca, como já feito em `painel_indicadores`).
- **Homologação:** não há ambiente de homologação hoje. Opção: **branch do Supabase** (cópia do esquema sem dados) para testar SQL, e chave em `config` para ligar cada mudança (padrão `desligado` → `simulacao` → `ligado`, já usado no autoencerramento).
- **Gradual:** permissões em modo observação; indicadores novos lado a lado com os antigos por 1 semana.
- **Monitoramento:** `incidente_chat` por tipo/dia; `autoencerramento_execucao`; eventos de permissão negada.
- **Reversão:** desligar a chave em `config`; ou reaplicar a definição antiga guardada. Critérios: qualquer aumento de incidentes RPC/DES > 2× a média; qualquer atendente sem acesso ao que precisa; qualquer vínculo errado entre pacientes.

---

## FASE 8 — Pendências e perguntas

**B** = bloqueante para implementar; **I** = importante, não bloqueia o planejamento; **O** = opcional.

| # | Pergunta | Classe | Recomendação |
|---|---|---|---|
| Q-01 | Regra temporal dos indicadores: entradas pela data de início e **conclusões pela data real do fechamento**? Dias passados ficam **fechados** (com diferença mostrada) ou podem mudar? | **B** (IND-01/04/05, MON-02) | Sim à regra proposta; fechamento diário com diferença visível |
| Q-02 | "Confirmaram": tirar só a coluna da tabela ou também o cartão de cima? | I | Ambos |
| Q-03 | O que é "entrada"? Paciente que volta no mesmo dia em nova conversa conta 2 entradas ou 1? | **B** (IND-05) | 1 pessoa, 2 conversas, mostradas separadas |
| Q-04 | Encerramento por inatividade: manter as exceções atuais (exame em aberto, remarcação)? Transferência reinicia as 24 h? Existe "aguardando processo interno"? Mensagem do paciente depois do fechamento reabre ou cria nova? Avisar o atendente como? | **B** (CONV-01/02) | Transferência reinicia; nova mensagem reabre em até 7 dias |
| Q-05 | Nova conversa com outra aberta: **encerrar a anterior** (conflita com "uma pessoa, uma conversa", que hoje une) ou **manter unidas**? | **B** (CONV-03) | Encerrar a anterior só se ela não tiver exame em aberto nem atendente ativo; senão continuar nela |
| Q-06 | O "formulário" que não atualizou era o cartão Pré-agendamento, o quadro ou a Jornada? | I | — |
| Q-07 | No caso real do AGE-01: onde o nome foi corrigido (chat, painel ou Klingo) e posso analisar a conversa pelo id técnico, sem copiar dados? | **B** (AGE-01) | — |
| Q-08 | Quanto tempo a escolha de um paciente no chat segura o horário (ex.: 2 h)? Prazo aceitável para um horário marcado no Klingo sumir do chat? Ler a ocupação também à noite? | **B** (AGE-04) | 2 h de reserva; ≤ 2 min após "Agendado" |
| Q-09 | Quem pode marcar conversa como teste? Marcar as antigas do Alisson uma a uma (ele conferindo)? | **B** (Etapa 0) | Só TI/gerente; revisão manual |
| Q-10 | "Revisar o envio": de qual envio se trata (confirmação ao paciente, despedida, push, e-mail)? | I | — |
| Q-11 | Estrutura: Juliana e Luzia não têm conta. Qual das duas Carlas (Carla Fernandes, atendente; Carla Adrielle, admin) é a supervisora? Quem são as atendentes de cada uma? Jonathan (admin) entra onde? | **B** (PERF-01) | — |
| Q-12 | "Desenvoar" está escrito assim no sistema (unidade de pediatria). A unidade da Luzia é CSI ou CSI RM/TC? Call Center é uma **equipe** (atende todas as unidades) ou uma **unidade**? | **B** (PERF-01) | Call Center como equipe |
| Q-13 | Atendente deixa de ver conversas de outras unidades? Isso muda o "Precisam de atenção" (hoje todos veem). Conversa sem unidade conhecida vai para quem? Marketing continua vendo/exportando contatos? | **B** (PERF-02) | Sem unidade → fila do Call Center |
| Q-14 | **Não existe aba "Guia"**. É a aba **Equipe**, uma aba nova chamada "Guia", ou outra tela? | **B** (PERF-03) | Nova seção "Estrutura" dentro de Equipe |
| Q-15 | Quem "agendou" quando o reconhecimento automático marca? | I | "Automático", sem crédito a pessoa |
| Q-16 | Travamento: qual tela, qual aparelho/navegador e quantas conversas abertas? | I (MON-04) | — |
| Q-17 | Convênio suspenso: quem decide e por quanto tempo? Mostrar ao paciente ou só à equipe? | I | Mostrar com rótulo, sem deixar seguir |
| Q-18 | "Usar o último exame como referência" no preço: o valor da última marcação particular daquele exame? | **B** (CAT-02) | — |
| Q-19 | Lembretes anuais: protocolo clínico aprovado, base legal, canal e quem responde? | **B** (REL-01) | Só após parecer |
| Q-20 | Aniversário: canal (chat não alcança quem não está com o chat aberto; push só para quem permitiu), consentimento e cancelamento? | **B** (REL-02) | — |
| Q-21 | Pode subir o limite de 3 s do chat se a otimização não bastar? | O | Não, otimizar primeiro |

---

## Apêndice — Consultas usadas (só leitura e contagem)
- Estrutura: `information_schema.columns`, `pg_policies`, `pg_trigger`, `pg_roles`, `cron.job`, `pg_get_functiondef` de `conversa_antes_update`, `conversa_status_mudou`, `papel_atual`, `chat_iniciar`, `agenda_horarios`.
- Contagens: `conversas` por status, datas de abertura/fechamento; `conversa_encerramento` por motivo/origem; `autoencerramento_execucao`; `incidente_chat` por tipo/chamada/código; `pre_agendamentos` × motivo de encerramento; `paciente_klingo_vinculo` por situação; conversas por atendente (nomes da equipe, não de pacientes).
- Incidente AGE-06: `incidente_chat` filtrado pelo código (campos técnicos: chamada, status, tempo, código do erro).

---

## FASE 8 (atualização) — Decisões do dono e conflitos encontrados (10/11/2026, versão 1.1)

Somente o que o dono preencheu vale como decisão. Esta seção confronta cada decisão com o código e o banco real (leituras e contagens; nenhum dado de paciente lido). **Nada foi implementado.**

### A. Decisões registradas (como entendidas)

| Q | Decisão | Efeito no plano |
|---|---|---|
| Q-01 | Entrada = data do **primeiro atendimento humano**. Conclusão = data/hora **real** do encerramento. Dia já apurado: **congelado, sem ajustes**. Dia concluído não pode "perder" ou "ganhar" conclusão depois; o que reabriu volta a **em andamento** | IND-01/04/05, MON-02 |
| Q-02 | Remover **coluna e cartão** "Confirmaram" | IND-03 |
| Q-03 | **No máximo 1 conversa por paciente/dia**; pessoas = pacientes únicos | IND-05 (ver C-1) |
| Q-04 | Transferência **reinicia** as 24 h; sem novo estado "aguardando processo interno"; mensagem do paciente depois do fechamento **reabre até 7 dias**, depois cria nova; atendente avisado por **notificação no painel + registro na conversa**; exceção de exame/remarcação: **"escolha a melhor"** (ver C-4) | CONV-01/02 |
| Q-05 | **Sempre** encerrar a anterior e abrir outra, **com texto de confirmação** ao paciente | CONV-03 (ver C-5) |
| Q-06 | Falha foi no Atendimento **e** na Jornada (sem ligação). Atualização do Klingo → **30 s**; nunca duas leituras ao mesmo tempo; erro → tenta de novo após 30 s | AGE-01/03, CONV-06 (ver C-6) |
| Q-07 | Correção foi **no Klingo**; autorizada análise só por **ID técnico** | AGE-01 (falta o ID) |
| Q-08 | Antes de oferecer horários, conferir que estão livres; **reserva de 2 min**; horário marcado no Klingo some em **≤ 30 s**; ler ocupação **também à noite** | AGE-04 (ver C-6) |
| Q-09 | Marcar teste: **só TI e gerência**. Antigas: **por regra automática** — "conversas atendidas ou encerradas por Alisson" | Etapa 0 (ver C-2, C-3) |
| Q-10 | No início do atendimento, **caixa separada** em que o paciente declara estar ciente de que os horários são **previsão** e que a equipe confirma | AGE-07 (ver C-10) |
| Q-11 | Supervisora = **Carla Adrielle (admin)**; criar contas para **Juliana e Luzia**; Jonathan = **administrador técnico geral**; distribuição das atendentes: **sem resposta útil** (ver C-7) | PERF-01 |
| Q-12 | Pediatria = **Desenvoar**; Luzia = **CSI**; Call Center = **equipe transversal** | PERF-01 |
| Q-13 | Atendente vê **só as unidades dela**; "Precisam de atenção" = **visão geral para todos**; sem unidade → **triagem do Call Center**; Marketing **como hoje** | PERF-02 (ver C-8) |
| Q-14 | Nova seção **"Estrutura"** dentro da aba **Equipe** (a aba "Guia" não existe) | PERF-03 |
| Q-15 | Reconhecimento automático: origens **separadas** (sistema × atendente), ambas nos indicadores | MON-01/03 (ver C-9) |
| Q-16 | **Parcial.** Trava no **chat do paciente** na escolha de horário (time out) ou depois de muito tempo parado; Windows, Chrome/Edge. Falta nº de conversas | MON-04 (ver C-11) |
| Q-17 | Gerência e administrativo suspendem; **1 mês**, depois **aviso de revisão**; convênio aparece esmaecido com o aviso entre parênteses, **não selecionável**; oferecer outro | CAT-01 |
| Q-18 | Preço particular = **tabela fixa revisada manualmente**; sem preço → **"sob consulta"** | CAT-02 (ver C-13) |
| Q-19 / Q-20 | **Não desenvolver** lembretes anuais nem aniversário | **REL-01 e REL-02 saem do plano** |
| Q-21 | **Manter 3 s**, otimizar; o chat **aguarda a chamada anterior** antes de pedir outra; **pode-se criar mais consultas/índices** para acelerar | AGE-06 |

### B. Conflitos e riscos (nada foi decidido em silêncio)

**C-1 — Q-03 × Q-05 × Q-01 (contagem).** Q-05 cria, de propósito, várias conversas do mesmo paciente no mesmo dia; hoje já há **29** combinações contato+dia com 2 ou mais conversas. Q-03 pede 1 por paciente/dia. E "entrada = primeiro atendimento humano" deixa de fora **39 de 196 conversas (20%)** que nunca tiveram mensagem de pessoa (4 abertas, 35 encerradas). *Recomendação:* "entrada" = 1 por paciente por dia (dia do primeiro atendimento humano); mostrar **separado, só informativo**: conversas brutas abertas, conversas sem atendimento humano e reaberturas.

**C-2 — Q-01 (congelamento) × Q-09 (teste retroativo).** Marcar testes depois de congelar mudaria dias fechados. *Recomendação:* classificar os testes **antes** do primeiro congelamento (a "linha de base" já sai limpa) e, depois dele, marcação de teste **não altera** dia fechado (fica só o registro). Erro de regra descoberto depois só corrige com exceção registrada por TI + gerência (guardando `versao_regra`). "Sem ajustes" integral impede qualquer correção; confirmar se a exceção é aceita.

**C-3 — Q-09 (regra "Alisson").** A regra pega **29 de 196** conversas (dono/encerrou 26, respondeu 10, encerrou algum fechamento 9). **3** têm também mensagens de outras pessoas e **1** está unida a uma conversa de outra pessoa (testes e atendimento real misturados). Dúvidas: (a) vale só para o passado ou **daqui para frente** também? (b) conversa mista é teste inteira? (c) "TI e gerência" **ainda não existem como papel** — até PERF-01, quem marca? *Recomendação:* aplicar a regra só ao passado, **conferindo a lista de 29 com você antes de gravar**, e marcação futura manual por TI/gerência.

**C-4 — Q-04 (exceção a escolher).** *Recomendação:* o **exame em aberto deixa de impedir** o fechamento por inatividade (o exame vive na Jornada, e desde 09/11 a equipe já encerra com exame aberto); **remarcação pendente continua impedindo** (o paciente está no meio de um fluxo). Hoje só 1 conversa aberta tem exame em aberto. Também conflita com Q-05: o fluxo de remarcação **abre conversa nova de propósito** (`agendamento_preparar_remarcacao`), e "sempre encerrar a anterior" não pode quebrar isso.

**C-5 — Q-05 × "uma pessoa, uma conversa" e segurança.**
1. Hoje o sistema **une** conversas da mesma pessoa; Q-05 passa a **encerrar**. As encerradas continuam ligadas no histórico (sem mover mensagem).
2. **Risco de segurança:** `chat_iniciar` só sabe o telefone digitado. Perguntar/encerrar "a conversa anterior" por telefone permitiria a qualquer pessoa **fechar o atendimento de outra** (e revelaria que há atendimento). *Recomendação:* a confirmação só aparece se **este aparelho** já guarda a conversa aberta (o chat já guarda as últimas 5 por aparelho) ou se a conta estiver logada. Fora disso, abre conversa nova sem tocar na do telefone.
3. Conversa **em atendimento por pessoa** fechada pelo paciente: o atendente precisa ser avisado; motivo/origem novos (`nova_conversa`, origem `paciente`).
4. Sem confirmar → continua na conversa atual (a palavra "sempre" fica condicionada à confirmação, como você pediu).

**C-6 — Q-08 × Q-21 × Q-06 (Klingo em 30 s e checagem antes de oferecer).**
- Conferir no **Klingo ao vivo** dentro do chat é **inviável em 3 s**: nas últimas 4 h as leituras do Klingo levaram em média **2,5–3,6 s** e no máximo **8,6 s** (≈1.000 chamadas da conferência).
- Hoje: ocupação a cada **10 min** (05h–22h); Jornada a cada **1 min** no expediente; conferência de alvos a cada 15 s.
- *Recomendação:* (a) reserva provisória de **2 min** no banco entre oferecer e escolher; (b) releitura da ocupação a cada **30 s** só dos dias/profissionais em jogo, 24 h por dia com intervalo maior à noite; (c) Jornada de 1 min para 30 s; (d) trava persistente de "leitura em andamento" (o `pg_try_advisory_xact_lock` atual só protege o disparo, não a Edge Function que demora vários segundos), com nova tentativa 30 s depois do erro. **Efeito:** cerca do dobro de chamadas ao Klingo; medir antes de ligar. "Até 30 s depois de Agendado" só vale se a releitura for de 30 s; marcações feitas direto no Klingo dependem dela.

**C-7 — Q-11 (hierarquia).** "Distribuição das atendentes: Supervisora" não traz nomes: **falta quem atende sob Carla Adrielle e sob Luzia**, e quem é do Call Center. Hoje existem só 5 contas (Alisson, Jonathan e Carla Adrielle = admin; Carla Fernandes e Aimê Brito = atendente). **Carla Adrielle é `admin`**: para a supervisão valer, o papel dela teria de deixar de ser administrador — **alteração de permissão que só faço com sua autorização**. Juliana e Luzia não têm conta; criação só com seu aval e e-mails.

**C-8 — Q-13 (visibilidade).**
- "Precisam de atenção" para todos **expõe conversa de outra unidade**. *Recomendação:* outras unidades aparecem só como **contagem/alerta sem nome nem mensagem**; abrir exige pertencer à unidade.
- Marketing "como hoje": hoje a regra de leitura de `conversas` libera **qualquer papel ativo, inclusive Marketing**. Manter contatos e exportação, mas **tirar a leitura de conversas** do Marketing? Confirmar.
- Dados: **40 conversas sem unidade** (5 abertas) irão para a triagem do Call Center; as outras são Desenvoar (149) e CSI (7). Se a restrição ligar antes dos vínculos, **ninguém vê nada** → entra em **modo observação** primeiro.

**C-9 — Q-15.** Hoje: 29 pedidos agendados com marca automática (`agendado_auto_em`) e 4 sem. O **nome de quem confirmou manualmente não é gravado em lugar nenhum**. Passa a ser gravado daqui para frente; o passado fica como "equipe (sem nome)".

**C-10 — Q-10.** Já existem avisos de "previsão" no chat (`index.html` ~linhas 834, 1346), mas **sem aceite**. O aceite novo vira coluna nova em `conversas` com data/hora e parâmetro novo em `chat_iniciar`. Como o chat é PWA com cache, o servidor aceita a ausência por alguns dias para não quebrar aparelho com versão antiga. O texto exato precisa de aprovação.

**C-11 — Q-16.** O relato descreve o **chat do paciente** (time out na escolha de horário; demora) e não o "travamento da visualização por atendente" da solicitação original — **esse segue sem reprodução**. O time out é o mesmo do AGE-06. "Muito tempo parado" é compatível com aba em segundo plano e chamadas sobrepostas (houve `chat_listar` de 8 a 35 s); não encontrei no `index.html` trava que impeça nova chamada com outra em andamento (verificar na implementação).

**C-12 — Q-17.** "Administrativo" não é papel hoje (existe `admin`). Interpretei "1 mês + aviso de revisão" como: aos 30 dias **vira alerta** para revisar, **não reativa sozinho**.

**C-13 — Q-18.** A tabela revisada à mão existe (`catalogo_preco_revisao`), mas tem **1 linha em 2.152 procedimentos**: quase tudo apareceria "sob consulta" até a equipe revisar. Falta saber **onde** aparece (para o paciente ou só na aba Catálogo da equipe). Hoje a IA/motor não informa preço; quem informa é o atendente.

### C. Ajustes no plano

- **Sai do plano:** REL-01 e REL-02 (Etapa E reduzida a CAT-01 e CAT-02).
- **Etapa 0 (nova):** eventos da conversa + marcador de teste + **classificação conferida de teste antes do primeiro congelamento**.
- **Etapa A:** ganha a trava de leitura única do Klingo, a releitura de 30 s e o "aguardar a chamada anterior" no chat.
- **Etapa B:** começa com **modo observação** das permissões; só liga depois de conferir os vínculos.
- **Pedido de dado:** para AGE-01 falta o **ID técnico** do caso real (código `CSI-...` ou id da conversa; não é dado pessoal).

### D. Próxima pergunta (uma por vez)

**C-1:** aceita "entrada = 1 por paciente por dia (dia do primeiro atendimento humano)" e as conversas **sem atendimento humano** (20% hoje) aparecendo **separadas, só informativas**?
