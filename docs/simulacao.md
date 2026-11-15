# Simulação da clínica (15/11/2026)

Versão 1.0 — 15/11/2026 / Mudança: criação. A simulação "Clínica CSI portátil 2.0" (pacote enviado pelo dono) foi trazida para `simulacao/`, ligada ao banco do webchat e ao relatório #14359 do Klingo, e ganhou o painel **Decisão**.

**Endereço:** https://clinicacsiia.github.io/webchat/simulacao/ (também pelo botão **Simulação** no alto do painel de atendimento). Só funciona com login do painel (administrador ou atendente). Sem login, abre a **Demonstração** com dados fictícios.

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

Aplicado na produção em 15/11/2026 em 4 partes (`simulacao_dados_parte1..4`, só `create or replace`). Medido: ≈ 270 ms cada, 88 KB o dia e 12 KB os indicadores. `anon` não executa. **Voltar atrás:** `drop function` das 4 (comandos no cabeçalho do arquivo; o Supabase pede confirmação) e apagar a pasta `simulacao/` e o botão no painel.

## Arquivos

| Arquivo | O que é |
|---|---|
| `simulacao/index.html` | A página (fonte dos dados, linha do tempo, miniatura, Decisão, premissas) |
| `simulacao/app.mjs` | Tela: estado salvo no navegador, login, leitura do banco, decisão, encaixes, premissas, capacidade |
| `simulacao/engine.mjs` | Motor da simulação (filas, estações, ronda). Versão 2.1: premissas editáveis, chegada por quantis, falta por confirmação, uso das estações |
| `simulacao/integration.mjs` | Valida o retorno do banco, calibra e monta o dia. Guarda só a última leitura de cada dia (IndexedDB `clinica-csi-simulacao`) |
| `simulacao/decisao.mjs` | Recomendações e painéis (funções puras, testadas) |
| `simulacao/scene.mjs`, `assets/` | Desenho isométrico e imagens (do pacote original, sem mudança) |
| `simulacao/agenda.json`, `examples/snapshot.json` | Dados da demonstração e exemplo do formato |
| `simulacao/config.mjs` | URL e chave pública do Supabase (as mesmas das outras telas), intervalo de leitura |

O service worker do chat **não guarda** `/simulacao/` (mudou `webchat-cliente-v51`), para o dono sempre abrir a versão atual.

## Testes

`cd testes && npm run test:simulacao` (14: motor, formato do banco, calibragem, recomendações, painéis), `npm run test:simulacao-sql` (13, no clone da produção: modalidades, privacidade, permissão, só leitura) e `CHROMIUM_PATH=/opt/pw-browsers/chromium npm run test:simulacao-nav` (15, no navegador com o Supabase simulado: demonstração sem login, login, dia real, encaixe, premissas, capacidade, troca de dia, celular). Entram no `npm test`.

**Ainda não provado:** abrir a página na produção com a sua conta logada (o teste usa Supabase simulado; as funções do banco foram conferidas por chamada real, sem ler dado de paciente).

## Ideias para depois

- Pedir ao Klingo (ou à recepção) a hora de início e de fim do exame e as salas por setor: trocaria as premissas por medida.
- Incentivar o check-in pelo "Minha vez" (única espera real).
- Com mais semanas de histórico, separar o padrão por dia da semana e por convênio.
- Gravar no banco a capacidade da clínica (hoje fica no navegador de cada pessoa).
