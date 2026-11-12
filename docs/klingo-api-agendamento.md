# Agendamento automático pela API externa do Klingo (exemplo — 12/11/2026)

**Estado: exemplo escrito, testado com dados inventados e conferido com chamadas REAIS de leitura em 12/11/2026 (sem paciente). NÃO está publicado e NÃO está ligado ao chat.** Nada na produção mudou.

Fonte: https://app.swaggerhub.com/apis/agsx30/klingo-api-externa/1.0.0 (cópia da documentação oficial, PDF e JSON, em `docs/klingo-api-externa/`) (API "Klingo API Externa" 1.0.0, suporte@klingo.com.br). Endereço real: `https://api-externa.klingo.app/api`. Conferido em 12/11/2026: `GET /live` responde `OK [API1]` (sem chave, sem dado de paciente).

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

## Teste real de leitura (12/11/2026, só catálogo e agenda; nenhum dado de paciente)

A chave do Klingo (a mesma dos relatórios) tem o formato **`clinicacsi:<código>`**, com o prefixo. Sem o prefixo o Klingo responde `401 Token inválido`. Com ela: relatório #14028 devolveu as 64 linhas esperadas e as rotas abaixo responderam 200.

| Chamada | Resultado |
|---|---|
| `GET /live` | `OK [API1]` |
| `GET /unidades` | 1 unidade: id 1, "CLÍNICA DE SAÚDE E IMAGEM - CSI" (a agenda também usa unidade id 2, sigla PEDIATRIA, nome "DESENVOAR"). **`cnes` vem nulo**: filtrar por unidade com `cnes` não funciona; usar `id`/`sigla` |
| `GET /agenda/especialidades` | só 3: NEUROLOGIA (cbos 225112), PEDIATRIA (225124), RADIOLOGIA (225320) |
| `GET /agenda/exames?busca=ultra` | 22 exames (id, descr, TUSS, classe `USG`) |
| `GET /convenios` | 31 convênios com seus planos (id do plano é o que vai em `plano`) |
| `GET /agenda/horarios?especialidade=…&inicio=2026-11-13&fim=2026-11-23` | neurologia 39 horários em 7 dias; pediatria 50 em 11 dias; radiologia 1; um exame (id 1479) 0 |
| `GET /agenda/horario_procedimentos?horario=<chave>` | lista os procedimentos do horário (ex.: neurologia: 1096 CONSULTA e 1472 CONSULTA NEUROPEDIATRIA) |
| `…/horarios?…&plano=1` | PARTICULAR (operadora 1, é o padrão): igual ao sem filtro |
| `…/horarios?…&plano=12` | **403** `Nenhum médico credenciado para CONSULTA (68), para operadora ALERTA VIDA SAÚDE.` É regra de negócio, não falha: a função devolve `ok:true, total:0, motivo:"sem_medico_credenciado"` |

**Formato real dos horários** (confirmado; `normalizarHorarios` converte 100% dos reais):
`horarios[].horarios = {"2026-11-16|63|308|2|13:40": "13:40"}`, chave = `data|médico|agenda|unidade|hora`. Cada dia traz `procedimento` (número, ex.: 1096), `profissional` (id, nome, CRM) e `unidade` (id, nome, sigla). O topo da resposta traz `operadora`, `detalhe` (o procedimento), `periodo` e `hora_corte`.

Achados que mudam o desenho:
- Só 3 especialidades na API. Conferir se bate com o que o chat oferece hoje (o chat usa o catálogo `catalogo_agenda`).
- A unidade PEDIATRIA (id 2) atende neurologia e pediatria; a CSI (id 1) a radiologia. O texto mostrado ao paciente deve usar o nome da unidade da resposta.
- O 403 por convênio precisa virar mensagem ao paciente ("esse convênio não atende com este médico"), igual ao que o chat já faz com convênios.

## O que ainda NÃO sei

1. **Qual campo de `GET /paciente/cpf` é o id usado em `P<id>`** (o código tenta `id`, `id_paciente`, `id_origem`). Só se descobre com um paciente real que autorize; **não foi testado**.
2. **Se as rotas só de paciente (`reservar`, `horario`) também exigem `X-APP-TOKEN`** junto do Bearer (o cliente manda os dois). Idem: só testável com sessão de paciente.
3. **Se a marcação feita pela API aparece nos relatórios do Klingo** (#7, #14359) no mesmo ritmo das marcações da equipe. Hoje a equipe confere assim; precisa de uma marcação de teste.
4. Mapeamento do nosso catálogo para `procedimento`/`plano` da API (o id da API é o `procedimento` de cada dia; planos vêm de `/convenios`).
5. Limite de chamadas e expiração do `access_token`.

## Paciente novo e pré-cadastro (Klingo explicou em 12/11/2026, pelo grupo de WhatsApp)

- **"Toda marcação gera pré-cadastro"** e o pré-cadastro **"vai pra agenda"**: o paciente novo **não precisa de aprovação antes de marcar**; a recepção completa o cadastro depois, a partir da agenda.
- `POST /externo/register` devolve o id do **pré-cadastro**. **Esse id NÃO é o do paciente definitivo.** O login `P<id>` (com `P`) é para o paciente definitivo: em 12/11 o `P7960` abriu a sessão de OUTRA paciente que já existia. Nunca logar `P<id>` com um id de pré-cadastro.
- Hipótese ainda não testada: o pré-cadastro entra com o id **sem o `P`**, e a sessão traria `user.id` = o próprio id e `id_paciente` vazio (o Swagger descreve `id_paciente` como "id do cadastro definitivo"). **Qualquer login deve conferir nome, sexo e nascimento da sessão com o paciente esperado antes de reservar ou marcar**, e descartar a sessão se não bater.
- **Testado em 12/11/2026 (com autorização do próprio paciente):** `POST /externo/login {"id":"7960"}` (sem `P`) abriu a sessão do pré-cadastro certo (nome, sexo e nascimento conferiram; `user.id`=7960, `id_paciente`=null, `plano` vazio). Com essa sessão, `GET /agenda/horarios` funciona, mas **`POST /agenda/reservar`, `GET /paciente` e `GET /vouchers` respondem 401 "ID de cliente inválido []"**. Ou seja: a sessão de pré-cadastro (sem `id_paciente`) **não consegue reservar nem marcar** por essas rotas. Nenhuma reserva nem marcação foi criada. Falta descobrir com o Klingo como marcar paciente novo (portal? cadastro definitivo feito pela recepção?).
- O login só com a chave da clínica abre a sessão de qualquer paciente: o sistema precisa conferir CPF e nascimento antes (como o `klingo-paciente` já faz).

## Como trocar os horários do chat para esta API (plano, não feito)

Hoje: `chat-agenda-ao-vivo` lê o relatório #7 e o banco monta os horários (`chat_horarios`, `chat_horario_escolher`).

1. Publicar `klingo-agenda-api` (a leitura já foi provada acima; falta só provar dentro do Supabase, com o secret `KLINGO_APP_TOKEN`).
2. Nova função de banco (arquivo em `supabase/`, com rollback) que o chat chama no passo `horario`: pede os horários à função (com o token da conversa, como na `chat-agenda-ao-vivo`), guarda a **chave do horário** escolhido no pedido e mostra data, hora, médico e unidade. A grade e a ocupação ficam como **plano B** (interruptor em `config`, como `agenda_ao_vivo`).
3. Na confirmação do pedido (passo `confirmar`), chamar `marcar` com `executar:true`, gravar o voucher no pedido e marcar "Agendado"; se a API recusar (horário tomado), voltar ao passo `horario` com os horários novos.
4. Ligar o webhook do Klingo para atualizar o status sem esperar relatório.
5. Só então desligar `agenda-conferir`, `agendamento-reconhecer-klingo` e a ocupação por relatório, depois de medir na produção.

Cada mudança de banco segue o roteiro do `CLAUDE.md` (clone, testes, aplicar em partes, refazer o retrato, `npm run test:retrato`), e a de tela troca `VERSAO_APP` e `VERSAO` dos `sw.js`.

## Cuidados

- **Marcar é ação com efeito real** (gera horário, pode gerar e-mail ao paciente, afeta a agenda da clínica). Testar primeiro com o paciente de teste da clínica, em horário que possa ser cancelado depois (`DELETE /voucher`).
- A chave do Klingo continua só no secret `KLINGO_APP_TOKEN` do Supabase; nunca no repositório nem em página.
- Relatórios do Klingo: esta tarefa **não depende de relatório novo nem editado** (os 5 de `klingo-relatorios-pendentes.md` já existem); depende de a chave valer para a API de agenda (item 1 acima).
