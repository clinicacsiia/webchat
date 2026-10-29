# Fase 0: verificação com o Klingo (29/10/2026)

Objetivo: descobrir, antes de programar, de onde vêm preço, bloqueio e marcações. Esta fase foi feita só com leitura: **nenhuma chamada nova ao Klingo foi feita** (o token fica num secret do Supabase, que não leio) e **nenhum dado de paciente foi lido**. As conclusões vêm do projeto Indicadores, que já coleta relatórios do Klingo, e foram obtidas por consultas agregadas (contagens e títulos de coluna).

## Resultado por item

### 1. Relatório de marcações para a conferência: já existe, não precisa criar

Relatórios que saem pela mesma API (`/api/info/relatorio`) com filtro de data **já comprovado** no Indicadores:

| Relatório | Colunas úteis | Para que serve |
|---|---|---|
| **#7 AGENDAS MARCADAS** (hoje inativo no Indicadores; filtro `data_marcacao`) | Marcado Em, Agendado Para, Procedimento, Profissional, Unidade, Operadora, Paciente, Contato, Valor Previsto, Origem, Por (usuário), Status, Prontuário | **Conferência**: é o único com Profissional e dia/hora. |
| **#13825 Agendamentos - Visão Consolidada por Marcação** (mensal, ativo) | Id da Marcação, Data Agendado Em, Data Agendado Para, Procedimento, Operadora, **Valor**, Status (Aberta/Cancelada/Bloqueada), Cancelamento - Motivo, Unidade, Paciente - Nome, Celular, Telefone | Conferência (plano e unidade) e **preço**. |
| **#47 MARCAÇÕES BLOQUEADAS E CANCELADAS** (diário, ativo) | Profissional, Procedimento, Operadora, Unidade, Paciente, Agendado Para, Status, Motivo | Cancelamento depois do pré-agendamento. |

Limites que continuam:
- **Nenhum desses traz CPF nem data de nascimento.** A conferência vai casar por: nome do paciente + celular + procedimento + data/hora + operadora + unidade. O CPF não entra na conferência, só no pré-cadastro. Para o paciente que volta (Fase 4), a chave CPF vem do que o próprio paciente informa no chat, e não do relatório.
- O #7 está com coleta desligada no Indicadores e sem linhas lá: para usá-lo é preciso um teste real (feito na Fase 3, com dado de hoje).
- Como o Klingo só devolve o dia pedido, a conferência pede "hoje" e "amanhã" a cada 10 minutos, o que é pouco volume.

### 2. Preço Particular: existe, dentro das marcações

O #13825 traz **Valor por marcação**. No Indicadores há, só em marcações Abertas de Particular, **184 procedimentos com valor** (2.356 marcações), nos meses de setembro e outubro. Em 121 o valor é sempre o mesmo; em **63 aparece mais de um valor** (pode ser reajuste, variação de contraste ou desconto: precisa de regra, ver abaixo).

Consequências para o plano:
- O preço do **Particular** entra pelo #13825: "valor mais recente" = valor da marcação aberta mais recente (`Data Agendado Em`) daquele procedimento, mostrando também o intervalo dos últimos 90 dias.
- O preço de **convênio** continua vindo do #13983 (já criado).
- Procedimento Particular **sem nenhuma marcação** no período fica sem preço na IA: ela diz que o atendente informa o valor. Isso é correto, porque marcação passada não prova tabela vigente.
- Para os 63 com vários valores, a IA só cita o valor se o mais recente se repetir em 2 ou mais marcações; senão trata como "a confirmar".

### 3. Bloqueado/inativo: já existe em três lugares

- Procedimento: o #13981 tem o filtro "Faturamento Ativo" (já usado no relatório).
- Marcação: Status = Aberta / Cancelada / **Bloqueada** (#13825).
- Agenda: vigência início/fim no #13984 (já gravada no catálogo, `vig_fim`).
- Plano: não há marca de bloqueio nos relatórios atuais. **Pergunta ao suporte.**

### 4. Filtros do #13983 (preço por operadora): ainda sem resposta

- Formato do filtro na API: `:<id>=<valor>`; para datas, `:<id>=l`, `:<id>-from`, `:<id>-to`. Cada resposta traz a lista `inputs` com os ids reais dos filtros.
- Falta só descobrir os ids de Operadora, Procedimento e Tabela do #13983. Isso se resolve **na Fase 1**, com a própria função de sincronização registrando os `inputs` da resposta (sem chute de nome), ou lendo o filtro no editor de relatórios.
- Hapvida já foi testado manualmente (24 linhas com valor).

## O que depende de uma pessoa (não dá para fazer daqui)

1. **Perguntar ao suporte do Klingo** (suporte@klingo.com.br). Texto pronto em `docs/fase-0-email-suporte-klingo.md`.
2. **No Klingo (editor de relatórios), opcional**: criar uma versão do #7 com CPF e data de nascimento do paciente, se o Klingo permitir. Isso só melhora a conferência, que funciona sem eles.
3. **Decidir** se o #7 passa a rodar a cada 10 minutos (o Indicadores o deixa desligado; a conferência usaria só o dia de hoje e o de amanhã).

## Ajustes no plano

- **Fase 0 do plano**: o relatório de marcações "novo" deixa de ser necessário; usa-se #7 + #13825 + #47.
- **Fase 1**: o preço Particular vem do #13825 (valor da marcação), com regra de confiança. O preço de convênio vem do #13983, por operadora.
- **Fase 3**: a conferência casa por nome + celular + procedimento + data/hora + operadora + unidade (sem CPF). Divergências de acento ou abreviação no nome entram como "divergente: nome parecido" e vão ao atendente, nunca como erro automático.
- **Riscos novos**: o casamento por nome pode falhar com homônimos (o celular desempata) e o #7 precisa de um teste real antes de confiar nele.

## Conclusão

A Fase 0 não encontrou bloqueio. A conferência automática é viável sem criar nada no Klingo. O preço Particular tem fonte, com ressalva de qualidade em 63 de 184 procedimentos. Pendências: respostas do suporte e o teste real do #7 (feito na Fase 3).
