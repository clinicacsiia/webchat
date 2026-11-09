# WC-01: por que só 2 pacientes aparecem como "agendado" (09/11/2026)

**Só leitura.** Nada foi gravado no banco nem no Klingo. Só contagens; nenhum dado de paciente foi lido ou guardado.

"Reconhecido" aqui, confirmado pelo dono, é o pré-agendamento com status `agendado`.

## O caminho de um agendamento até "agendado"

1. O paciente termina o pedido no chat e o pré-agendamento vira **`pronto`**.
2. A equipe marca o horário **no Klingo** (o sistema nunca marca; a API do Klingo só lê).
3. Duas coisas podem virar `pronto` em **`agendado`**:
   - a equipe toca **Marcar como agendado** no painel; ou
   - a conferência automática (`agenda-conferir`, a cada 15 s; `agenda-revisar`, a cada 10 min) acha a marcação no Klingo pelo **telefone (8 últimos dígitos) ou pelo nome**, no mesmo horário, e grava `agendado` sozinha.

## O que o banco mostra hoje

| Pré-agendamento | Quantidade |
|---|---|
| `agendado` | **2** (1 manual, 1 automático que depois ficou "sumiu") |
| `pronto` | **32** |
| &nbsp;&nbsp;… ainda sem veredito da conferência | 28 (26 com horário de hoje em diante, 2 sem horário escolhido) |
| &nbsp;&nbsp;… com veredito | 4 (2 divergente, 1 horário tomado, 1 não encontrado) |
| `rascunho` (pedido incompleto) | 40 |
| `cancelado` | 5 |

A rotina de conferência **está viva**: nas últimas 24 h houve 5.897 execuções com sucesso, as chamadas à Edge Function voltaram 200 e avaliaram todos os alvos (por exemplo 12 alvos e 32 horários lidos numa chamada), **sem erro de leitura** (`dias_com_erro = 0`). Mesmo assim, `confirmados = 0` em todas as respostas guardadas.

## Primeira etapa em que se perde

Entre **`pronto` e `agendado`**. Não é falha da leitura do Klingo nem da rotina: ela roda e lê. Os pré-agendamentos ficam em `pronto` porque a conferência **não acha a marcação** que casa com eles. Há três explicações possíveis, e hoje não dá para separá-las só com contagens:

| # | Hipótese | Como confirmar |
|---|---|---|
| H1 | A equipe ainda **não marcou** esses horários no Klingo (normal: são pedidos recentes, o mais antigo é de 03/11). | Perguntar à recepção quantos desses 28 já foram marcados no Klingo. |
| H2 | Marcou, mas o **telefone ou o nome no Klingo é diferente** do informado no chat (outro número, nome abreviado, marcação no nome do responsável). A regra por nome só vale com nome **igual** e exame definido. | Um exemplo real, com autorização, comparando telefone/nome do chat com o do Klingo. |
| H3 | Marcou, mas em **outro horário, médico ou unidade** do que o paciente escolheu no chat (a conferência diz "outro"). | Mesmo exemplo: comparar dia/hora/unidade. |

Um detalhe que agrava: a conferência só olha horários de **ontem em diante**. Pedido cujo dia já passou sem ser conferido nunca mais vira `agendado`. Hoje isso não acontece (os 26 com horário são de hoje em diante), mas vai acontecer com o tempo.

## O que também ficou claro

- Os 82 cartões da Jornada ligados a conversas são cartões **do chat**. Nenhum exame do Klingo dos últimos 60 dias está ligado a uma conversa: a ligação do Klingo com o chat só é feita na hora de **fechar o exame** (`agendamento_conferir_klingo`), pelas 3 informações (nome, telefone, mesmo dia). Isso é intencional.
- O relatório que a Jornada lê (#13825) filtra pela **data em que a marcação foi feita**. O relatório "Marcações por Data do Exame" **ainda não foi criado** no Klingo (pendência `relatorio_por_data_exame`). Não explica o "2", mas atrasa a percepção de confirmações e cancelamentos.

## Próximo passo (para o WC-02)

1. **Você:** escolha 1 ou 2 pacientes que a recepção **já marcou no Klingo** e que aparecem em `pronto` no painel, com autorização. Basta me dizer o nome da conversa no painel; eu comparo só os campos de reconhecimento e não gravo nada.
2. Com isso o WC-02 corrige a causa certa. Candidatos já visíveis no código, sem esperar o exemplo: aceitar também o **nome no Klingo igual ao do responsável**, e **reconferir pedidos antigos** (hoje descartados quando o dia passa).
3. Opcional e barato: o painel mostrar "aguardando marcação no Klingo há X dias" para os `pronto`, assim ninguém acha que o sistema esqueceu.

## Como repetir esta medição

```sql
select status, conferencia_status, count(*) from pre_agendamentos group by 1, 2 order by 1, 2;
```
