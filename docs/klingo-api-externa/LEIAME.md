# Klingo API Externa — documentação oficial (guardada em 12/11/2026)

Para consulta futura, sem depender do SwaggerHub estar no ar.

| Arquivo | O que é |
|---|---|
| **`GUIA-COMPLETO.md`** | **COMECE POR AQUI.** Manual de como usar a API: consultar horários, marcar (paciente com cadastro e paciente novo), convênio, resultados, webhook, a função `klingo-agenda-api`, testes reais, plano para o chat e cuidados. |
| `Klingo_API_Externa_Referencia.pdf` | Guia de referência rápida (8 páginas, versão 1.0.0), recebido do dono em 12/11/2026. Endpoints, fluxo de agendamento, webhook, modelos de dados e a lista do que **não** consta na documentação. |
| `swagger-telefonia-1.0.0.json` | A outra API que o Klingo indicou ("Confirmação"): `https://api-externa.klingo.app/api/telefonia` — confirmar marcações por ligação, NPS, bloqueios de agenda. **Não trata de cadastro nem de marcação.** |
| `roteiro-reuniao-suporte.md` | Roteiro para a reunião com o desenvolvedor do Klingo: objetivo, prova reproduzível do problema do paciente novo e perguntas. |
| `swagger-1.0.0.json` | A definição completa (OAS 2.0) baixada de `https://api.swaggerhub.com/apis/agsx30/klingo-api-externa/1.0.0` em 12/11/2026. É pública; não tem chave nem dado de paciente. |

Fonte: https://app.swaggerhub.com/apis/agsx30/klingo-api-externa/1.0.0 · Base: `https://api-externa.klingo.app/api` · Suporte: suporte@klingo.com.br.

A chave da clínica (`X-APP-TOKEN`) tem o formato `clinicacsi:<código>` e **nunca** vai para o repositório (fica no secret `KLINGO_APP_TOKEN` do Supabase).

## O que o PDF diz e vale lembrar
- Fluxo oficial: identificar (ou **pré-cadastrar se for novo**) → login (`/externo/login`, com `P<id>` para o id do paciente) → catálogos → horários → reservar (10 min) → marcar. O PDF **não explica como logar um pré-cadastro nem por que a reserva dele dá 401** (ver `docs/klingo-api-agendamento.md`, testes de 12/11/2026).
- Rotas de **marcar, reservar, cancelar, check-in e dados do paciente exigem o bearer do paciente**; catálogos e horários aceitam a chave da clínica **ou** o bearer.
- **Resultados e atendimentos usam só a chave da clínica:** `GET /atendimentos?data=`, `GET /resultado/{id_marcacao}` (HTML ou PDF em base64), `GET /resultado/pdf/{id_marcacao}`, `GET /resultado/pdf/an/{accession_number}` (imagem; valida por nascimento ou id do paciente). Útil para o envio de laudo ao paciente, hoje travado.
- **Webhook** (o Klingo chama uma URL nossa): cabeçalhos `X-APP-TOKEN`, `X-DOMAIN`, `X-EVENT` = `STATUS-MARCACAO | REMARCACAO | CHAMADA | FIM-ATENDIMENTO`; corpo com `id_marcacao`, `status` (A aberto, B bloqueado, C cancelado), `motivo`, `checkin`, `evento {nome, local}` e `nova` (voucher novo, só em remarcação).
- Adiantamentos, pagamentos e `/registrar_atendimento` mexem em dinheiro: **validar com o suporte antes de usar**.
- `GET /agenda/verificar_horario` é GET com corpo (estranho; evitar, usar `/agenda/horario_procedimentos`).

## O que o PDF lista como NÃO documentado (confirmar com o suporte)
Ambiente de homologação/sandbox; limite de requisições; se a chave da clínica tem permissão de criar agendamentos; campos obrigatórios de `POST /agenda/horario`; convênio inativado; data da última atualização do cadastro e hora real do atendimento; filtro de período em `/vouchers`; se `id_externo` aparece na agenda do Klingo; qual `id_plano` é o Particular; erros em conflito de horário; link e senha de resultado.

Já respondidos por teste real em 12/11/2026: a chave **vale** para `/agenda/*`; o Particular é o plano **1** (operadora PARTICULAR); o formato dos horários é `{"<data|médico|agenda|unidade|hora>": "HH:MM"}`; conflito de convênio vem como 403 "Nenhum médico credenciado…".
