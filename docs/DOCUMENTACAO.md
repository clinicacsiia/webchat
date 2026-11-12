# Documentação do Webchat da CSI

Versão 1.0 — 11/11/2026 / Mudança: primeira documentação única do sistema, escrita na auditoria de 11/11/2026

Este é o documento para **entender o sistema inteiro**: o que é cada pasta, cada arquivo, cada peça do banco e como elas se falam. Os outros arquivos de `docs/` contam a história de cada mudança; este diz **como as coisas são hoje**.

- O que foi auditado e corrigido em 11/11/2026: [`auditoria-2026-11-11.md`](auditoria-2026-11-11.md)
- O que depende do dono: [`pendencias-do-dono.md`](pendencias-do-dono.md)
- A estrutura real do banco de produção: [`../supabase/producao/`](../supabase/producao/LEIAME.md)

---

## 1. O que o sistema faz

Um paciente abre o chat no celular, diz se quer **exame**, **consulta** ou **outro assunto**, escolhe o exame (por foto do pedido médico, pelo mapa do corpo ou pelo nome), o plano, um dia e horário **previstos** e informa os dados do cadastro. O pedido chega pronto ao **painel** da equipe, que marca no Klingo e confirma com o paciente. O sistema **não grava nada no Klingo**: ele só lê.

Três telas, um banco:

| Tela | Para quem | Endereço | Arquivo |
|---|---|---|---|
| Chat | Paciente | `https://clinicacsiia.github.io/webchat/` | `index.html` |
| Painel | Equipe (atendentes, supervisão, TI, marketing) | `https://clinicacsiia.github.io/webchat/painel/` | `painel/index.html` |
| Minha vez | Paciente na recepção (fila de chegada) | `https://clinicacsiia.github.io/webchat/minha-vez/` | `minha-vez/index.html` |

Não há servidor próprio. As páginas são arquivos parados no GitHub Pages; toda a regra de negócio mora no **Supabase** (projeto `nrvuynjwcgwpjdptkiay`, região de São Paulo): banco Postgres, login, tempo real e funções na nuvem.

## 2. Desenho geral

```
 Paciente (celular)                    Equipe (computador/celular)
   index.html  ── só chama funções chat_* ──┐      painel/index.html ── lê tabelas (com regra de acesso)
   minha-vez/  ── funções fila_*/conta_* ───┤                         └─ chama funções painel_*, pessoa_*, jornada_*...
                                            ▼
                         ┌──────────── SUPABASE ────────────┐
                         │  Postgres 17                      │
                         │   · 101 tabelas, todas com RLS    │      a cada 15 s / 30 s / 1 min / 5 min / dia
                         │   · 425 funções (o "motor")       │◄──── pg_cron (21 rotinas)
                         │   · 56 gatilhos                   │
                         │  Auth (equipe e conta do paciente)│
                         │  Realtime (avisos instantâneos)   │
                         │  Edge Functions (Deno) ───────────┼────► Klingo (só leitura, API de relatórios)
                         └───────────────────────────────────┘────► Web Push (avisos no celular)
```

Três ideias que explicam quase tudo:

1. **O paciente nunca lê tabela.** O chat só chama funções `chat_*`, e cada uma confere o **token secreto da conversa** (guardado no aparelho). Quem não tem o token não vê nada. Isso é conferido por teste (`testes/retrato.test.mjs` e `testes/sql-ponta-a-ponta.test.mjs`).
2. **Quem responde o paciente é o banco** ("motor de regras", funções `fluxo_*`), na mesma chamada que grava a mensagem dele. Não há IA conversando. Uma pessoa da equipe pode assumir a qualquer momento; aí o motor para.
3. **O Klingo é a verdade da agenda.** Rotinas leem relatórios do Klingo o tempo todo (ocupação da agenda, marcações, catálogo, preços) e o chat mostra horários a partir disso. Marcar continua sendo com a equipe.

## 3. As pastas, uma a uma

### 3.1 Raiz (o que o GitHub Pages publica)

| Arquivo | O que é |
|---|---|
| `index.html` | **Chat do paciente.** Página única (HTML + CSS + JavaScript, sem biblioteca além do `supabase-js`). Formulário inicial, conversa, perguntas com botões, mapa do corpo, foto do pedido com leitura no celular (Tesseract), calendário, login opcional, "Meus dados", sino dos avisos. Versão em `VERSAO_APP`. |
| `sentinela.js` | **Monitor do chat.** Observa a conversa no aparelho do paciente: mensagem fora de ordem, tela travada, resposta que demora, erro de chamada. Tenta curar sozinho, fala com o paciente numa faixa e gera o código de suporte `CSI-AAMMDD-HHMM-TIPO-XXXX`, que a equipe pesquisa no painel. Nunca registra texto de mensagem nem dado pessoal. Se não carregar, o chat funciona igual. |
| `nomes-exame.js` | Transforma o nome técnico do exame no Klingo ("RM PUNHO (INCLUI ARTRO-RESSONÂNCIA) UNILATERAL") em título e detalhe legíveis. |
| `paciente-status.js` | O único lugar que define o caminho do paciente (Pedido > Pronto > Marcado > Confirmado > Chegou > Exame feito > Resultado) e os desvios. Usado pelo painel e pelo Minha vez. |
| `sw.js` | Service worker do chat: abre na hora com a cópia guardada e busca a versão nova por trás; recebe os avisos (push). Nunca guarda `/painel/`, `/fila/` nem `/minha-vez/`. |
| `privacidade.html`, `termos.html` | Política de privacidade e termos (**rascunho até a revisão jurídica**). |
| `manifest.webmanifest`, `icon-*.png`, `img/` | Instalação como aplicativo e logos. |
| `LEIAME.md` | Porta de entrada do repositório (resumo e histórico). |
| `CLAUDE.md` | Preferências do dono para quem trabalha no projeto. **Ler antes de qualquer tarefa.** |
| `pendencias.md`, `pendencias_ui_csi.md` | Listas antigas de conformidade (LGPD, acessibilidade) e de interface. O que ainda vale está em `docs/pendencias-do-dono.md`. |

### 3.2 `painel/`

`painel/index.html` é o painel da equipe, também página única. Abas:

| Aba | Para quê | Quem vê |
|---|---|---|
| Atendimento | Lista (ou Quadro) de conversas, o chat com o paciente, o cartão do pedido, "próximo passo", transferir (pessoa, unidade, lote), encerrar com motivo | admin e atendente |
| Atendimento > Equipe agora | Botão no alto da aba, **só para TI, gerência e supervisão** (`org_nivel()`): por atendente, quantas conversas tem, quantos pacientes esperam resposta (e há quanto tempo), quantos a equipe espera, quantos para chamar no zap, quantos marcou hoje. Sai das conversas já carregadas no painel; só "Marcou hoje" usa `painel_indicadores_atendentes` | chefia |
| Jornada | Onde está cada paciente (dados do Klingo + chat), com alertas de atraso | admin e atendente |
| Fila | Fila de chegada da recepção | admin e atendente |
| Avisos | "Mesma pessoa?", data de nascimento diferente, paciente × Klingo, pedidos de acesso | admin e atendente |
| Indicadores | Pessoas atendidas, reentradas, concluídas, sem atendimento humano; por dia e por equipe | admin e atendente |
| Contatos | Busca, etiquetas, exportação CSV | todos (inclusive marketing) |
| Equipe (com Estrutura) | Contas, convites, equipes/unidades, modo das permissões | admin |
| Convênios, Médicos, Catálogo, Aprendizado, Configurações | Regras por convênio, turnos e bloqueios de médicos, preços e limpeza do catálogo, incidentes da Sentinela, textos e chaves | admin |

`painel/sw.js`: rede primeiro, cache só como reserva; recebe os avisos da equipe.

### 3.3 `minha-vez/`

Portal da fila de chegada: o paciente toca em "Cheguei", vê a posição e é avisado quando faltam 2 pessoas e na vez dele. Usa as funções `fila_*`, `checkin_publico` e `paciente_jornada`.

### 3.4 `supabase/`

| Onde | O que é |
|---|---|
| `supabase/*.sql` (cerca de 100 arquivos) | **Histórico das mudanças do banco**, um arquivo por assunto, aplicados à mão no Supabase. Cada um tem cabeçalho com fluxograma, versão e como voltar atrás. **Não são a verdade do banco**: várias correções foram aplicadas direto e 31 funções da produção diferem de qualquer versão destes arquivos. |
| `supabase/producao/` | **A verdade do banco**: retrato da estrutura real da produção (uma função por arquivo, tabelas, gatilhos, regras de acesso, rotinas). Sem dado de paciente e sem segredo. Ver [`LEIAME.md`](../supabase/producao/LEIAME.md). |
| `supabase/functions/` | Edge Functions (Deno/TypeScript). Ver seção 6. |
| `supabase/00-base-snapshot.sql` | Foto antiga da base (30/10). Só referência histórica. |

Regra prática: **para saber como algo funciona hoje, leia `supabase/producao/funcoes/<nome>.sql`**. Para saber por que ficou assim, procure o arquivo do assunto em `supabase/` e o documento em `docs/`.

### 3.5 `testes/`

Bateria completa (`cd testes && npm install && npm test`). Ver seção 8 e [`testes/README.md`](../testes/README.md). Esta pasta não é usada por nenhuma página.

### 3.6 `biometria/`

Algoritmo de referência (Python) da assinatura na tela, do módulo "Fila + assinatura biométrica". **O módulo não está em uso** (falta decisão jurídica e a tela `fila/`). O mesmo algoritmo existe em TypeScript em `supabase/functions/fila-validar-assinatura/`; um teste exige que os dois deem o mesmo resultado.

### 3.7 `docs/`

Um documento por mudança ou decisão. Os mais úteis para começar: este; `auditoria-2026-11-11.md`; `pendencias-do-dono.md`; `planejamento-auditoria-2026-11-10.md` (decisões do dono, com as regras dos indicadores e das permissões); `klingo-relatorios-pendentes.md` (o que o Klingo entrega e o que falta); `fase7-motor-implementado.md` (o motor do chat).

### 3.8 `supabase-emails/`

Modelo em português do e-mail de confirmação de conta (colar em Supabase > Authentication > Email Templates).

## 4. O banco, por assunto

Números de 11/11/2026 (fim do dia): 101 tabelas, 5 visões, 425 funções, 56 gatilhos, 65 regras de acesso. **Toda tabela tem RLS ligada.**

| Assunto | Tabelas principais | Funções (prefixo) |
|---|---|---|
| Conversa | `contatos` (1 por telefone), `conversas`, `mensagens`, `conversa_segredo` (o token), `conversa_evento` (linha do tempo), `conversa_encerramento` | `chat_*` (paciente), `painel_*`, `conversa_*` |
| Motor do chat | `conversa_fluxo` (em que passo está), `fluxo_texto` (as frases), `fluxo_evento` | `fluxo_*` |
| Pedido | `pre_agendamentos` (1 por conversa), `pre_agendamento_itens`, `conversa_anexo` (fotos) | `chat_pedido_*`, `chat_exames_*`, `ia_pre_agendar` |
| Paciente e pessoa | `pacientes`, `contas_paciente`, `conversa_grupo` (conversas da mesma pessoa), `paciente_klingo_vinculo`, `pessoa_klingo_vinculo`, `vinculo_log` | `paciente_*`, `pessoa_*`, `conta_*` |
| Agenda | `catalogo_agenda` (grade), `agenda_ocupacao` (o que o Klingo tem marcado), `agenda_ao_vivo`, regras de duração e sala | `agenda_*`, `chat_horarios`, `chat_horario_escolher` |
| Catálogo e preços | `catalogo_procedimento`, `catalogo_plano`, `catalogo_preco`, `catalogo_regiao`, `catalogo_mudanca`, `consulta_config` (quais consultas aparecem no chat), `chat_cache` (respostas prontas) | `catalogo_*`, `preco_*`, `consultas_*` |
| Convênios e médicos | `convenio_config`, `medico_*`, `profissional_bloqueio` | `convenio_*`, `medico_*` |
| Jornada (Klingo) | `jornada_paciente`, `jornada_card`, `jornada_exame`, `jornada_evento`, `jornada_tarefa` | `jornada_*` |
| Equipe e permissões | `agentes`, `org_equipe`, `org_membro`, `permissao_observacao`, `equipe_notificacao` | `org_*`, `equipe_*`, `papel_atual` |
| Indicadores | `ind_fechamento`, `ind_pessoa_dia`, `ind_conclusao_dia`, `ind_semhumano_dia` | `painel_indicadores_*`, `ind_*` |
| Fila de chegada | `fila_chegada`, `fila_aviso`, `push_inscricao` | `fila_*`, `checkin_publico` |
| Diagnóstico | `incidente_chat` (códigos da Sentinela), `autoencerramento_execucao` | `chat_incidente`, `painel_incidentes` |
| Configuração | `config` (chave → valor) | — |

### 4.1 Como o paciente é protegido

- `anon` (paciente sem login) tem **limite de 3 segundos** por chamada; a equipe logada, 8 segundos. Por isso toda função do chat precisa ser rápida.
- Limites embutidos: 5 conversas por hora por telefone, 20 mensagens por minuto por conversa.
- A conversa só abre com o par (id, token). Token errado devolve erro `28000`.
- Conta de paciente logada **não** é equipe: `papel_atual()` devolve nulo e ela não lê tabela nenhuma.
- O aviso no celular (push) nunca leva nome nem texto: só "você recebeu uma resposta".

### 4.2 O caminho do motor (função `fluxo_proximo`)

`motivo` → `exame` ou `consulta` (ou `assunto`) → `medico` (só consulta, se houver mais de um) → `plano` → `horario` → `dados_ident` → `dados_contato` → `confirmar` (a carteirinha deixou de ser perguntada em 12/11/2026) → pronto (o pedido vai para a equipe).

O servidor só aceita resposta a uma pergunta do motor enquanto **o motor conduz** (`motor = fluxo`, `ia_ativa`, status `aguardando`). Se a equipe assumiu, a resposta é recusada com "Essa pergunta já foi respondida". Desde 11/11/2026 a tela do chat desliga esses botões sozinha quando a equipe entra.

### 4.3 Estados da conversa

`aguardando` → `em_atendimento` → `encerrada` (pode reabrir em até 2 dias se o paciente escrever). Encerrar pela equipe exige motivo. Sem resposta do paciente por 24 h a conversa **não fecha**: fica marcada "Chamar no WhatsApp" para a equipe ir atrás (decisão do dono de 11/11/2026, `docs/autoencerramento.md`).

## 5. Rotinas automáticas (pg_cron)

| Rotina | Quando | O que faz |
|---|---|---|
| `agenda-conferir` | 15 s (se há trabalho) | Confere no Klingo os pedidos que a equipe marcou |
| `jornada-klingo-30s` | 30 s | Lê as marcações do Klingo para a Jornada (uma leitura por vez) |
| `agendamento-reconhecer-klingo` | 30 s | Reconhece no Klingo o agendamento de um pedido do chat |
| `jornada-vigia`, `espera-vigia` | 1 min | Copia as conversas para a Jornada, alertas de atraso; aviso de paciente esperando |
| `autoencerrar-vigia`, `agendado-vigia`, `pessoa-agrupar` | 5 min | Marca "Chamar no WhatsApp" quem não responde há 24 h; confere "Agendado"; une conversas da mesma pessoa |
| `agenda-ocupacao`, `agenda-revisar`, `agendamento-klingo`, `klingo-ligar-pendentes` | 10 min | Ocupação da agenda, conferências e religar conversas ainda sem prontuário do Klingo |
| `chat-corpo-cache` | 10 min | Deixa pronto o "mapa do corpo" do chat (resposta em ~1 ms) |
| `agenda-ocupacao-noite` | 30 min (23h–4h) | Ocupação fora do expediente |
| `sync-catalogo-klingo`, `catalogo-precos-*`, `fluxo-exames` | 03:00–03:40 | Catálogo, preços e visão de fluxo |
| `indicadores-fechar-dia` | 00:10 | Congela os números do dia anterior |
| `convenios-revisar` | 08:05 | Avisa a gestão de convênio suspenso há 1 mês |
| `manutencao-limpeza` | 04:17 | Apaga o histórico técnico de execuções com mais de 3 dias |

Horários em Brasília. Conferir a saúde delas: `select jobname, status, count(*) from cron.job_run_details d join cron.job j using (jobid) where start_time > now() - interval '1 day' group by 1, 2;`

## 6. Edge Functions (`supabase/functions/`)

Todas publicadas **sem exigir JWT** e cada uma confere o próprio segredo.

| Função | Quem chama | Como prova quem é | No ar? |
|---|---|---|---|
| `sync-catalogo-klingo` | pg_cron | cabeçalho `x-sync-key` = `config.ia_segredo` | sim |
| `sync-jornada-klingo` | pg_cron | `x-sync-key` | sim |
| `klingo-reconhecer` | pg_cron | `x-sync-key` | sim |
| `klingo-paciente` | gatilho do banco (CPF + nascimento) | `x-sync-key` | sim |
| `chat-agenda-ao-vivo` | o chat, ao chegar no calendário | token da conversa | sim |
| `chat-avisar`, `avisar-equipe`, `fila-avisar` | o banco (pg_net) | segredo do Vault `fila_aviso_segredo` | sim |
| `klingo-inspecionar-chat` | manual (diagnóstico) | `x-sync-key` | sim (pode ser apagada) |
| `ler-pedido` | o chat (foto do pedido lida por IA) | token da conversa | **não** (depende de chave e de revisão jurídica) |
| `fila-emitir-link`, `fila-validar-assinatura` | módulo da biometria | segredo / token | **não** (módulo parado) |

Segredos das funções (Supabase > Edge Functions > Secrets): `KLINGO_APP_TOKEN`, `VAPID_PRIVADA`, e, quando forem ligadas, `ANTHROPIC_API_KEY`, `EMAIL_API_KEY`, `EMAIL_REMETENTE`. **Nenhum segredo fica no repositório.**

## 7. Configuração (`public.config`)

Liga/desliga e textos. Só o administrador lê e altera (aba Configurações ou SQL). Estado em 11/11/2026:

| Chave | Valor | O que controla |
|---|---|---|
| `motor` | `fluxo` | Quem responde o paciente (motor de regras) |
| `agenda_ao_vivo` | `sim` | Ler o Klingo na hora em que o paciente chega ao calendário |
| `autoencerrar_modo` / `autoencerrar_horas` | `ligado` / `24` | Depois de 24 h sem resposta, marcar para chamar no WhatsApp (não encerra mais) |
| `reabrir_dias` | `2` | Janela para reabrir por mensagem |
| `encerramento_exige_motivo` | `sim` | Motivo obrigatório ao encerrar |
| `encerramento_valida_agendado` | `sim` | Conferir a agenda quando encerra como "Agendado" |
| `avaliacao_ativa` | `sim` | Convite para avaliar no fim |
| `indicadores_fechar` | `sim` | Congelar os indicadores do dia |
| `permissao_modo` | `observacao` | Permissões por unidade: só observa, **não bloqueia** |
| `login_paciente` | `sim` | Conta opcional do paciente |
| `agendamento_reconhecer` | `sim` | Reconhecer agendamento no Klingo |
| `vinculo_manual_quem` | `equipe` | Quem liga paciente a prontuário |
| `jornada_relatorio_id` / `_filtro` | `14359` / `exame` | Relatório do Klingo usado na Jornada |

Segredos e endereços (`ia_segredo`, `*_url`, `fila_vapid_publica`) existem mas não são listados aqui.

## 8. Testes

`cd testes && npm install && CHROMIUM_PATH=/opt/pw-browsers/chromium npm test` roda **69 suítes**. Quatro famílias:

| Família | Arquivos | O que prova |
|---|---|---|
| Sincronismo | `retrato.test.mjs` | Cada função que as telas chamam existe no banco com os mesmos parâmetros e permissões; rotinas e gatilhos apontam para funções que existem. Roda em 1 s, sem banco. |
| **Clone da produção** | `banco-producao.mjs`, `sql-producao.test.mjs`, `sql-ponta-a-ponta.test.mjs` | Monta um Postgres embutido com a **estrutura real da produção** e roda nela: o paciente do "Começar" ao pedido enviado, a equipe assumindo e encerrando, as travas de segurança e cada correção da auditoria. |
| Módulos (arquivos `supabase/*.sql`) | `sql-*.test.mjs` | Cada mudança isolada, com tabelas de mentira. Úteis como história; **não provam o banco real**. |
| Telas | `*.navegador.mjs` | Chat, painel e Minha vez num navegador de verdade com o Supabase simulado. |

Ferramentas: `mock-chat.mjs` (servidor de mentira do chat, com atraso, erro e queda de rede), `stubs-supabase.mjs`, `carga.mjs` (100 pacientes ao mesmo tempo).

**O que os testes não provam:** o Supabase real (rede, Realtime por WebSocket, push), o Klingo e o e-mail. Para isso existe a conferência direta na produção descrita na auditoria.

## 9. Como publicar e como mudar o banco

- **Telas:** tudo que entra na branch `main` é publicado sozinho pelo GitHub Pages em ~1 minuto. Conferir: https://github.com/clinicacsiia/webchat/actions
- **Ao mudar o chat ou o painel:** trocar `VERSAO_APP` (chat) e `VERSAO` nos `sw.js`, para os aparelhos buscarem a versão nova.
- **Banco:** escrever um arquivo em `supabase/` (com fluxograma, versão e rollback), **testar no clone** (`sql-producao.test.mjs`), aplicar em partes pequenas pelo conector do Supabase, conferir o efeito na produção e **refazer o retrato** (`supabase/producao/LEIAME.md`).
- Comando com `delete`/`drop`: o Supabase pede confirmação ao dono na tela e espera só 60 s. Preferir `create or replace`; quando não der, o dono roda no editor SQL.
- **Voltar atrás:** quase tudo tem chave em `config` (seção 7) ou a definição anterior guardada no retrato (histórico do git de `supabase/producao/funcoes/`).

## 10. Onde olhar quando algo dá errado

| Sintoma | Onde olhar |
|---|---|
| Paciente informa um código `CSI-...` | Painel > Aprendizado > incidentes (tabela `incidente_chat`): mostra a chamada, o erro e os tempos, sem o texto da conversa |
| "Demorou e deu erro" no chat | Erro `57014` = passou de 3 s. Ver `incidente_chat` e a lista de consultas lentas (auditoria, seção 3) |
| Conta nova ou "esqueci a senha" não chega | Supabase > Authentication > Logs. Em 10/11/2026 o Gmail recusava a senha do SMTP (ver pendências) |
| Número do indicador mudou | Dias fechados ficam em `ind_fechamento`; o dia de hoje ainda muda |
| Horário oferecido já ocupado | `agenda_ao_vivo` (leitura na hora) e `agenda_ocupacao_meta` (última leitura geral) |
| Banco crescendo | Painel do Supabase > Database > tamanho das tabelas; `realtime.messages` e `cron.job_run_details` eram os vilões (auditoria, seções 2.1 e 2.5) |
| Rotina parou | `cron.job_run_details` (consulta na seção 5) |

## 11. Glossário

- **Motor / fluxo**: as regras no banco que conduzem a conversa por botões.
- **Pedido (pré-agendamento)**: o que o paciente montou; vira agendamento quando a equipe marca no Klingo.
- **Previsão**: dia e horário que o chat mostra. Só vale depois da confirmação de uma pessoa.
- **Jornada**: o quadro que acompanha o paciente do primeiro contato ao resultado.
- **RLS**: regra de acesso por linha do Postgres. É o que impede um papel de ler o que não deve.
- **Retrato**: a cópia da estrutura da produção em `supabase/producao/`.
- **Sentinela**: o monitor do chat que gera os códigos `CSI-...`.
