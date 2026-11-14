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

## 6. Pós-agendamento — implementado em 14/11/2026 (parte 5; **não publicado**)

```
Outro assunto → "Ver minhas marcações" | Remarcar | Cancelar        (aparece quando klingo_api_consultar vale para a conversa)
        │ CPF + nascimento já conferidos no chat
        ▼
 klingo_marcacoes_pedir ──► operação ler_vouchers ──► klingo-executar (identidade e sessão conferidas no Klingo; GET /vouchers só do próprio paciente)
        ▼  resultado
 sucesso com marcações ──► retrato em klingo_marcacao (sem CPF/nome) ──► lista "Qual marcação?"  ──► detalhes (serviço, unidade, profissional, data, hora, protocolo)
 sem marcação futura   ──► "não encontrei" + nova marcação / equipe
 Klingo fora do ar     ──► diz a limitação, mostra só o histórico do chat (marcado como possivelmente desatualizado) e chama a equipe
 identidade não confere──► não mostra nada, não revela o que falhou, equipe confere
        ▼ ação escolhida
 CANCELAR: regra de 24 h → confirmação → operação cancelar (DELETE /voucher) → Klingo confirma?
              sim ──► marcação "cancelada" + pedido do chat "cancelado" + mensagem "o sistema confirmou"
              não/incerto ──► nada muda, nota "conferir ANTES de nova tentativa", equipe assume
 REMARCAR: regra de 24 h → só se o pedido original (serviço e convênio) existe no nosso banco (mesmo CPF) → calendário só com horários da API
              → operação remarcar (marca o novo COM o voucher antigo; o Klingo cancela o antigo) → o executor CONFERE o antigo:
              antigo cancelado ──► ok · antigo ainda ativo ──► DOIS agendamentos: aviso ao paciente + equipe com prioridade ALTA
              resposta perdida ──► incerto: se o antigo já sumiu, URGENTE ("pode estar sem agendamento"); nunca marca de novo sozinho
              horário novo ocupado ──► nada muda, volta a escolher
              marcação feita fora do chat ──► equipe (sem o serviço e o convênio não dá para remarcar com segurança)
```

| Situação do tipo | Onde | Estado |
|---|---|---|
| Ver minhas marcações | `klingo_marcacoes_pedir/aplicar`, `fluxo_marc_*`, executor `executarConsulta` | [feito, testado com Klingo simulado] |
| Cancelar (qualquer marcação da lista) | `fluxo_marc_aplicar`, `klingo_cancelamento_aplicar` | [feito] |
| Remarcar (unificado) | `fluxo_marc_aplicar` + caminho `remarcar` do pipeline; o antigo "equipe cancela depois" deixa de existir para quem tem a chave ligada | [feito; remarcação atômica no Klingo **não comprovada**: ver `05-pendencias.md` E3] |
| Resultado de exame | `fluxo_marc_pergunta/aplicar` (passos `resultado_*`) | [experiência pronta, **integração do Klingo pendente**: não há endpoint confirmado; nada é simulado] |
| Menu depois de marcar pelo chat (`pos_menu`) | `fluxo_pos_*` | [existe, não alterado] |
| Aviso do Klingo (webhook) | `klingo_evento_aplicar` | [pronto e **desligado**; agora também atualiza `klingo_marcacao`] |

### Estados (quem é dono de quê)

| Máquina | Campo | Valores | Quem muda |
|---|---|---|---|
| Conversa | `conversas.status` | aguardando · em_atendimento · encerrada | chat, equipe, vigias. Cancelar **não** encerra mais a conversa sozinha para quem usa "Ver minhas marcações". |
| Pedido | `pre_agendamentos.status` / `etapa` | rascunho · pronto · agendado · cancelado | `agendado` só em `klingo_operacao_concluir` (sucesso com voucher) ou pela equipe; `cancelado` só quando o Klingo confirma. Antigo remarcado fica `agendado` com `conferencia_status = remarcado` (não conta duas vezes). |
| Operação | `klingo_operacao.estado` | pendente · executando · sucesso · falha · incerto · horario_tomado · cancelada | executor e vigia; tipos `marcar`, `remarcar`, `cancelar`, `ler_vouchers` |
| Marcação vista | `klingo_marcacao.situacao` | ativa · cancelada · remarcada · nao_listada | consulta ao Klingo, cancelamento confirmado, remarcação, webhook |
| Solicitação futura | `disponibilidade_pedido.estado` | ver §3 | gatilho de transição |

[NÃO feito] a separação *completa* em colunas próprias de "dependente de equipe" (pedido) e "conciliada" (operação): continuam sendo combinações de `ia_ativa`, `incerto` e as notas. Cada estado novo acima tem dono e teste, mas a lista não é uma máquina única.

## 7. Painel [feito]

"Lista de previsão" virou **Disponibilidade futura**: uma lista só, filtros por situação (procurando, vaga encontrada, avisados, aguardando paciente, viraram agendamento, expiradas, canceladas, **precisam de pessoa**), histórico por solicitação e "Cancelar procura" a pedido do paciente. Sem quadro novo.
