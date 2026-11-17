# Documentação do Webchat da CSI

Versão 3.8 — 17/11/2026 / Mudança: **Previsão de marcação: tela "Pedir uma previsão"** (lista de exames e consultas com busca, turno / a partir de / até / até o dia ou sem escolher, disponibilidade prevista da grade e pedido à equipe; funções `pmarc_catalogo`, `pmarc_disponibilidade`, `pmarc_pedido`; ver [`previsao-marcacao.md`](previsao-marcacao.md)). Versão 3.7 — 17/11/2026 / Mudança: **Webchat de Previsão de marcação** (`previsao/index.html`, segundo webchat sem robô; pré-cadastro de todas as pessoas com marcação aberta no Klingo a partir dos relatórios #14359 e #14554; botão **Previsão de marcação** no painel; tabelas `pmarc_*`, funções `pmarc_*` e `painel_pmarc_*`, Edge Function `pmarc-cadastrar`, rotina `pmarc-cadastrar`; chave `previsao_marcacao_modo`; ver [`previsao-marcacao.md`](previsao-marcacao.md)). Versão 3.6 — 17/11/2026 / Mudança: **consulta na mesma especialidade com menos de 30 dias vai para a atendente** (o chat avisa que o atendimento tem menos de 30 dias e não marca; especialidade deduzida do médico na agenda, histórico em `consulta_feita`; chaves `retorno_dias_modo` (ligada) e `retorno_dias_limite`; funções novas `retorno_recente_ok` e `fluxo_retorno_equipe`; `supabase/retorno-30-dias-parte1..4.sql`, teste `test:retorno-30-dias`, painel `sw.js` v58; ver [`retorno-30-dias.md`](retorno-30-dias.md)). Versão 3.5 — 17/11/2026 / Mudança: **o médico que o paciente escolheu nunca é trocado nem oferecido de novo** (o calendário mostra só os horários dele(a), procura nas 3 janelas da API, 45 dias; sem horário avisa e, ao toque do botão, o paciente digita os dias da semana, o turno e até que dia pode ir, e abre a solicitação de disponibilidade futura só com esse médico para a atendente avaliar; `chat_horario_escolher` e `klingo_pode_marcar` recusam horário de outro médico; função nova `chat_medico_sem_horario_abrir`; `supabase/medico-escolhido-fica-parte1..6b.sql`, testes `test:medico-escolhido` e `test:medico-escolhido-nav`, chat `2026.11.17-2`; ver [`medico-escolhido-fica.md`](medico-escolhido-fica.md)). Versão 3.4 — 17/11/2026 / Mudança: **aba Indicadores refeita como história das marcações do chat** (só o webchat, sem a clínica toda) (agendados → saíram → ficaram → confirmaram → atendidos → faltaram, hoje e próximos dias, dia a dia, por atendente e o chat do site; funções `ind_agenda_periodo` e `painel_indicadores_agenda`; auditoria com dados reais em [`auditoria-indicadores-2026-11-17.md`](auditoria-indicadores-2026-11-17.md); painel `sw.js` v54). Versão 3.3 — 17/11/2026 / Mudança: **aba Indicadores enxugada** só com o uso do site (resumo, onde as pessoas param, por unidade/pedido/plano, comparação com o Klingo e autoatendimento; sem veredito bom/ruim, equipe, avaliações, conferência, clínica toda nem gráfico mensal; painel `sw.js` v50; ver [`indicadores-por-unidade.md`](indicadores-por-unidade.md)). Versão 3.2 — 16/11/2026 / Mudança: **primeira consulta com a médica só com atendente** (config `primeira_consulta_modo`/`_medicas`, desligada; histórico pelo relatório #14637 via Edge Function `sync-atendimentos-klingo`; tabelas `consulta_feita` e `primeira_consulta_liberada`; botão "Liberar autoatendimento" no painel; `supabase/primeira-consulta-parte1..6.sql`, teste `test:primeira-consulta`; ver [`primeira-consulta.md`](primeira-consulta.md)). Versão 3.1 — 16/11/2026 / Mudança: **valor do atendimento Particular antes de marcar** (passo `valor` do chat: preço da API do Klingo em destaque; concordou marca, recusou ou sem preço vai para a equipe sem cadastrar no Klingo; chave `particular_valor_modo`; tabela `klingo_preco_api`; Edge Function `klingo-preco`; `supabase/particular-valor-parte1..3.sql`, teste `test:particular-valor`; ver [`particular-valor.md`](particular-valor.md)). Versão 3.0 — 16/11/2026 / Mudança: **marcação automática por unidade** (Configurações > Marcação automática por unidade; chaves `marcacao_auto_desenvoar`, `_csi`, `_rmtc`; unidade desligada some dos horários do chat, o paciente recebe o aviso e a equipe agenda; `supabase/marcacao-automatica-por-unidade-parte1..4.sql`, teste `test:marcacao-por-unidade`). Versão 2.9 — 16/11/2026 / Mudança: Indicadores — mudar as datas do período carrega sozinho (sem precisar clicar em Ver período), data futura ou incompleta avisa em vez de voltar para hoje em silêncio (painel `sw.js` v39; teste novo em `indicadores.navegador.mjs`). Versão 2.8 — 16/11/2026 / Mudança: **laudos no aplicativo** (cartão Meus laudos; baixar o PDF quantas vezes quiser, conferindo o Klingo a cada download; 2 tabelas `app_laudo*`, 8 funções `app_laudos_*` só do servidor, Edge Function `app-laudos`; ver `laudos-no-app.md`). Versão 2.7 — 15/11/2026 / Mudança: o chat não pede de novo CPF, nascimento e nome da mãe (`dados_ident` só nome e sexo) e a 1ª mensagem não repete o pedido de CPF (`supabase/dados-ident-sem-repetir.sql`; `fluxo_perguntar` e `fluxo_aplicar`; teste `test:dados-ident-sem-repetir`). Versão 2.6 — 15/11/2026 / Mudança: tela inicial do chat refeita (logo sempre no topo, sem a capa grande, "Olá, nome!" com Meus dados e Sair, aviso curto, "Começar" antes de "Acompanhe seus pedidos"; `acesso-rapido-paciente.md`). Versão 2.5 — 15/11/2026 / Mudança: Acompanhe seus pedidos mostra o estado da conversa no painel (encerrada com motivo), avaliar, reabrir, cancelar e apagar, apagar sozinho em 30 dias e nova ordem (`acompanhar-pedidos.md`; 3 funções novas `app_pedido_apagar`, `app_pedido_reabrir`, `app_pedido_avaliar`). Versão 2.4 — 15/11/2026 / Mudança: funções `painel_simulacao_acerto` e `sim_causa` registradas no retrato (já estavam na produção); `sim_*` abertas ao `anon` conferidas (puras). Versão 2.3 — 15/11/2026 / Mudança: **Simulação da clínica** (`simulacao/`: indicadores primeiro, área externa, 3D dos pontos de atenção, gráficos refeitos; funções `sim_unidade`, `sim_modalidade`, `painel_simulacao_dia`, `painel_simulacao_indicadores`, `painel_simulacao_externa`; botão no painel; detalhes em `simulacao.md`). Versão 2.2 — 15/11/2026 / Mudança: auditoria do PIN no sistema todo (ver `auditoria-pin-2026-11-15.md`): `app_pin_token`/`app_pin_exigir`/`app_pin_exigir_leitura` (trava do servidor para 49 funções do paciente), `app_pin_fraco` (PIN óbvio), `minha-vez` no modelo do PIN, testes `test:acesso-pin-total`, `test:acesso-pin-fraco`, `test:minha-vez-pin`. Versão 2.1 — 15/11/2026 / Mudança: PIN também no servidor (`app_pin_exigir`, `app_pin_servidor`, aplicada desligada), `/acesso/` com o azul e o logo da CSI, `test:acesso-pin-servidor` e `test:ao-vivo-pin`. Versão 2.0 — 15/11/2026 / Mudança: correção do chat que abria sem PIN para quem já tinha o service worker (`sw.js` v51 não serve mais `/acesso/` nem caminhos desconhecidos com a cópia do chat; trava de laço da porta agora bloqueia em vez de abrir; chat `2026.11.15-7`; teste `test:acesso-sw`). Versão 1.9 — 15/11/2026 / Mudança: aba **Acessos** no botão Pendências do painel (lê `painel_app_acessos`) e coordenadas aproximadas da clínica em `config`. Versão 1.8 — 15/11/2026 / Mudança: PIN obrigatório **no ar** (banco aplicado, `app_pin_obrigatorio` e `app_local_ativo` = `sim`, telas publicadas pelo PR #188), `app_acesso_log` com permissão de tabela fechada para o público, função `app_acesso_limpar` e rotina `app-acesso-limpar`; política de privacidade com IP, localização e CPF obrigatório. Versão 1.7 — 15/11/2026 / Mudança: PIN obrigatório na porta do chat (interruptor `app_pin_obrigatorio`, desligado), CPF antes do PIN, pré-preenchimento pelo histórico, registro de acessos e posição opcional (tabela `app_acesso_log`, 10 funções; ver `acesso-rapido-paciente.md`; **aplicado na produção em 15/11/2026**). Versão 1.6 — 15/11/2026 / Mudança: "Acompanhe seus pedidos" (botão grande e balão no chat, check-in com login automático, pedidos de todos os filhos, remarcar/cancelar/resultado pela conversa, resultados guardados à parte; tabelas `app_conversa` e `app_resultado`, 13 funções, Edge Function `app-resultados-vigiar` desligada, rotina `app-resultados-vigia`; ver `acompanhar-pedidos.md`). Versão 1.5 — 15/11/2026 / Mudança: acesso rápido (celular + PIN) LIGADO e descrito (tabelas `app_*`, pendências, filhos, contas antigas), botão Pendências no painel, catálogos CSI e CSI RM/TC ligados, modos do Klingo coerentes com o "sempre ligado". Versão 1.4 — 14/11/2026 / Mudança: pós-agendamento (ver, cancelar, remarcar, resultado), próximo horário do médico só da API, `klingo-agendamento` mantida com trava no servidor, painel com chaves por capacidade, "não fica preso" (veja `reestruturacao-2026-11-14/`). Versão 1.3 — 14/11/2026 / Mudança: reestruturação do WebChat (calendário só com horários reais da API; previsão virou solicitação de disponibilidade futura; modos por capacidade e trilha de configuração; retrato refeito). Ver [`reestruturacao-2026-11-14/`](reestruturacao-2026-11-14/00-leia-primeiro.md); **as migrações `supabase/webchat-v2-parte1..3` ainda NÃO estão aplicadas na produção** (aprovação do dono). Versão 1.2 — 13/11/2026 / Mudança: conferência Klingo × webchat (aba Indicadores seção 3 e dois avisos novos; ver `klingo-conferencia.md`). Versão 1.1 — 12/11/2026 / Mudança: autoatendimento com a API do Klingo (CPF + nascimento obrigatórios, horários reais, marcação automática, revisão dos pacientes antigos); corrigidas as divergências D1 a D3 do planejamento. Versão 1.0 — 11/11/2026: primeira documentação única do sistema, escrita na auditoria de 11/11/2026

Este é o documento para **entender o sistema inteiro**: o que é cada pasta, cada arquivo, cada peça do banco e como elas se falam. Os outros arquivos de `docs/` contam a história de cada mudança; este diz **como as coisas são hoje**.

- O que foi auditado e corrigido em 11/11/2026: [`auditoria-2026-11-11.md`](auditoria-2026-11-11.md)
- O que depende do dono: [`pendencias-do-dono.md`](pendencias-do-dono.md)
- **Simulação da clínica (15/11/2026):** [`simulacao.md`](simulacao.md): dados reais do Klingo + indicadores, testes de capacidade e painel Decisão
- **Autoatendimento com a API do Klingo (12/11/2026):** [`klingo-autoatendimento.md`](klingo-autoatendimento.md); desenho completo e riscos em [`planejamento-autoatendimento-klingo.md`](planejamento-autoatendimento-klingo.md)
- **Páginas de agendamento (abandonadas e removidas em 14/11/2026):** a página nova da família e a página técnica `/agendamento/completo/` foram apagadas do repositório, junto com a Edge Function `klingo-agendamento` e os testes delas. O código está no histórico do git (commits `8890756`, `d389d3c` e anteriores). **A função `klingo-agendamento` (versão 2) continua publicada no Supabase até o dono apagá-la** em https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions. Nada de banco foi criado por elas.
- **Reestruturação de 14/11/2026 (diagnóstico, arquitetura, matrizes, plano de publicação, pendências):** [`reestruturacao-2026-11-14/`](reestruturacao-2026-11-14/00-leia-primeiro.md)
- A estrutura real do banco de produção: [`../supabase/producao/`](../supabase/producao/LEIAME.md)

---

## 1. O que o sistema faz

Um paciente abre o chat no celular, diz se quer **exame**, **consulta** ou **outro assunto**, escolhe o exame (por foto do pedido médico, por uma lista com caixinhas e busca ao digitar, com o boneco acendendo a parte marcada, ou pelo nome), o plano, um dia e horário **que a API do Klingo devolveu como livre** (desde 14/11/2026 o calendário nunca mostra horário calculado pela grade; sem horário o paciente registra a **disponibilidade futura** ou fala com a equipe) e informa os dados do cadastro. O pedido chega pronto ao **painel** da equipe, que marca no Klingo e confirma com o paciente, ou o chat marca sozinho quando liberado. Desde 12/11/2026 o chat também pede **CPF e data de nascimento** (obrigatórios), confere o cadastro na **API do Klingo** e, quando liberado (`config.klingo_api_marcar`), **marca sozinho** consultas e exames Particular com um horário real, mostrando o cartão do agendamento; tudo que não for seguro continua indo para a equipe. As rotinas de relatório continuam só lendo. Ver [`klingo-autoatendimento.md`](klingo-autoatendimento.md).

Três telas, um banco:

| Tela | Para quem | Endereço | Arquivo |
|---|---|---|---|
| Chat | Paciente | `https://clinicacsiia.github.io/webchat/` | `index.html` |
| Painel | Equipe (atendentes, supervisão, TI, marketing) | `https://clinicacsiia.github.io/webchat/painel/` | `painel/index.html` |
| Minha vez (check-in) | Paciente na recepção (fila de chegada); desde 15/11/2026 também **Acompanhe seus pedidos** (login automático pelo acesso rápido) | `https://clinicacsiia.github.io/webchat/minha-vez/` | `minha-vez/index.html` |
| Previsão de marcação (17/11/2026) | Paciente com marcação aberta no Klingo (link pessoal ou celular + nascimento); sem robô, sem PIN | `https://clinicacsiia.github.io/webchat/previsao/` | `previsao/index.html` · detalhes em [`previsao-marcacao.md`](previsao-marcacao.md) |
| Simulação da clínica | Equipe logada (admin e atendente): dia real do Klingo, simulação de filas e capacidade, painel **Decisão** (15/11/2026) | `https://clinicacsiia.github.io/webchat/simulacao/` | `simulacao/index.html` · detalhes em [`simulacao.md`](simulacao.md) |
| Acesso rápido | Paciente (celular + PIN; filhos, números de confiança, solicitações de marcação, pendências de cadastro). **Ligado desde 15/11/2026** (`app_acesso_modo`) | `https://clinicacsiia.github.io/webchat/acesso/` | `acesso/index.html` · detalhes em [`acesso-rapido-paciente.md`](acesso-rapido-paciente.md) |

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
3. **O Klingo é a verdade da agenda.** Rotinas leem relatórios do Klingo o tempo todo (ocupação da agenda, marcações, catálogo, preços) e o chat mostra horários a partir disso (previsão). A API externa do Klingo dá os horários livres de verdade e a marcação: a função `klingo-executar` marca, só a partir de uma operação aprovada pelo banco, e só nos modos liberados.

## 3. As pastas, uma a uma

### 3.1 Raiz (o que o GitHub Pages publica)

| Arquivo | O que é |
|---|---|
| `index.html` | **Chat do paciente.** Página única (HTML + CSS + JavaScript, sem biblioteca além do `supabase-js`). Formulário inicial, conversa, perguntas com botões, pedido por lista com caixinhas + boneco só de visualização, foto do pedido com leitura no celular (Tesseract), calendário, login opcional, "Meus dados", sino dos avisos. Versão em `VERSAO_APP`. |
| `sentinela.js` | **Monitor do chat.** Observa a conversa no aparelho do paciente: mensagem fora de ordem, tela travada, resposta que demora, erro de chamada. Tenta curar sozinho, fala com o paciente numa faixa e gera o código de suporte `CSI-AAMMDD-HHMM-TIPO-XXXX`, que a equipe pesquisa no painel. Nunca registra texto de mensagem nem dado pessoal. Se não carregar, o chat funciona igual. **Chat em versão antiga (antes de 2026.11.15-8) recusado pelo servidor com `pin_obrigatorio`** (a trava de PIN do servidor, ligada em 15/11): a Sentinela 1.2 explica, pede para atualizar e, ao toque, apaga a cópia velha do aparelho, leva ao PIN (`acesso/?voltar=chat`) e o chat reabre a MESMA conversa guardada; vira incidente tipo `PIN` (sem alarme). Teste: `npm run test:sentinela-pin-antigo`. |
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
| Atendimento > Pendências | Botão com contador (solicitações do acesso rápido + cadastros para conferir + contas antigas sem PIN). Três abas: **Solicitações** (Confirmar, Concluir, Cancelar; o paciente vê a situação), **Cadastros para conferir** (dúvida com a base da clínica; "Marcar como conferido") e **Contas antigas sem PIN** (chamar no WhatsApp). Funções `painel_app_*` | admin e atendente |
| Atendimento > Equipe agora | Botão no alto da aba, **só para TI, gerência e supervisão** (`org_nivel()`): por atendente, quantas conversas tem, quantos pacientes esperam resposta (e há quanto tempo), quantos a equipe espera, quantos para chamar no zap, quantos marcou hoje. Sai das conversas já carregadas no painel; só "Marcou hoje" usa `painel_indicadores_atendentes` | chefia |
| Jornada | Onde está cada paciente (dados do Klingo + chat), com alertas de atraso | admin e atendente |
| Fila | Fila de chegada da recepção | admin e atendente |
| Disponibilidade futura (antiga Lista de previsão) | Solicitações de pacientes que pediram aviso quando surgir vaga (NÃO é agendamento nem reserva), com filtros por situação, histórico e "Precisa de pessoa" | admin e atendente |
| Avisos | "Mesma pessoa?", data de nascimento diferente, paciente × Klingo, pedidos de acesso | admin e atendente |
| Indicadores | Só o webchat: marcações do chat no Klingo (agendados, confirmaram, atendidos, faltaram, hoje e próximos dias, dia a dia), por atendente; e o uso do chat do site (funil, onde param, comparação com o Klingo, autoatendimento) | admin e atendente |
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

Um documento por mudança ou decisão. Os mais úteis para começar: este; `auditoria-2026-11-11.md`; `pendencias-do-dono.md`; `planejamento-auditoria-2026-11-10.md` (decisões do dono, com as regras dos indicadores e das permissões); `klingo-relatorios-pendentes.md` (o que o Klingo entrega e o que falta); `klingo-conferencia.md` (por que os números do painel divergem do Klingo, conflitos e dados faltando); `klingo-api-externa/GUIA-COMPLETO.md` (manual da API externa do Klingo), `klingo-api-agendamento.md` e `klingo-api-externa/` (API externa do Klingo: documentação oficial, testes reais e plano do agendamento automático); `fase7-motor-implementado.md` (o motor do chat).

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
| Agenda | `catalogo_agenda` (grade) e `agenda_ocupacao` (o que o Klingo tem marcado): **só planejamento, conferência e diagnóstico, nunca vaga reservável**; `agenda_ao_vivo`, regras de duração e sala | `agenda_*`; `chat_horarios` e `chat_horario_escolher` leem **só** `klingo_oferta` (API) |
| Catálogo e preços | `catalogo_procedimento`, `catalogo_plano`, `catalogo_preco`, `catalogo_regiao`, `catalogo_mudanca`, `consulta_config` (quais consultas aparecem no chat), `chat_cache` (respostas prontas) | `catalogo_*`, `preco_*`, `consultas_*` |
| Convênios e médicos | `convenio_config`, `medico_*`, `profissional_bloqueio` | `convenio_*`, `medico_*` |
| Jornada (Klingo) | `jornada_paciente`, `jornada_card`, `jornada_exame`, `jornada_evento`, `jornada_tarefa` | `jornada_*` |
| Equipe e permissões | `agentes`, `org_equipe`, `org_membro`, `permissao_observacao`, `equipe_notificacao` | `org_*`, `equipe_*`, `papel_atual` |
| Indicadores | `ind_fechamento`, `ind_pessoa_dia`, `ind_conclusao_dia`, `ind_semhumano_dia` | `painel_indicadores_*`, `ind_*` |
| Conferência Klingo × webchat | `klingo_conferencia` (uma linha por marcação do relatório #14554: origem, ligação com a conversa, campos que divergem ou faltam; sem dado pessoal) | `klingo_conferir_lote`, `klingo_conferir_avisos`, `klingo_conferencia_agendar`, `painel_indicadores_conferencia`; Edge Function `klingo-conferir`; avisos `klingo_conflito` e `klingo_dado_faltando` |
| Fila de chegada | `fila_chegada`, `fila_aviso`, `push_inscricao` | `fila_*`, `checkin_publico` |
| Diagnóstico | `incidente_chat` (códigos da Sentinela), `autoencerramento_execucao` | `chat_incidente`, `painel_incidentes` |
| Disponibilidade futura (v2.0) | `disponibilidade_pedido` (estados `ativa`, `oportunidade_identificada`, `notificada`, `aguardando_resposta`, `convertida_em_agendamento`, `expirada`, `cancelada`), `disponibilidade_evento`, `disponibilidade_oportunidade`, `disponibilidade_notificacao`; `pedido_previsao` ficou sem uso (0 linhas) | `chat_disponibilidade_*`, `disponibilidade_*`, `painel_disponibilidade_*`, rotina `previsao_vigiar` |
| Modos e auditoria (v2.0) | `config_auditoria` (toda mudança de config), `klingo_consulta` (resultado de cada consulta à API, sem dado pessoal), `klingo_oferta.sombra` | `klingo_modo`, `klingo_ativo`, `klingo_sombra`, `klingo_promover`, `klingo_recomendar` |
| Autoatendimento Klingo | `klingo_identidade` (CPF conferido, só hash), `klingo_oferta` (horários que a API ofereceu à conversa), `klingo_operacao` (cada marcação: estado, voucher, código), `klingo_plano_map` e `klingo_convenio` (tradução convênio → plano), `klingo_especialidade`, `klingo_cota` (limite de chamadas), `klingo_medida`, `klingo_decisao` (o que a autogestão decidiu), `klingo_evento`, `klingo_proc_api`, `klingo_conversa_ident` | `klingo_*`, `painel_automacao_resumo` |
| Acompanhar pedidos (15/11/2026) | `app_conversa` (conversas que o aparelho provou ter + o que já viu), `app_resultado` (estado do resultado de cada exame feito). RLS sem regra | `app_conversa_vincular`, `app_pedidos`, `app_pedidos_contagem`, `app_pedido_visto`, `app_pedido_acao`, `app_resultado_arquivo`; internas `app_pedido_dados`, `app_resultados_*`; `painel_resultado_entregue`. Detalhes: [`acompanhar-pedidos.md`](acompanhar-pedidos.md) |
| Laudos no aplicativo (16/11/2026) | `app_laudo_pessoa` (conferência de cada pessoa, só hash), `app_laudo` (marcações atendidas + estado do laudo; **sem PDF**). RLS sem regra | `app_laudos_contexto`, `app_laudos_pessoas`, `app_laudos_pessoa_gravar`, `app_laudos_itens_gravar`, `app_laudos_a_checar`, `app_laudos_estado`, `app_laudos_lista`, `app_laudos_pode` (todas só do `service_role`). Chave `app_laudos`. Detalhes: [`laudos-no-app.md`](laudos-no-app.md) |
| Acesso rápido do paciente (15/11/2026) | `app_paciente` (titular, PIN em bcrypt, CPF, e-mail, `conta_antiga_id`, marca de revisão), `app_aparelho` (só hash do código), `app_filho`, `app_contato_confianca`, `app_marcacao` (solicitações), `app_evento` (sem dado pessoal). Todas com RLS sem regra: só as funções leem e gravam | `app_*` (paciente, com a chave pública), `painel_app_*` (equipe logada). Detalhes: [`acesso-rapido-paciente.md`](acesso-rapido-paciente.md) |
| PIN obrigatório (15/11/2026, **no ar**) | `app_acesso_log` (cada entrada: aparelho, IP, posição arredondada e "na clínica"; só a equipe lê, por `painel_app_acessos`; o público não tem nem permissão de tabela; apagada em 180 dias por `app_acesso_limpar`, rotina `app-acesso-limpar` às 03h47 de Brasília) | `app_porta`, `app_pre_cadastro`, `app_pin_criar`, `app_acesso_registrar`, `app_chat_dados_resumo`, `app_dados_atualizar`, `painel_app_acessos`; internas `app_chat_pessoa`, `app_cpf_historico`, `app_acesso_gravar`, `app_acesso_limpar`, `app_distancia_m`. Chaves em `config`: `app_pin_obrigatorio`, `app_local_ativo`, `clinica_lat`, `clinica_lng`, `clinica_raio_m` |
| Simulação (15/11/2026) | Nenhuma tabela nova: lê `jornada_exame`, `jornada_card`, `jornada_evento`, `klingo_conferencia`, `pre_agendamentos` e `fila_chegada` | `sim_unidade`, `sim_modalidade` (puras), `painel_simulacao_dia`, `painel_simulacao_indicadores`, `painel_simulacao_externa` (só admin e atendente logados); lê também `conversas`, `pre_agendamentos` e `app_resultado`. Detalhes: [`simulacao.md`](simulacao.md) |
| Valor Particular (16/11/2026) | `klingo_preco_api` (preço da API por exame e plano, sem dado de paciente; RLS sem regra) | `particular_valor_ativo`, `particular_valor_obter`, `particular_valor_assinatura`, `particular_valor_disparar`, `particular_plano_id`, `klingo_preco_gravar` (todas só do `service_role`). Chave `particular_valor_modo` (`sim`/`nao`). Detalhes: [`particular-valor.md`](particular-valor.md) |
| Configuração | `config` (chave → valor) | — |

### 4.1 Como o paciente é protegido

- `anon` (paciente sem login) tem **limite de 3 segundos** por chamada; a equipe logada, 8 segundos. Por isso toda função do chat precisa ser rápida.
- Limites embutidos: 5 conversas por hora por telefone, 20 mensagens por minuto por conversa.
- A conversa só abre com o par (id, token). Token errado devolve erro `28000`.
- Conta de paciente logada **não** é equipe: `papel_atual()` devolve nulo e ela não lê tabela nenhuma.
- O aviso no celular (push) nunca leva nome nem texto: só "você recebeu uma resposta".

### 4.2 O caminho do motor (função `fluxo_proximo`)

`motivo` → `exame` ou `consulta` (ou `assunto`) → `medico` (só consulta, se houver mais de um) → **`cpf_nasc`** (CPF e nascimento válidos, obrigatórios; 12/11/2026) → `plano` → `horario` → `dados_ident` (só nome e sexo desde 15/11/2026) → `dados_contato` → `confirmar` (a carteirinha deixou de ser perguntada em 12/11/2026) → pronto (o pedido vai para a equipe) **ou** `marcando` → `marcado` → `pos_menu` (quando a marcação automática vale para a conversa).

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
| `klingo-operacao-vigia` | 1 min | Refaz chamada perdida do executor, marca como INCERTO o que ficou preso e encerra a conversa resolvida sozinha há 2 h |
| `pedido-horario-vigia` | 5 min | Pedido pronto sem horário (passou ou ocupado): o assistente oferece o horário livre mais próximo, depois o seguinte, depois pede que o paciente escolha no calendário (passo `horario_oferta`); horário livre e parado 24 h: faixa para o atendente. Começa em `teste` (`pedido_horario_modo`). Ver `pedido-sem-horario.sql` |
| `previsao-vigia` | 10 min | (v2.0) Motor de **disponibilidade futura**: expira solicitações, devolve oportunidade vencida, entrega avisos autorizados e dispara a Edge `disponibilidade-vigia` (procura vaga REAL na API). Nunca marca nada. Ver `webchat-v2-parte3-disponibilidade-futura.sql` |
| `klingo-autogestao` | 10 min | (v2.0) **Só recua** (suspende por risco) e **recomenda**; nunca avança chave. Promover = `klingo_promover` (administrador, com justificativa) |
| `klingo-revisar-pacientes` | 5 min | Confere na API do Klingo quem deixou CPF + nascimento e ainda não foi conferido |
| `klingo-sincronizar` | 03:50 | Copia convênios, planos e especialidades da API e traduz o convênio do chat |
| `klingo-limpeza` | 04:27 | Apaga ofertas, medidas e avisos antigos do autoatendimento |
| `app-resultados-vigia` | 10 min | Pergunta ao Klingo (relatório C) se o laudo dos exames feitos de quem tem acesso rápido já está pronto. **Só age com `app_resultado_vigia = sim`** (hoje `nao`) |

Horários em Brasília. Conferir a saúde delas: `select jobname, status, count(*) from cron.job_run_details d join cron.job j using (jobid) where start_time > now() - interval '1 day' group by 1, 2;`

## 6. Edge Functions (`supabase/functions/`)

Todas publicadas **sem exigir JWT** e cada uma confere o próprio segredo.

| Função | Quem chama | Como prova quem é | No ar? |
|---|---|---|---|
| `sync-catalogo-klingo` | pg_cron | cabeçalho `x-sync-key` = `config.ia_segredo` | sim |
| `sync-jornada-klingo` | pg_cron | `x-sync-key` | sim |
<!-- 16/11/2026: a leitura do relatório (jornada_klingo_lote) também fecha o pedido do chat quando TODAS as marcações dele estão canceladas no Klingo (pedido_fechar_cancelado_klingo: pedido vira `cancelado`, alerta "Marcação sumiu do Klingo" sai, nota interna na conversa). É o que tira o "Exame em aberto" do painel; sem o webhook, o atraso é o da leitura (10 min no expediente, 1 a 2 h fora). Arquivo: supabase/cancelamento-klingo-pedido.sql -->
| `klingo-reconhecer` | pg_cron | `x-sync-key` | sim |
| `klingo-paciente` | gatilho do banco (CPF + nascimento) | `x-sync-key` | sim |
| `chat-agenda-ao-vivo` | o chat, ao chegar no calendário | token da conversa | sim |
| `chat-avisar`, `avisar-equipe`, `fila-avisar` | o banco (pg_net) | segredo do Vault `fila_aviso_segredo` | sim |
| `klingo-agenda-api` | diagnóstico: só **lê** horários (versão 0.4, sem escrita; marcar responde 410) | `x-sync-key` | sim |
| `chat-agenda-api` | o chat, ao chegar no horário (só leitura: grava as ofertas da API; v2.0: registra o resultado de cada etapa em `klingo_consulta`) | token da conversa | sim |
| `disponibilidade-vigia` | o banco (`previsao_vigiar`, pg_net) | segredo do cofre | **não ainda** (nova, v2.0) |
| `klingo-executar` | só o banco (pg_net), com o id de uma operação | segredo próprio do cofre (`klingo_interno_segredo`) | sim |
| `klingo-identificar` | o banco (gatilho do CPF e rotina de revisão) | segredo do cofre | sim |
| `klingo-sincronizar` | pg_cron (03:50) | segredo do cofre | sim |
| `klingo-webhook` | o próprio Klingo (aviso de cancelamento, remarcação, chegada) | `X-APP-TOKEN` = chave da clínica | sim (ligado só com `klingo_webhook = sim`) |
| `app-resultados-vigiar` | o banco (rotina `app-resultados-vigia`, 10 min) | segredo do cofre | sim, mas **desligada** (`app_resultado_vigia = nao`) |
| `app-laudos` | a tela Minha vez (cartão Meus laudos): listar e baixar | código do aparelho com PIN (conferido pelo banco) | sim (`verify_jwt=false`); busca o PDF no Klingo a cada download e **nunca o guarda** |
| `klingo-preco` | o banco (pg_net), ao escolher Particular e na confirmação | segredo do cofre (`klingo_segredo_ok`) | sim; só lê `GET /preco` da API e grava com `klingo_preco_gravar` |
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
| `marcacao_auto_desenvoar`, `marcacao_auto_csi`, `marcacao_auto_rmtc` | `sim` | Marcação automática por unidade: `nao` esconde os horários da unidade no chat, recusa a escolha e impede a marcação sozinha; o paciente é avisado e a equipe agenda |
| `particular_valor_modo` | `sim` | Particular vê o valor (da API do Klingo) antes de marcar; `nao` volta ao jeito de antes |
| `retorno_dias_modo` / `retorno_dias_limite` | `sim` / `30` | Consulta na mesma especialidade de um atendimento com menos de 30 dias: o chat avisa e passa para a atendente, sem marcar (`retorno-30-dias.md`); `nao` volta ao jeito de antes |
| `permissao_modo` | `observacao` | Permissões por unidade: só observa, **não bloqueia** |
| `login_paciente` | `sim` | Conta opcional do paciente |
| `agendamento_reconhecer` | `sim` | Reconhecer agendamento no Klingo |
| `vinculo_manual_quem` | `equipe` | Quem liga paciente a prontuário |
| `jornada_relatorio_id` / `_filtro` | `14359` / `exame` | Relatório do Klingo usado na Jornada |
| `klingo_api_horarios` | (sem efeito desde 14/11/2026) | Era o modo dos horários reais da API. O autoatendimento do Klingo é SEMPRE LIGADO (`webchat-v2-sempre-ligado.sql`); as chaves `klingo_auto`, `klingo_api_*`, `previsao_*`, `notificacao_modo`, `klingo_api_telefones_teste`, `klingo_api_percentual` e `klingo_autogestao` ficaram sem efeito e podem ser apagadas. Só `klingo_api_resultado` (laudo, sem integração) ainda segue a configuração. |
| `klingo_api_marcar`, `klingo_api_pre_cadastro`, `klingo_api_pos` (v2.0: `klingo_api_cancelar`, `klingo_api_remarcar`, `klingo_api_resultado`, `previsao_modo`, `previsao_monitor_modo`, `notificacao_modo`) | `teste` | Uma chave por capacidade: `nao` / `teste` (só os telefones da lista) / `sim`. O mestre `klingo_auto` só **limita**, nunca promove (ver `reestruturacao-2026-11-14/03-matriz-de-configuracao.md`) |
| `klingo_api_telefones_teste` | vazio | Celulares (só números, vírgula) que sempre usam a automação nos modos `teste` |
| `klingo_api_percentual` | `100` | No modo `sim`, que parte das conversas usa a automação (a autogestão sobe 10 → 50 → 100) |
| `klingo_autogestao` | `sim` | O sistema pode avançar/recuar os interruptores acima |
| `klingo_webhook` | `nao` | Aplicar os avisos do Klingo |

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
- **Horário da API**: horário que o Klingo devolveu como livre agora; é o único que o chat mostra como opção. Só fica marcado depois da confirmação e do protocolo.
- **Disponibilidade futura** (antiga "previsão"): pedido do paciente para ser avisado quando surgir vaga compatível. Não é agendamento, reserva nem promessa de vaga.
- **Jornada**: o quadro que acompanha o paciente do primeiro contato ao resultado.
- **RLS**: regra de acesso por linha do Postgres. É o que impede um papel de ler o que não deve.
- **Retrato**: a cópia da estrutura da produção em `supabase/producao/`.
- **Sentinela**: o monitor do chat que gera os códigos `CSI-...`.
