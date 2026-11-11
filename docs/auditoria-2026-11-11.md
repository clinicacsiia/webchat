# Auditoria completa — 11/11/2026

Versão 1.1 — 11/11/2026 (tarde) / Mudança: tudo o que estava "pronto, falta aplicar" foi aplicado e medido; trabalho juntado com as PRs #120 a #134 do dono; retrato refeito
Versão 1.0 — 11/11/2026 (manhã) / Mudança: auditoria do repositório e da produção, correções e documentação

**Em uma frase:** o sistema funciona de ponta a ponta, mas tinha dois defeitos sérios em produção que ninguém via (um enchia o banco, outro impedia a atendente de encerrar), um defeito no chat que gerava 21 erros por dia ao paciente e um banco que não batia com o repositório. **Tudo o que é de banco já está corrigido na produção**; as correções das telas estão no repositório e entram no ar quando esta branch for publicada.

Privacidade: na produção só li **estrutura, contagens, tempos e mensagens de erro técnicas**. Nenhum nome, telefone, CPF ou texto de conversa foi lido ou copiado.

> **Aviso sobre o Klingo (regra do `CLAUDE.md`):** nenhuma tarefa desta auditoria dependeu de relatório novo do Klingo. Continuam sem resposta do suporte as 4 perguntas de `docs/klingo-relatorios-pendentes.md` (preço Particular, link/senha de resultado, convênio inativado, última atualização do cadastro e hora real do atendimento). Elas não bloqueiam nada do que foi feito aqui.

---

## 1. Como a auditoria foi feita

| Frente | O que foi feito |
|---|---|
| Testes existentes | As 63 suítes rodadas uma a uma, antes de mexer em nada: 62 verdes, 1 falhando (`test:pessoa-sql`) |
| Produção: segurança | Avisos do Supabase (4 tipos), as 65 regras de acesso, as 49 funções abertas ao paciente e as 200 abertas a quem está logado |
| Produção: saúde | Tamanho do banco e das tabelas, 19 rotinas (falhas em 24 h), consultas mais caras desde 29/10, logs de erro do banco, do login e das Edge Functions em 24 h |
| Produção: o que o paciente sofreu | Os incidentes da Sentinela dos últimos 6 dias, agrupados por chamada e erro, com a sequência de chamadas de cada um |
| Telas × banco | As 136 funções que as 3 telas chamam, parâmetro por parâmetro, contra a produção |
| Repositório × banco | As 416 funções da produção contra todas as versões nos arquivos `supabase/*.sql` |
| Código | Chat, Sentinela, painel (carga e tempo real), service workers, Edge Functions, o motor (`fluxo_*`) |
| Publicação | A última publicação do GitHub Pages (commit `e0266a2`, 10/11 20:49, com sucesso) |

## 2. O que estava errado e o que foi feito

Legenda do estado: **NO AR** = aplicado e conferido na produção · **NO REPOSITÓRIO** = corrigido e testado, entra no ar ao publicar a branch (ver `pendencias-do-dono.md`, item 1.2).

### 2.1 Avalanche de avisos de tempo real: 193 mil por dia — **NO AR**

- **Evidência:** em 10/11 a tabela `realtime.messages` recebeu **193.461** avisos `jornada_mudou`, em rajadas de ~166 no mesmo segundo, uma vez por minuto. Ocupava **47 MB por dia** (o banco estava em 208 MB de 500 MB do plano). Cada portal "Minha vez" aberto refazia a consulta a cada aviso: 190 mil chamadas de `paciente_jornada` e 205 mil de `fila_minha_vez` acumuladas.
- **Causa:** a rotina de 1 minuto copia cada conversa para a Jornada com um `insert ... on conflict` por conversa, e o gatilho de INSERT avisava a cada comando, mesmo sem criar linha. A correção de 07/11 tinha calado só a leitura do Klingo.
- **Correção** (`supabase/jornada-avisos-enxutos.sql`): o gatilho só avisa se uma linha foi criada; a rotina fica calada e manda **um** aviso no fim, só se algo mudou.
- **Prova:** no clone da produção o defeito é reproduzido (6 avisos por rodada sem mudança) e some (0). Na produção, minuto a minuto: 166, 166, 166 … até 07:23; **0** a partir de 07:24. Num dia inteiro de trabalho: de **~9.960 por hora** para **33 a 60 por hora** (os avisos que sobram são mudanças de verdade).

### 2.2 Encerrar como "Agendado" estourava o tempo — **NO AR**

- **Evidência:** em 10/11, das 12:36 às 12:38, três tentativas de encerrar uma conversa como "Agendado" foram canceladas pelo banco por passar de 8 segundos. A atendente não conseguia encerrar.
- **Causa:** a conferência "essa pessoa tem exame no Klingo?" percorria todos os exames futuros e recalculava a ficha da pessoa para cada um. Medido: **43 segundos** somados para 70 conversas, até **5,9 s** numa só. O gatilho "engole" erros, mas o estouro de tempo não é um erro que o Postgres deixa engolir: derrubava o encerramento inteiro.
- **Correção** (`supabase/agendado-rapido.sql`): primeiro acha os poucos prontuários daquela pessoa, depois olha só os exames deles.
- **Prova:** antes de aplicar, a função nova foi comparada com a antiga em 70 conversas reais: **70 respostas idênticas**. Depois de aplicar: 70 conversas em **0,12 s**, a pior em 22 ms. Os 24 cenários antigos do "Agendado" passam com a função nova.
- De quebra: a função podia ser chamada direto por qualquer conta logada (inclusive conta de paciente) e dizia se uma conversa tinha exame e quando. Agora só o gatilho e a rotina a usam.

### 2.3 "Essa pergunta já foi respondida": 21 erros em 24 horas — **NO REPOSITÓRIO**

- **Evidência:** 27 incidentes em 5 dias. O registro de cada um mostra a mesma sequência: chega uma mensagem e, 1 a 20 segundos depois, o paciente toca num botão.
- **Causa:** quando a atendente assume a conversa, o servidor deixa de aceitar resposta às perguntas do assistente, mas **os botões dessas perguntas continuavam ligados** no celular do paciente. Ele tocava e recebia um erro que não fazia sentido para ele.
- **Correção** (`index.html`): quando a equipe assume, as perguntas do assistente se desligam e aparece "Uma pessoa da equipe está com você agora. Escreva sua resposta no campo aqui embaixo."; se o paciente tocar antes de a tela saber, a conversa se ajusta sozinha sem alarme. Também entrou a trava de "uma resposta por vez" (toque duplo, "Pular" logo depois de "Continuar").
- **Prova:** `testes/chat-equipe-assume.navegador.mjs` (9 verificações) e, no clone, a confirmação de que a regra do servidor é essa mesma.

### 2.4 Alarme falso de rede no chat — **NO REPOSITÓRIO**

- **Evidência:** 30 dos incidentes "falha ao falar com o servidor" em 5 dias eram a consulta de rotina do chat (a que ele repete sozinho a cada poucos segundos) falhando uma vez por rede do celular. O paciente via um aviso vermelho com código de erro.
- **Correção** (`sentinela.js` 1.1): falha isolada de rotina não mostra nada; na 3ª seguida aparece "A conexão está instável" (amarelo, sem código) e a equipe recebe **um** registro. Falha numa ação do paciente continua avisando na hora.

### 2.5 Histórico das rotinas crescendo sem limpeza — **NO AR**

- **Evidência:** `cron.job_run_details` tinha 41.924 linhas e **20 MB em 4 dias e meio** (há rotinas de 15 e 30 segundos). No ritmo, ~130 MB por mês.
- **Correção** (`supabase/manutencao-limpeza.sql`): rotina diária que apaga execuções com mais de 3 dias (falhas ficam 14).
- **Aplicação:** o comando tem `delete` e o Supabase pede a confirmação do dono na tela, com 60 segundos de espera. De manhã ninguém respondeu; à tarde foi aprovado. A primeira limpeza apagou **18.668** registros (de 52.890 para 34.274); a rotina `manutencao-limpeza` roda toda madrugada às 04:17.

### 2.6 "Mapa do corpo" lento no chat — **NO AR**

- **Evidência:** `chat_corpo` leva **1,1 s** com o banco livre (o limite do paciente é 3 s) e estourou 2 vezes em 09/11. O resultado é igual para todo paciente.
- **Correção** (`supabase/chat-corpo-cache.sql`): a resposta fica guardada pronta e é refeita a cada 10 minutos; o chat lê a cópia (~1 ms). Sem cópia recente, calcula na hora como antes.
- **Prova na produção:** a resposta de `chat_corpo` é idêntica à do cálculo antigo e sai em **0,9 ms** no lugar de **1.180 ms**. A rotina `chat-corpo-cache` refaz a cópia a cada 10 minutos; o paciente sem login não lê a tabela da cópia.

### 2.7 O painel refazia consultas pesadas a cada mensagem — **NO REPOSITÓRIO**

- **Evidência:** `pessoa_sugestoes` é a consulta que mais gastou o banco desde 29/10 (**15.243 chamadas, 7,3 horas de processamento**), chamada junto com outras 5 a cada mensagem que chega, em cada painel aberto. Hoje ela custa ~75 ms (foi otimizada em 08/11), mas cresce com o número de conversas.
- **Correção** (`painel/index.html`): as duas consultas pesadas são relidas no máximo 1 vez por minuto, e na hora quando a equipe decide algo ou abre os Avisos. E o painel passou a fazer **uma releitura por vez**: num pico, os eventos que chegam durante uma leitura viram uma única leitura depois (antes cada evento disparava a sua, todas ao mesmo tempo). Isto ataca o "travamento por atendente" (MON-04), que não tinha reprodução.
- **Prova:** `testes/painel-recarga.navegador.mjs`, com o tempo real do Supabase simulado: 10 mensagens = 10 releituras da lista e **0** consultas pesadas; 12 eventos com o servidor lento = 4 releituras, nunca duas juntas.

### 2.8 O banco não batia com o repositório — **RESOLVIDO (retrato)**

- **Evidência:** 31 funções da produção diferentes de qualquer versão do repositório e 52 que só existiam na produção (detalhe em `supabase/producao/LEIAME.md`). A pendência "versionar o módulo Jornada" estava aberta desde 01/11.
- **Correção:** a estrutura real da produção agora está em `supabase/producao/` e os testes novos rodam **contra ela**.

### 2.9 Teste que falhava conforme a hora — **CORRIGIDO**

- `test:pessoa-sql` falhava 3 verificações **das 21h às 00h20 de Brasília**: o teste usava dia e hora em UTC como se fossem hora local, e "20 minutos atrás" virava um horário do futuro. O produto estava certo. Provado com o relógio simulado: a versão antiga falha às 22h10; a nova passa às 22h10, às 00h05 e às 15h.

### 2.10 `npm test` não rodava tudo — **CORRIGIDO**

- 4 suítes ficavam de fora (`test:paciente-status`, `test:catalogo-painel`, `test:login-sql`, `test:carga`) e `test:login` rodava duas vezes. Agora as 69 suítes estão na cadeia, sem repetição.

### 2.11 E-mail de confirmação de conta não está saindo — **DEPENDE DE VOCÊ**

- **Evidência:** em 10/11, às 17:21, 17:22 e 17:23 (Brasília), três criações de conta falharam com `535 5.7.8 Username and Password not accepted` (resposta do Gmail); em 11/11 foram mais cinco (entre 8h e 10h). A senha de app configurada no Supabase deixou de valer.
- **Efeito:** conta nova (paciente ou equipe) e "esqueci a senha" **não funcionam** até a senha ser trocada. Quem já tem conta entra normalmente.

### 2.12 Segurança: o que foi conferido

| Item | Resultado |
|---|---|
| RLS | Ligada nas **99** tabelas. Nenhuma regra libera dado sem conferir o papel da equipe ou o dono da linha |
| Paciente sem login | Não lê nem grava tabela nenhuma; só funções `chat_*` com o token (provado no clone) |
| Conta de paciente logada | Não é equipe: 0 linhas em conversas, mensagens, pedidos, cadastros (provado no clone) |
| Marketing | Lê contatos; 0 linhas em mensagens e pedidos (provado no clone) |
| 49 funções abertas ao paciente | Todas conferem token, segredo ou são dados públicos |
| 200 funções abertas a quem está logado | Todas conferem o papel, exceto `agendamento_valido_para_encerrar` (fechada, item 2.2) |
| 9 funções de gatilho visíveis ao paciente | Eram inofensivas (não dá para chamá-las pela API); **fechadas** por `supabase/seguranca-ajustes.sql` (agora são 0) |
| Proteção contra senha vazada | **Desligada** (precisa do plano Pro; decisão sua) |
| Segredos | Nenhum no repositório nem no retrato (o gerador recusa) |
| Pendência conhecida, por decisão | Atendente ainda altera qualquer coluna de qualquer conversa pela API (PERF-04), e as permissões por unidade estão em modo observação |

## 2.13 O que o dono mudou no mesmo dia e como foi juntado

Enquanto a auditoria corria, o dono juntou **15 PRs (#120 a #134)** na `main` e aplicou **11 migrações**: Cardápio só Particular, consultas oferecidas no chat, expiração dos avisos da Jornada, "24 h sem resposta marca para chamar no WhatsApp" (no lugar de encerrar), correções da conferência com o Klingo e religar conversas sem prontuário.

- O trabalho da auditoria foi **reposto em cima dessa `main`**. Houve conflito em dois arquivos, resolvidos guardando as duas mudanças: no painel, os "cards que se corrigem sozinhos" (#124) passaram a respeitar a regra de "uma releitura por vez" (item 2.7); em `testes/package.json`, a cadeia ficou com o teste novo do dono (`test:autoencerrar-zap-sql`).
- As 3 correções aplicadas de manhã **continuavam intactas** na produção à tarde (conferido função por função).
- O retrato foi refeito três vezes no dia e **mostrou exatamente o que mudou**: de manhã, as 3 funções da auditoria; à tarde, as 6 funções novas, 9 alteradas, 1 tabela, 3 colunas e 1 rotina do dono; no fim, as 3 funções e a tabela das últimas migrações da auditoria.
- Com tudo junto: telas × banco 10 de 10, correções 29 de 29, ponta a ponta 19 de 19.

## 3. O que foi conferido e estava certo

- **Telas × banco:** as 136 funções chamadas pelas 3 telas existem na produção com os mesmos parâmetros e permissões (155 chamadas, 109 com parâmetros).
- **Banco por dentro:** nenhuma função chama função ou tabela que não existe; os 56 gatilhos e as 18 rotinas apontam para funções que existem; as 96 funções em SQL puro e as 5 visões conferem com as tabelas.
- **Rotinas:** nenhuma falha em 24 h (16.000 execuções).
- **Publicação:** o site publicado é o commit mais novo da `main`.
- **Fluxo do paciente com o código real** (no clone): exame e consulta do "Começar" ao pedido enviado; "nenhum horário serve"; horário escolhido deixa de ser oferecido a outro paciente; limites de 20 mensagens por minuto e 5 conversas por hora; dados inválidos recusados com mensagem.
- **Fluxo da equipe com o código real:** assumir, responder, encerrar com motivo, reabertura em até 2 dias, recusa depois disso, linha do tempo e registro do fechamento.
- **Edge Functions em 24 h:** `sync-catalogo-klingo` 99,4% de sucesso, `klingo-reconhecer` 99,7%, `sync-jornada-klingo` 100%; as falhas são do Klingo (erro ou demora) e são repetidas sozinhas.

## 4. Números da produção em 11/11/2026

| Medida | Valor |
|---|---|
| Banco | 208 MB de 500 MB (cerca de 115 MB são avisos de tempo real dos dias 08 a 11/11, que o Supabase descarta sozinho em 3 dias; o dia 12 já nasce com poucos kB) |
| Conversas / mensagens | 201 / 4.118 (manhã) |
| Estrutura no fim do dia | 425 funções, 101 tabelas, 21 rotinas, 0 falha de rotina em 6 h |
| Consultas mais caras desde 29/10 | `pessoa_sugestoes` 26.299 s · `agenda_ocupacao_atualizar` 18.751 s · leitura do tempo real 6.673 s · `paciente_jornada` 4.438 s · `pessoa_avisos_data` 3.549 s |
| Estouros de tempo do paciente (3 s) em 6 dias | `chat_responder` no passo médico 10 · `chat_horarios` 8 · `chat_consulta_salvar` 7 · `chat_corpo` 2. Os três primeiros são de antes da lista de horários rápida (10/11); nenhum depois dela |
| Chat publicado | versão `2026.11.01-2` (a constante não era trocada desde 01/11; agora é `2026.11.11-1`) |

## 5. O que ficou para a próxima rodada técnica (não depende de você, mas não coube aqui)

1. `agenda_ocupacao_atualizar` normaliza a grade inteira (33 mil nomes) a cada chamada, mesmo para 1 linha: 0,8 s por chamada, 22 mil chamadas. Dá para reduzir a ~5% restringindo aos médicos do lote. Exige conferência de equivalência com dados reais antes.
2. Permissões por unidade também em `pacientes`, `pre_agendamentos` e `contatos`, e tirar o `update` direto de `conversas` (PERF-02/04). Só depois de preencher a Estrutura.
3. Convênio suspenso aparecer esmaecido na lista do chat (hoje some).
4. Conferir byte a byte as 9 Edge Functions publicadas contra o repositório (a ferramenta devolve o código, mas a comparação manual não coube).
5. Histórico completo da pessoa (CONV-04) e separar "ao vivo" de "histórico" (CONV-05).
6. Acessibilidade: `<main>` e `<h1>` no painel, contraste da borda dos campos, foco preso no modal (`pendencias.md`, itens 8, 10 e 11).

## 6. Arquivos desta auditoria

| Arquivo | O que é |
|---|---|
| `supabase/jornada-avisos-enxutos.sql`, `agendado-rapido.sql`, `chat-corpo-cache.sql`, `manutencao-limpeza.sql`, `seguranca-ajustes.sql` | Correções **no ar** (7 migrações `auditoria_1111_*`) |
| `supabase/producao/` | Retrato da produção (novo) |
| `index.html`, `sentinela.js`, `sw.js`, `painel/index.html`, `painel/sw.js` | Correções das telas |
| `testes/banco-producao.mjs`, `sql-producao.test.mjs`, `sql-ponta-a-ponta.test.mjs`, `retrato.test.mjs`, `chat-equipe-assume.navegador.mjs`, `painel-recarga.navegador.mjs` | Testes novos (29 + 19 + 10 + 9 + 4 verificações) |
| `testes/antes-da-auditoria-1111/` | As 4 funções como eram, para o teste reproduzir os defeitos |
| `docs/DOCUMENTACAO.md`, `docs/pendencias-do-dono.md`, este arquivo | Documentação |

## 7. Como conferir você mesmo

```bash
cd testes && npm install
CHROMIUM_PATH=/opt/pw-browsers/chromium npm test        # tudo (cerca de 6 minutos)
npm run test:retrato                                    # telas e banco sincronizados (1 s)
npm run test:ponta-a-ponta                              # paciente e equipe com o código real
npm run test:producao-sql                               # cada defeito reproduzido e corrigido
```

Na produção, o efeito da correção 2.1 (rodar no editor SQL: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/sql/new):

```sql
select date_trunc('hour', inserted_at) as hora, count(*) from realtime.messages
where event = 'jornada_mudou' and inserted_at > now() - interval '1 day' group by 1 order by 1;
```

Antes: cerca de 10.000 por hora. Depois: poucas dezenas.

## 8. Como voltar atrás

| Mudança | Como desfazer |
|---|---|
| Avisos enxutos (2.1) | Reaplicar `testes/antes-da-auditoria-1111/jornada_avisar_exame_ins.sql` e `jornada_conversas_sincronizar.sql` |
| Mapa do corpo (2.6) | Reaplicar `testes/antes-da-auditoria-1111/chat_corpo.sql` e `select cron.unschedule('chat-corpo-cache');` |
| Limpeza (2.5) | `select cron.unschedule('manutencao-limpeza');` |
| Agendado rápido (2.2) | Reaplicar `testes/antes-da-auditoria-1111/agendamento_valido_para_encerrar.sql` e `grant execute ... to authenticated` |
| Telas (2.3, 2.4, 2.7) | Reverter o commit desta branch |
| Conferência do "Agendado" inteira | `update public.config set valor = 'nao' where chave = 'encerramento_valida_agendado';` |
