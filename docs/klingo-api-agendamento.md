# Agendamento automático pela API externa do Klingo (exemplo — 12/11/2026)

**Estado: exemplo escrito e testado com dados inventados. NÃO está publicado, NÃO está ligado ao chat e NÃO foi chamado com a chave real.** Nada na produção mudou.

Fonte: https://app.swaggerhub.com/apis/agsx30/klingo-api-externa/1.0.0 (API "Klingo API Externa" 1.0.0, suporte@klingo.com.br). Endereço real: `https://api-externa.klingo.app/api`. Conferido em 12/11/2026: `GET /live` responde `OK [API1]` (sem chave, sem dado de paciente).

## O que a API faz (e o que usávamos até hoje)

Até hoje usávamos só `/api/info/relatorio` (somente leitura) e deduzíamos os horários livres no banco (grade `catalogo_agenda` menos `agenda_ocupacao`). A API externa tem **a agenda de verdade**: ela devolve os horários livres já descontando o que está marcado, bloqueios e regras do médico, e **marca**.

| Para quê | Endpoint | Credencial |
|---|---|---|
| Horários livres | `GET /agenda/horarios` (`especialidade` = CBOS ou `exame`, `inicio`, `fim`, `cnes`, `crm`, `plano`, `revisao`, `subespecialidade`, `telemed`) | só a chave da clínica |
| Procedimentos que cabem num horário | `GET /agenda/horario_procedimentos?horario=<chave>` | chave |
| Achar o paciente | `GET /paciente/cpf?cpf=` · `POST /paciente/identificar` (telefone + nascimento ou CPF) | chave |
| Sessão do paciente | `POST /externo/login` com `{"id":"P<id>"}` → `access_token` | chave |
| Segurar o horário 10 min | `POST /agenda/reservar` · `DELETE /agenda/reservar` | **sessão do paciente** |
| **Marcar** | `POST /agenda/horario` → voucher | **sessão do paciente** |
| Ver / cancelar marcação | `GET /vouchers` · `DELETE /voucher` | sessão |
| Remarcar | `POST /agenda/horario` com `remarcacao: <id da marcação antiga>` | sessão |
| Chegada | `POST /checkin` | sessão |
| Catálogos | `/agenda/especialidades`, `/agenda/exames`, `/agenda/profissionais`, `/unidades`, `/convenios`, `/preco(s)` | chave |
| Aviso de mudança | webhook (`STATUS-MARCACAO`, `REMARCACAO`, `CHAMADA`, `FIM-ATENDIMENTO`) | cabeçalhos `X-APP-TOKEN`, `X-DOMAIN`, `X-EVENT` |

Envio: `X-APP-TOKEN: <chave>` e, nas rotas de paciente, `Authorization: Bearer <access_token>`.

## Fluxo de marcação

```
chat  →  horarios (chave)  →  paciente escolhe  →  CPF + nascimento conferem?
      →  login P<id>  →  reservar (10 min)  →  marcar  →  voucher
                                         └─ se marcar falhar: cancelar reserva
```

## O que foi escrito (`supabase/functions/klingo-agenda-api/`)

- `api.ts`: cliente da API (versão, horários, CPF, login, reservar, marcar, cancelar reserva) e `normalizarHorarios`, que devolve uma lista plana `{id, data, hora, profissional, unidade}`.
- `index.ts`: Edge Function com `x-sync-key` (= `config.ia_segredo`), ações `versao`, `horarios` e `marcar`.
  - `marcar` **por padrão só ensaia**: identifica pelo CPF e confere o nascimento, e para. Só reserva e marca com `"executar": true`.
  - Se a marcação falhar depois da reserva, a reserva é solta.
  - Nunca devolve nome, CPF, telefone nem o corpo de erro do Klingo (só status e caminho). Nada vai para o log.
- `api.test.ts`: 11 testes com dados inventados (`npm run test:edge`, dentro de `testes/`).

Exemplos de chamada (depois de publicada; trocar a chave pela `config.ia_segredo`):

```bash
curl -X POST "$SUPABASE_URL/functions/v1/klingo-agenda-api" -H "x-sync-key: $CHAVE" -d '{"acao":"versao"}'
curl -X POST "$SUPABASE_URL/functions/v1/klingo-agenda-api" -H "x-sync-key: $CHAVE" \
  -d '{"acao":"horarios","especialidade":"225265","inicio":"2026-11-16","fim":"2026-11-20"}'
```

## O que ainda NÃO sei (precisa de uma chamada real)

1. **Se a nossa chave (`KLINGO_APP_TOKEN`, usada nos relatórios) também vale para `/agenda/*` e `/externo/login`.** Se for recusada (401/403), pedir ao suporte do Klingo a habilitação.
2. **Formato exato de `horarios[].horarios`.** O Swagger só diz "objeto com ID e horário". `normalizarHorarios` aceita as formas prováveis; com uma resposta real, apertar a função e o teste.
3. **Qual campo de `GET /paciente/cpf` é o id usado em `P<id>`** (o código tenta `id`, `id_paciente`, `id_origem`). Pode ser o próprio prontuário.
4. **Se as rotas só de paciente também exigem `X-APP-TOKEN`** junto do Bearer (o cliente manda os dois).
5. **Se `GET /agenda/horarios` sem sessão exige `sexo` e `nascimento`** (o Swagger os cita para esse caso).
6. O que é `plano` (id do plano/operadora) e `procedimento` (código) para cada exame do nosso catálogo: o mapeamento vem do catálogo sincronizado (`catalogo_*`) ou de `/agenda/exames` e `/agenda/consultas`.
7. **Particular/SUS e convênio:** como o plano "Particular" aparece em `/convenios`.
8. Limite de chamadas e expiração do `access_token`.

## Como trocar os horários do chat para esta API (plano, não feito)

Hoje: `chat-agenda-ao-vivo` lê o relatório #7 e o banco monta os horários (`chat_horarios`, `chat_horario_escolher`).

1. Publicar `klingo-agenda-api` e fazer as 3 chamadas de teste acima (`versao`, `horarios` de uma consulta e de um exame) para fechar os itens 1 a 3.
2. Nova função de banco (arquivo em `supabase/`, com rollback) que o chat chama no passo `horario`: pede os horários à função (com o token da conversa, como na `chat-agenda-ao-vivo`), guarda a **chave do horário** escolhido no pedido e mostra data, hora, médico e unidade. A grade e a ocupação ficam como **plano B** (interruptor em `config`, como `agenda_ao_vivo`).
3. Na confirmação do pedido (passo `confirmar`), chamar `marcar` com `executar:true`, gravar o voucher no pedido e marcar "Agendado"; se a API recusar (horário tomado), voltar ao passo `horario` com os horários novos.
4. Ligar o webhook do Klingo para atualizar o status sem esperar relatório.
5. Só então desligar `agenda-conferir`, `agendamento-reconhecer-klingo` e a ocupação por relatório, depois de medir na produção.

Cada mudança de banco segue o roteiro do `CLAUDE.md` (clone, testes, aplicar em partes, refazer o retrato, `npm run test:retrato`), e a de tela troca `VERSAO_APP` e `VERSAO` dos `sw.js`.

## Cuidados

- **Marcar é ação com efeito real** (gera horário, pode gerar e-mail ao paciente, afeta a agenda da clínica). Testar primeiro com o paciente de teste da clínica, em horário que possa ser cancelado depois (`DELETE /voucher`).
- A chave do Klingo continua só no secret `KLINGO_APP_TOKEN` do Supabase; nunca no repositório nem em página.
- Relatórios do Klingo: esta tarefa **não depende de relatório novo nem editado** (os 5 de `klingo-relatorios-pendentes.md` já existem); depende de a chave valer para a API de agenda (item 1 acima).
