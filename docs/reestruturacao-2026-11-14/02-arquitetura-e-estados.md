# 02 — Arquitetura final, fluxogramas e estados

Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Marcado com **[feito]**, **[existe, não alterado]** ou **[NÃO feito]** para não confundir intenção com entrega.

## 1. Três processos independentes

```
                         ┌──────────────── Paciente ────────────────┐
                         │  Entrada → Identificação → Serviço → Convênio
                         └────────────────────┬─────────────────────┘
                                              ▼
                              chat-agenda-api  (GET /agenda/horarios)
                                              │  resultado de CADA etapa em klingo_consulta
              ┌──────────────────────┬────────┴─────────────┬───────────────────────┐
     ok_com_horarios          api_sem_horarios /      erro_api / limite /       fora_do_escopo / sem tradução
              │               todos_filtrados         estrutura_invalida        de plano / vários exames
              ▼                       ▼                       ▼                          ▼
   A. AGENDAMENTO REAL     B. DISPONIBILIDADE FUTURA   "Não foi possível        C. EQUIPE (exceção)
   calendário = ofertas    (não é reserva)             consultar agora"         "Enviar meu pedido à equipe"
   da API; confirmar →     registrar preferências      Tentar de novo (fresco)
   klingo_operacao →       → motor busca vaga          ou registrar mesmo assim
   klingo-executar         → oportunidade → aviso
   → comprovante           → paciente aceita → volta
                             ao calendário normal (A)
```

Regra de ouro [feito]: **a grade (`catalogo_agenda`) e a ocupação (`agenda_ocupacao`) nunca produzem vaga**. `chat_horarios` só lê `klingo_oferta` (não-sombra, não vencida). A grade continua para planejamento, conferência e diagnóstico.

## 2. A. Agendamento imediato

| Passo | Quem | Estado |
|---|---|---|
| Identificar (CPF + nascimento, servidor) | `fluxo_*`, `klingo_identidade` | [existe] |
| Serviço / convênio | `fluxo_*`, `klingo_plano_resolver` | [existe]; serviço nunca some (`klingo_liberado`) [feito] |
| Consultar disponibilidade | `chat-agenda-api` → `klingo_consulta`, `klingo_oferta` | [feito] |
| Mostrar | `chat_horarios` v2: `estado` ∈ `com_horarios, sem_horarios, indisponivel, nao_integrado, sem_consulta` | [feito] |
| Escolher | `chat_horario_escolher` v2: só oferta válida; guarda `klingo_chave` | [feito] |
| **Revalidar** | a tela refaz a consulta (`fresco`) antes de gravar a escolha; o executor ainda trata "horário ocupado" (`horario_tomado`) | [feito] / [existe] |
| Confirmar e marcar | `klingo_pode_marcar` → `klingo_operacao_criar` → `klingo-executar` | [existe]; sombra nunca vira base [feito] |
| Comprovante | `klingo_operacao_concluir` (voucher, cartão) | [existe] |

Não existe "segunda arquitetura": a marcação continua no pipeline `klingo_operacao` / `klingo-executar`.

## 3. B. Solicitação de disponibilidade futura (substitui a previsão) [feito]

```
paciente sem horário ──► chat_disponibilidade_registrar ──► disponibilidade_pedido (ativa) + evento "criada"
                                                              │ segue o fluxo do pedido (dados) como "sem horário"
 pg_cron 10 min: previsao_vigiar ──► disponibilidade_vigiar
        ├─ expira período vencido · devolve oportunidade vencida a "ativa"
        ├─ entrega avisos pendentes (só se notificacao_modo permitir)
        └─ disponibilidade_alvos ──► Edge disponibilidade-vigia ──► API (janelas de 15 dias, cota global)
                                         └─► disponibilidade_oportunidades_gravar
                                               · cruza dias/turno/período/unidade/profissional
                                               · 1 oportunidade nova por vez; mesma vaga nunca avisa 2×
                                               · notificação: pendente | bloqueada_sem_autorizacao | bloqueada_limite
 aviso no chat ("possibilidade… o horário NÃO está reservado") ──► paciente: "Ver horários agora"
        └─► chat_disponibilidade_responder ──► pedido volta ao calendário normal (consulta nova) ──► A
 agendamento confirmado (API ou equipe) ──► gatilho ──► solicitação "convertida_em_agendamento"
```

Estados da solicitação (gatilho `disponibilidade_transicao_trg` recusa o resto; finais são imutáveis):

```
ativa ─► oportunidade_identificada ─► notificada ─► aguardando_resposta ─► convertida_em_agendamento
  ▲            │                         │                 │
  └────────────┴─────────────────────────┴─────────────────┘  (oportunidade vencida ou recusada)
 qualquer aberto ─► expirada | cancelada          (finais: não recebem oferta, não mudam)
```

Invariantes testadas: (1) nunca cria linha em `klingo_operacao` nem `pre_agendamentos.status='agendado'`; (2) uma solicitação aberta por pessoa+serviço+plano (índice único parcial); (3) mesma vaga = no máximo uma notificação (`unique (pedido_id, oferta_chave)`); (4) sem autorização do paciente nenhum aviso sai; (5) sem `notificacao_modo` ligado nada é "enviado"; (6) filhos de um mesmo responsável não se misturam (hash inclui nascimento e nome).

Canal de notificação: **somente o chat** (a mensagem existe na conversa e o aviso push do chat segue o fluxo normal). WhatsApp **não** foi integrado e **não é simulado**. A entrega é registrada como `entregue_ao_chat` (mensagem criada), nunca como "lida".

## 4. C. Atendimento humano

Mantido e preservado a qualquer momento (`pedirAtendente`). A tela passa a levar para a equipe **só** o que é exceção: serviço sem automação ("Enviar meu pedido para a equipe"), divergência de identificação (`klingo_pode_marcar` → `cadastro_divergente`), operação incerta (`klingo_operacao_vigiar` → `fluxo_finalizar_humano`), pedido do paciente. Falta de integração **não** leva sozinha à equipe quando há autoatendimento (registrar disponibilidade) [feito].

## 5. Estados separados

| Máquina | Onde | Estado atual |
|---|---|---|
| Conversa | `conversas.status` (`aguardando`, `em_atendimento`, `encerrada`) | [existe]. Política de encerramento por solicitação futura: **configurável e desligada** (`disponibilidade_encerra_conversa`). |
| Pedido | `pre_agendamentos.status` (`rascunho`, `pronto`, `agendado`, `cancelado`) + `etapa` | [existe]. `agendado` só nasce em `klingo_operacao_concluir` (sucesso com voucher) ou pela equipe. |
| Operação no Klingo | `klingo_operacao.estado` (`pendente`, `executando`, `sucesso`, `falha`, `incerto`, `horario_tomado`, `cancelada`) | [existe, não alterado]. |
| Solicitação futura | `disponibilidade_pedido.estado` | [feito] (acima). |

[NÃO feito] a separação *completa* dos três primeiros (ex.: "Dependente de equipe" como estado próprio do pedido, "Conciliada" como estado da operação): continuam implícitos em combinações de campos. Está em `05-pendencias.md`.

## 6. Pós-agendamento — estado honesto

| Fluxo | Estado |
|---|---|
| Ver minha marcação | [existe] cartão `marcado`/`pos_menu`; consulta ao Klingo antes de mostrar [NÃO feito]. |
| Cancelar | [existe] pipeline `klingo_operacao` tipo `cancelar` + regra de 24 h (`pos_prazo`); incerto → equipe. Não alterado nesta rodada. |
| Remarcar | [existe] tipo `remarcar` envia o voucher antigo (`remarcacao`) para o Klingo cancelar sozinho. **A unificação com o caminho antigo "equipe cancela depois" e a estratégia compensatória [NÃO foram feitas].** |
| Resultado de exame | [NÃO feito]. Não há endpoint confirmado; ver `05-pendencias.md`. |
| Outros assuntos / emergência | [existe, não alterado]. |

## 7. Painel [feito]

"Lista de previsão" virou **Disponibilidade futura**: uma lista só, filtros por situação (procurando, vaga encontrada, avisados, aguardando paciente, viraram agendamento, expiradas, canceladas, **precisam de pessoa**), histórico por solicitação e "Cancelar procura" a pedido do paciente. Sem quadro novo.
