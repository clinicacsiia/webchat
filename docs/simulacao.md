# Simulação da clínica (15/11/2026)

Versão 1.2 — 15/11/2026 / Mudança: **mapa do que falta nos dados** (só porcentagens) e **hora real gravada no banco** (tabela `atendimento_hora`, `atendimento_hora_gravar`, simulação usa chegada, início e fim reais quando existirem; modo "Hora real registrada"); falta apenas ajustar o relatório do Klingo e ligar a leitura. Versão 1.1 — 15/11/2026 / Mudança: **indicadores primeiro**, **área externa** (do pedido ao resultado, com os atendimentos antigos como régua), **3D só com os pontos de atenção**, gráficos refeitos e visual novo; função `painel_simulacao_externa`. Versão 1.0 — 15/11/2026 / Mudança: criação. A simulação "Clínica CSI portátil 2.0" (pacote enviado pelo dono) foi trazida para `simulacao/`, ligada ao banco do webchat e ao relatório #14359 do Klingo, e ganhou o painel **Decisão**.

**Endereço:** https://clinicacsiia.github.io/webchat/simulacao/ (também pelo botão **Simulação** no alto do painel de atendimento). Só funciona com login do painel (administrador ou atendente). Sem login, abre a **Demonstração** com dados fictícios.

## Hora real de atendimento (gravada no banco)

**Estado em 15/11/2026: o banco e a simulação estão prontos; falta o relatório do Klingo com a hora real e a leitura dele.** Hoje a chegada é aproximada (momento em que o Klingo marcou o atendimento) e início e fim do exame não existem.

**Banco (aplicado, `supabase/simulacao-hora-real.sql`):**
- Tabela `atendimento_hora` (uma linha por marcação: `marcacao_id` no formato `m22544`, `chegada_em`, `inicio_em`, `fim_em`, `lido_em`). Só o id da marcação e horários: nenhum dado de paciente. RLS ligada e **sem permissão** para anon e logado; só o servidor grava.
- Função `atendimento_hora_gravar(jsonb)` (só `service_role`): recebe `[{"m":"m22544","chegada":"…","inicio":"…","fim":"…"}]`, grava sem apagar o que já havia se a nova leitura vier vazia, e **recusa** (contando) id inválido, hora fora de ordem (início antes da chegada, fim antes do início), exame de mais de 8 h e linha sem hora.
- `painel_simulacao_dia` passou a usar a hora real: vira `arrive`, `start` e `end` (a hora real vale mais que a chegada aproximada), e as durações reais (fim − início, até 30 por hora, unidade e modalidade) entram no histórico, então o tempo de exame deixa de ser premissa e passa a ser medido. `painel_simulacao_indicadores` usa a hora real na pontualidade.
- Na página: quando um dia tem início e fim em 30% ou mais das marcações, aparece o modo **"Hora real registrada (só o que aconteceu)"**, que mostra a espera medida (chegada → início do exame) em vez de simulada.

**O que falta, e é seu (regra do `CLAUDE.md`: relatório do Klingo pendente):** ajustar o filtro do relatório que tem a hora real para poder consultar **por data e hora** (período), sem pedir prontuário ou CPF. Quando estiver pronto, me passe:
1. o **número do relatório** e os **ids dos filtros** (período e, se houver, unidade);
2. as **colunas** que trazem: id da marcação (o `m…` ou o número), id do atendimento, **chegada** (check-in), **início** e **fim** do atendimento, dizendo se vêm com **data e hora** ou só hora (se só hora, usa-se a data do exame);
3. confirmar se o relatório cobre **todas as unidades** (CSI 1, CSI 2 e Pediatria) e que **dia** ele aceita (hoje e os últimos dias).

Com isso eu escrevo a leitura (uma Edge Function como a `sync-jornada-klingo`, a cada poucos minutos, janela de hoje e dos 2 dias anteriores) e ela chama `atendimento_hora_gravar`. **Não suponho colunas nem filtros.** O relatório B (#14025) já tem "Check-In (chegada)" e aceita período, mas não tem início nem fim do exame.

## O que falta nos dados (mapa só com porcentagens)

Aba **"O que falta nos dados"** no painel Decisão, com um resumo na seção 1. Para cada **situação do exame** (agendado, confirmado, atendido, faltou, cancelado, remarcado) mostra quantas marcações e quantas **pessoas** existem e **que porcentagem tem cada dado**: hora de chegada, início e fim do exame, nº do atendimento, resultado entregue, situação da confirmação, telefone, origem da marcação, cadastro completo e motivo do cancelamento. **Só contagem** (função `painel_simulacao_lacunas`): nenhum dado de pessoa sai; com menos de 5 casos a célula mostra "poucos"; "—" quando o dado não se aplica àquela situação.

Leitura de 15/11/2026 (marcações de 18/10 a 30/11): entre os **atendidos**, hora de chegada 89%, **início e fim 0%**, **resultado entregue 0%**, telefone 100%, nº do atendimento 100%, cadastro sem campo vazio 98% e origem da marcação 48% (só existe para marcações conferidas pelo relatório #14554). Entre as marcações ainda por vir, **só 22% a 27% têm cadastro completo** (falta e-mail ou celular) e 91 a 93% têm origem. Cancelados e remarcados: 99% a 100% com motivo.

## Ordem da página (indicadores primeiro)

1. **Indicadores:** os 4 cartões do painel (procuraram o chat, agendaram, marcações novas, faltas, com a variação contra o período anterior) e a lista de **pontos de atenção**, do mais grave ao menos grave. Cada ponto traz o número, a fonte (indicadores do painel, área externa ou simulação) e leva ao 3D.
2. **Área externa:** o caminho antes e depois da clínica (ver abaixo).
3. **Pontos de atenção em 3D.**
4. **Clínica por dentro:** a simulação (linha do tempo por unidade, espera por hora, miniatura, ronda).
5. **Decisão:** recomendações, uso das estações, encaixes e indicadores em abas.

O programa roda a análise **antes** de desenhar: lê `painel_indicadores_decisao` (a mesma função que alimenta a aba Indicadores do painel, últimos 28 dias contra os 28 anteriores, com as mesmas regras de frases), `painel_simulacao_externa` e o resultado da simulação do dia, e só então monta a lista, o desenho da área externa e o 3D.

## Área externa (do pedido ao resultado)

Os "espaços" são as etapas fora da clínica. **A régua é o total de atendimentos antigos**: média de atendidos por dia nos dias fechados dos últimos 28 dias (15/11/2026: 161 por dia, 2.420 atendimentos em 15 dias). Cada etapa mostra pessoas e **dias de atendimento** = pessoas ÷ média por dia; a largura do espaço cresce com a raiz desse número.

| Espaço | O que conta | Nível de atenção |
|---|---|---|
| Esperando resposta no chat | Conversas abertas (fora as de teste) esperando a equipe | Mais antiga há 15 min: atenção; 60 min: alto; 4 h: crítico. Também se esperam 20% ou mais das conversas abertas por dia |
| Pedido pronto, falta marcar | `pre_agendamentos` em `pronto` | Parado há 8 h: atenção; 24 h: alto; 72 h: crítico |
| Sem confirmação (hoje e amanhã) | Exames de hoje e amanhã "A confirmar" ou "Sem resposta" | 10% dos exames: atenção; 20%: alto; 30%: crítico (mostra a pior unidade) |
| Agenda dos próximos dias | Exames marcados nos próximos 15 dias, em dias de atendimento | Só informação |
| A caminho da clínica hoje | Marcados para hoje que ainda não chegaram, e atrasados (30 min ou mais) | Atrasados: 8%: atenção; 15%: alto; 25%: crítico |
| Na clínica (simulação) | Fila simulada e espera P90 do dia | P90 de 30 min: atenção; 45: alto; 60: crítico |
| Exame feito, resultado | Atendidos nos últimos 14 dias | **Ponto cego:** o Klingo/Jornada não registra a entrega do resultado (`app_resultado` vazia; 2 "concluídos" na Jornada). Sem nenhuma entrega registrada: alto |

Os limites são decisões de partida e ficam em `simulacao/analise.mjs` (uma linha por regra). Dizer ao Claude se algum precisa mudar.

## 3D: só os pontos de atenção

Cena com three.js 0.160 (carregada de `cdn.jsdelivr.net` pelo `importmap`; se a CDN falhar ou o navegador não tiver WebGL, a página avisa e a lista de pontos continua inteira). O caminho vai da esquerda (chat) para a direita (clínica e resultado). **Só os pontos de atenção ganham corpo:** disco e anel na cor do nível, figuras de pessoas (proporcionais ao número real, no máximo 90 por espaço), coluna de luz pulsando e rótulo com símbolo, nome e número (o texto completo aparece ao passar o mouse). O que está em ordem fica como contorno fantasma com a etiqueta "em ordem". As três unidades da clínica ficam como prédios; só as que têm alerta de simulação acendem. Arrastar gira, rolar aproxima, tocar num ponto da lista ou num espaço da área externa leva a câmera até ele. A cena só desenha quando está visível na tela.

## Gráficos

Refeitos em SVG puro (`simulacao/grafico.mjs`), seguindo o método de visualização do projeto: **linha do tempo** com áreas empilhadas por unidade (CSI 1 azul, CSI 2 laranja, Pediatria verde-água; paleta validada no fundo escuro, diferença para daltonismo ≥ 9), linha tracejada de quem espera, marcações das ocorrências da ronda, pico anotado, melhor janela sombreada, dica ao passar o mouse e **tabela equivalente**; **espera por hora** (P90 da chegada ao exame) com a meta de 30 min e cor por nível, sempre com símbolo e valor; cartões com variação. Os níveis usam a paleta de estado reservada, **sempre com símbolo e palavra** (▲ Crítico, ◆ Alto, ● Atenção), nunca só cor.

## O que ela faz

1. **Carrega um dia real** (passado, hoje ou futuro) do Klingo, pela Jornada: marcações, faltas, cancelamentos, situação da confirmação e a **chegada**.
2. **Simula o que acontece dentro da clínica**: recepção (guichê) → preparo → sala de exame, com fila e espera. Mostra a clínica em miniatura, a linha do tempo, a ronda (Dora, Raul e Nina) e a jornada de cada paciente.
3. **Testa mudanças**: mais ou menos estações por setor, tentativas automáticas, **encaixes** (atendimentos extras num horário) e premissas de tempo.
4. **Diz o que fazer** (painel **Decisão**): recomendações com o número que as sustenta e indicadores reais da clínica.

Nada do que ela faz altera agenda, banco ou Klingo. As duas funções do banco só leem.

## De onde vêm os dados

| Dado | Fonte | Observação |
|---|---|---|
| Marcações do dia (hora, unidade, exame, situação, confirmação) | `jornada_exame` + `jornada_card`, alimentadas pelo **relatório #14359** a cada 30 s (`sync-jornada-klingo`) | Só marcações do Klingo (`marcacao_id` começa com `m`). Pedidos do chat sem marcação ficam de fora |
| Chegada do paciente | `jornada_evento`: o momento em que o Klingo marcou o atendimento como aberto (`para_coluna = 'em_atendimento'`, `origem = 'klingo'`) | **Aproximação**: lida a cada 30 s e só vale se foi no mesmo dia. 89% dos atendidos têm |
| Falta, cancelamento, remarcação | `jornada_exame.status` | Falta sem hora: a simulação usa 15 min depois do horário |
| Falta por situação da confirmação | Mesma tabela, últimas 8 semanas fechadas | Confirmado ≈ 11%, A confirmar ≈ 33%, Sem resposta ≈ 53% (15/11/2026) |
| Histórico por hora (volume e falta) | Mesma tabela, dias fechados dos últimos 70 dias | O banco só guarda desde **30/10/2026**: poucos dias de cada dia da semana |
| Indicadores de decisão | `painel_simulacao_indicadores` (unidades, exames, confirmação, semana, hora, pontualidade, antecedência, próximos 15 dias, origem das marcações, pedidos do chat, fila "Minha vez") | Só números |

**Nenhum nome, CPF, telefone, e-mail ou prontuário sai do banco.** Cada pessoa vira um número de 1 a N que só vale para aquela leitura (`dense_rank`). Há teste que procura esses termos no resultado.

## Relatórios do Klingo (regra do `CLAUDE.md`)

- **Nenhum relatório novo ou editado é necessário.** Usa o #14359 já em uso pela Jornada (`config.jornada_relatorio_id = 14359`). Se a Jornada parar de ler o Klingo, a simulação mostra o horário da última leitura ("Jornada leu o Klingo em …").
- **O que o Klingo não entrega** (nenhum relatório tem): hora de **início e fim do exame**, hora do guichê, hora do preparo, quantidade de **salas e profissionais** por setor. O relatório B (#14025) tem "Check-In (chegada)", mas só se consulta por prontuário ou CPF, então não serve para o dia inteiro. Por isso o tempo dentro da clínica é **hipótese editável** ("Premissas") e a capacidade é estimada e **salva por você** ("Definir como capacidade atual da clínica"). A pergunta 4 do suporte do Klingo (hora real do atendimento; `klingo-relatorios-pendentes.md`) é a que destrava a medição de verdade.
- Fonte real de espera: a fila "Minha vez" (`fila_chegada`). Em 15/11/2026 só 5 pacientes usaram, pouco para calibrar. Cada check-in a mais melhora a simulação.

## Como o dia é montado (modo "Klingo + banco")

- **Dia fechado:** quem chegou, chegou na hora medida; quem faltou, faltou. O fluxo dentro da clínica é simulado.
- **Hoje:** o corte é a hora atual (atualiza a cada 60 s). Quem já passou 45 min do horário sem chegar vira **falta provável**; quem está dentro dos 45 min só pode chegar de agora em diante; quem ainda vem tem a falta sorteada pela situação da confirmação.
- **Dia futuro:** as marcações atuais mais o volume que o histórico indica por hora (só a diferença); faltas previstas pela situação da confirmação.
- **Chegada sorteada:** pelos 11 quantis medidos por unidade (limitada a 60 min antes do horário: abrir o atendimento mais de 1 h antes provavelmente é a recepção, não o paciente na sala). Sem amostra suficiente (menos de 20 por unidade), usa a distribuição padrão.
- **Quem já foi atendido nunca vira falta**, mesmo sem chegada registrada.
- Três sorteios fixos por alocação (mesmas sementes do pacote original), então o resultado é reproduzível.

## Painel Decisão

Cada item é uma regra, com o número que a sustenta:

| Recomendação | Regra |
|---|---|
| Dia não fecha / passa das 19:00 | Há atendimento sem acontecer ou último termina depois das 19:00 |
| Mais uma estação em um setor | Testa +1 nos 3 setores com mais espera acumulada; só aparece se tirar 2+ atendimentos acima de 30 min ou 5+ min da espera P90 (ganho menor é ruído do sorteio) |
| Estação folgada | Setor com 2+ estações e uso abaixo de 30%; só sugere se tirar 1 não piora a espera |
| Confirmar quem não respondeu | Conta marcações "sem resposta" e "a confirmar" que ainda não resolveram e estima vagas recuperadas se **metade** passar a faltar como os confirmados |
| Encaixes que o histórico sustenta | Por unidade, exame e hora: faltas esperadas × 0,6 (arredondado para baixo). Botão testa o encaixe |
| Melhor janela | Faixa de 30 min com menor ocupação |
| Chegam cedo | Unidade com 25%+ chegando 15 min ou mais antes |
| Dados faltando | Avisa quando a amostra da fila "Minha vez" é pequena |

Abas de indicadores: **Resumo**, **Faltas** (por confirmação, exame e hora), **Chegadas** (pontualidade), **Demanda** (dia da semana), **Próximos dias** (marcadas e faltas esperadas por dia e unidade) e **Processo chat → clínica** (antecedência da marcação, origem das marcações, pedidos do chat, fila "Minha vez").

**Cuidados na leitura:**
- A recepção pode marcar "Confirmado" quando o paciente chega, o que melhora a taxa de falta dos confirmados. Vale conferir com a equipe antes de tratar como causa.
- Dias da semana com 1 ou 2 amostras são só indício (o banco tem 2 semanas de histórico).
- A capacidade inicial é uma estimativa pelo volume do dia, não o número real de salas.

## Banco

Arquivo `supabase/simulacao-dados.sql` (fluxograma, versão e rollback no cabeçalho). Quatro funções, nenhuma tabela nova, só leitura:

| Função | Quem executa | O que devolve |
|---|---|---|
| `sim_unidade(texto)`, `sim_modalidade(texto)` | qualquer um (puras) | Traduz "CSI 1" → `csi1` e o nome do procedimento → `consulta`, `us`, `rm`, `tc`, `eco`, `rx`, `dmo`, `mamo`, `histero` (fora disso: nulo, contado em `fora_do_modelo`) |
| `painel_simulacao_dia(date)` | `authenticated` com papel admin ou atendente | Um dia no formato da simulação (`visits`, `history`, `calibragem`, `meta`) |
| `painel_simulacao_indicadores(integer)` | idem | Indicadores de decisão dos últimos 7 a 90 dias e dos próximos 15 |
| `painel_simulacao_lacunas(integer)` | idem | Mapa do que falta nos dados (ver acima). ≈ 70 ms |
| `atendimento_hora_gravar(jsonb)` | **só `service_role`** | Grava a hora real (ver acima) |
| `sim_minuto(timestamptz)` | qualquer um (pura) | Minuto do dia em Salvador |
| `painel_simulacao_externa(integer)` | idem | Base de atendimentos antigos e etapas fora da clínica (chat, pedidos, confirmação por horizonte e unidade, hoje, resultado). Só números. Arquivo `supabase/simulacao-externa.sql`, aplicada como `simulacao_externa_parte1` (≈ 110 ms, 2,4 KB). Rollback: `drop function public.painel_simulacao_externa(integer);` |

Aplicado na produção em 15/11/2026 em 4 partes (`simulacao_dados_parte1..4`, só `create or replace`). Medido: ≈ 270 ms cada, 88 KB o dia e 12 KB os indicadores. `anon` não executa. **Voltar atrás:** `drop function` das 4 (comandos no cabeçalho do arquivo; o Supabase pede confirmação) e apagar a pasta `simulacao/` e o botão no painel.

## Arquivos

| Arquivo | O que é |
|---|---|
| `simulacao/index.html` | A página (fonte dos dados, linha do tempo, miniatura, Decisão, premissas) |
| `simulacao/app.mjs` | Tela: estado salvo no navegador, login, leitura do banco, decisão, encaixes, premissas, capacidade |
| `simulacao/engine.mjs` | Motor da simulação (filas, estações, ronda). Versão 2.1: premissas editáveis, chegada por quantis, falta por confirmação, uso das estações |
| `simulacao/integration.mjs` | Valida o retorno do banco, calibra e monta o dia. Guarda só a última leitura de cada dia (IndexedDB `clinica-csi-simulacao`) |
| `simulacao/decisao.mjs` | Recomendações e painéis (funções puras, testadas) |
| `simulacao/analise.mjs` | Etapas da área externa, pontos de atenção e cartões do painel (funções puras, testadas) |
| `simulacao/grafico.mjs` | Gráficos SVG, cartões, espaços da área externa e lista de atenção |
| `simulacao/cena3d.mjs` | Cena 3D (three.js), carregada só depois da análise |
| `simulacao/scene.mjs`, `assets/` | Desenho isométrico e imagens (do pacote original, sem mudança) |
| `simulacao/agenda.json`, `examples/snapshot.json` | Dados da demonstração e exemplo do formato |
| `simulacao/config.mjs` | URL e chave pública do Supabase (as mesmas das outras telas), intervalo de leitura |

O service worker do chat **não guarda** `/simulacao/` (mudou `webchat-cliente-v51`), para o dono sempre abrir a versão atual.

## Testes

`cd testes && npm run test:simulacao` (24: motor, formato do banco, calibragem, recomendações, painéis, análise, gráficos, hora real, mapa do que falta), `npm run test:simulacao-sql` (13) e `npm run test:simulacao-externa-sql` (8), `npm run test:simulacao-hora-real-sql` (10: tabela fechada, gravação e recusas, prioridade da hora real, durações no histórico, mapa do que falta), no clone da produção (modalidades, privacidade, permissão, só leitura, base, horizontes) e `CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:simulacao-nav` (22, no navegador com Supabase simulado e WebGL por software: demonstração, login, dia real, indicadores primeiro, área externa, 3D com pontos em destaque e o resto em contorno, clique no ponto, sem WebGL, encaixe, premissas, capacidade, troca de dia, celular). Entram no `npm test`.

**Ainda não provado:** abrir a página na produção com a sua conta logada (o teste usa Supabase simulado; as funções do banco foram conferidas por chamada real, sem ler dado de paciente).

## Ideias para depois

- Pedir ao Klingo (ou à recepção) a hora de início e de fim do exame e as salas por setor: trocaria as premissas por medida.
- Incentivar o check-in pelo "Minha vez" (única espera real).
- Com mais semanas de histórico, separar o padrão por dia da semana e por convênio.
- Gravar no banco a capacidade da clínica (hoje fica no navegador de cada pessoa).
