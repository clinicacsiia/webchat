# Aba Jornada: monitoramento do paciente a cada minuto (01/11/2026)

A aba **Jornada** (logo depois de Atendimento) mostra **onde cada paciente está**, em quadro, ao vivo. Diferente do alternador Lista | Quadro do Atendimento (só conversas do chat), ela traz **todos** os pacientes: os do chat e os do Klingo.

## O que roda sozinho no banco

Uma rotina agendada (`jornada-vigia`, `pg_cron`, **todo minuto**) chama `jornada_vigiar()`, que faz, nesta ordem, cada etapa isolada (se uma falha, as outras seguem e o erro fica em `jornada_sync_estado.vigia_erro`):

1. **Lê o Klingo** (`jornada_klingo_agendar` → Edge Function `sync-jornada-klingo`). Só o status de quem tem marcação: confirmou, chegou ao atendimento, faltou, remarcou, cancelou. O telefone nunca é gravado (vira uma marca) e o valor em R$ nunca é lido.
2. **Sincroniza as conversas do chat** em cartões.
3. **Aplica as regras** (confirmar presença, oferecer nova data a quem faltou, prioridade por atraso, escala).
4. **Abre o aviso** de quem passou do prazo ou do horário (tabela abaixo).
5. **Fecha sozinho** o aviso que deixou de valer.

### Frequência da leitura do Klingo

| Quando | Intervalo |
|---|---|
| Segunda a sábado, 06:30 às 18:30 (Brasília) | 1 minuto |
| Houve movimento nos últimos 15 minutos, ou alguém está com a aba Jornada aberta | 1 minuto (a aba "acorda" o banco: `jornada_acordar`) |
| Fim da tarde (18:30 às 22:00) | 15 minutos |
| Domingo, de dia | 30 minutos |
| Madrugada | 2 horas |

A cada 10 minutos no expediente (60 fora dele) a leitura é **completa** (45 dias de marcações), para pegar confirmação, cancelamento e atendimento de marcações antigas. Isso existe porque o relatório #13825 só filtra pela data em que a marcação foi **feita**. Um relatório igual, filtrado pela data do **exame**, tornaria tudo instantâneo (ver `jornada_pendencia` → `relatorio_por_data_exame`).

## Avisos de demora

Dois avisos novos, editáveis em `jornada_regra` (coluna `parametros`) ou desligáveis (`ativa = false`) sem mexer em código:

| Regra | Quando abre | Quando fecha sozinho |
|---|---|---|
| `alerta_atraso` | Cartão parado numa das etapas de `colunas` (padrão: Em conversa no chat, Pedido pronto, Aguardando autorização, Chegou, Em atendimento) além do prazo da coluna (`jornada_coluna.sla_min`). Só cartões de ontem em diante e as etapas do chat. | O cartão sai da etapa (ou deixa de estar atrasado). |
| `alerta_horario` | Exame de **hoje** em "A confirmar" ou "Confirmado" cujo horário passou há mais de `minutos` (padrão 15) e o Klingo ainda não registrou atendimento. | O Klingo registra atendimento, cancelamento, remarcação ou falta. |

"Finalizado" e as etapas de pós-atendimento (laudo, faturamento, NPS) ficam **fora** do aviso por padrão: hoje há 258 cartões parados em "Finalizado" e avisar de todos viraria ruído. Para incluir, acrescente o id da coluna em `jornada_regra.parametros.colunas` de `alerta_atraso`.

O aviso é uma **tarefa** do cartão, vencida na hora, com o texto "Passou do prazo em …" ou "Passou do horário …". Ela aparece:

- no painel **"Precisam de atenção agora"**, no alto da aba, com **Assumir** e **Resolver**;
- no **selo vermelho** da aba Jornada e no título da janela (`⚠ 2`), em qualquer aba;
- como **som e notificação** do navegador no instante em que o aviso nasce (tempo real; o texto não leva o nome do paciente).

## O que o painel mostra

- **Estado do monitor** no alto: "Monitorando · Klingo lido há 1 min"; amarelo ("Atualizando…") se o Klingo passou de 10 min sem leitura; **vermelho** se o monitoramento parou (sem checagem há mais de 5 min) ou se o Klingo não respondeu. É o aviso para ninguém achar que está tudo certo quando não está.
- **Quadro** com as colunas do fluxo (chat → agendamento → atendimento); Pós-atendimento e exceções (Cancelado, Remarcado, Faltou…) só aparecem quando há cartão.
- **Período:** Hoje (padrão: hoje, conversas do chat e quem tem aviso aberto), Ontem a amanhã, Próximos 30 dias. **Filtros:** Meus, Sem responsável, Com aviso, unidade, busca por nome ou exame.
- **Clicar no paciente:** exames, avisos e tarefas (botão **Feita**), histórico, **Mover para…** (só as colunas permitidas), **Responsável / Assumir** e **Abrir conversa** (quando veio do chat). Abrir o cartão fica registrado em `jornada_acesso`.
- **Quem vê:** administrador e atendente (como o Atendimento). Marketing não vê.

## O que o sistema NÃO faz

- **Não grava no Klingo.** A API do Klingo só permite ler. "Atualizar a base do Klingo" aqui significa: o banco do painel se atualiza com o que o Klingo informa. Chegou, Finalizado, Laudo, Faturamento e NPS continuam sendo movidos pela equipe; se o Klingo disser outra coisa do que o painel mostra, o cartão não volta sozinho e aparece "Divergência" no histórico.
- **Não resolve o problema do paciente por conta própria.** Ele detecta, avisa, sobe a prioridade, distribui por escala (se houver escala cadastrada) e fecha o aviso quando o problema some. Quem localiza o paciente e resolve é a equipe. Avisar o paciente sozinho (WhatsApp, SMS, e-mail) depende de escolher o canal e do consentimento (ver `jornada_pendencia` → `aviso_ao_paciente`).
- **Feriados** não são tratados: nesses dias a leitura roda como dia normal.

## Arquivos

- `supabase/jornada-monitor.sql`: a função `jornada_vigiar`, as duas regras, as colunas `vigia_*` e o agendamento (migração `jornada_10_monitor_1min`, já aplicada).
- `supabase/functions/sync-jornada-klingo/`: a Edge Function que lê o Klingo (estava só no Supabase; agora versionada).
- `painel/index.html`: a aba (funções `viewJornada`, `renderJornada`, `abrirCartaoJ`…).
- `testes/jornada.navegador.mjs` (15 verificações, Supabase simulado). `npm run test:jornada`.

## Como conferir se está vivo

```sql
select now() as agora, vigia_em, vigia_erro, klingo_em, klingo_modo, klingo_erro, klingo_falhas from jornada_sync_estado;
select jobname, schedule, active from cron.job where jobname = 'jornada-vigia';
select status, start_time from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'jornada-vigia') order by start_time desc limit 5;
```

`vigia_em` deve ter menos de 1 minuto. Para parar tudo: `select cron.unschedule('jornada-vigia');`. Para voltar: rodar de novo a última linha de `supabase/jornada-monitor.sql`.

## Custos e limites a acompanhar

Cada atendente com a aba aberta mantém uma conexão em tempo real (Realtime) e a leitura de 1 minuto faz chamadas ao Klingo e à Edge Function durante o expediente. Vale olhar o consumo no Supabase depois de uma semana (`jornada_pendencia` → `realtime_custo_limites`).

## O que ainda falta

1. Versionar as migrações `jornada_01` a `jornada_09` (o SQL das tabelas e funções do módulo ainda existe só no Supabase; versionei só a `jornada_10` e a Edge Function).
2. Relatório do Klingo por **data do exame** (deixa a leitura de 1 minuto instantânea para confirmação/atendimento de marcações antigas).
3. Cadastrar a **escala** de quem atende cada coluna (sem ela, o aviso fica "sem responsável" e vale para todos).
4. Decidir o canal para avisar o **paciente** automaticamente.
5. LGPD: o texto do aviso e a regra do dado de paciente do relatório #13825 (`docs/pendencias-e-dependencias.md`, A8). O painel guarda o nome vindo do Klingo (`config.jornada_identidade_klingo = sim`); só a equipe vê.
6. Teste automático em banco embutido da função `jornada_vigiar` (hoje ela foi conferida só no banco real, com uma rodada).


## Painel de atenção recolhido, barra de nomes e filtro de unidade (05/11/2026)

- **"Precisam de atenção agora" vem recolhido**; o título (com o número) abre e fecha a lista.
- **Ordem e limite:** do mais recente (minutos, horas) ao mais antigo; quem está parado há **mais de 2 dias sai** do painel, do selo vermelho da aba e do título da janela. Os cartões continuam no quadro.
- **Barra de atenção** logo abaixo da linha "Jornada · Monitorando": mostra os 3 primeiros nomes da lista, deslizando, mesmo com a lista recolhida. Os nomes são recalculados a cada 2 minutos (e na hora, ao trocar a unidade). Sem ninguém com aviso, a barra some.
- **Filtro de unidade no alto do painel** (Todas, CSI, CSI RM/TC, Desenvoar), guardado no aparelho, vale para **Jornada, Atendimento e Fila**, para o painel de atenção, a barra e os números das abas. As 3 unidades são as da agenda dos médicos.
- **Nomes diferentes, mesma unidade** (dedução pelos dados, função `unidade_chave`): Klingo "CSI 1" = CSI; "CSI 2" = RM/TC (590 de 622 exames são RM/TC); "CSI Pediatria" = Desenvoar.
- **Regra de ouro:** se não dá para saber a unidade, aparece em **todas**.
  - *Jornada:* unidade do cartão.
  - *Atendimento:* exame marcado pelo chat, depois cartão da Jornada, depois a unidade escolhida no formulário ("Ainda não sei" = todas).
  - *Fila:* função `fila_unidades_hoje` (SQL em `supabase/fila-unidade.sql`, já aplicado): exame de hoje no Klingo, depois pedido do chat (3 dias), depois formulário. A linha da fila mostra "Unidade provável: … (de onde veio)".
- Não depende dos relatórios pendentes do Klingo.
