# Guia completo: como usar a API externa do Klingo (consultar, marcar e o resto)

Escrito em 12/11/2026, a partir da documentação oficial e de **testes reais** feitos na produção da clínica CSI. Tudo o que está marcado como **provado** foi executado de verdade; o que está marcado como **não testado** vem só da documentação.

> **Resumo em 6 linhas**
> 1. A API tem a agenda de verdade: devolve os horários livres já descontando o que está marcado e as regras do médico, e **marca**.
> 2. São dois tipos de credencial: a **chave da clínica** (`X-APP-TOKEN`) e a **sessão do paciente** (`Authorization: Bearer`). Horários e catálogos usam só a chave; **reservar e marcar exigem a sessão do paciente**.
> 3. **Paciente já cadastrado**: achar pelo CPF → entrar como ele → reservar → marcar. **Provado.**
> 4. **Paciente novo**: pré-cadastro → entrar com o id do pré-cadastro (**sem a letra P**) → reservar → marcar, **sem a recepção aprovar nada**. **Provado.**
> 5. Também **provados**: marcar **exame**, reservar e soltar a reserva, **remarcar**, **trocar procedimento**, **cancelar pela API**, conflito de horário, convênio na marcação e as opções `revisao`, `obs` e `confirmado`.
> 6. **Resultado de exame** vem como PDF/HTML (não existe link nem senha); sem laudo a API responde 403 em HTML. O laudo pronto em si **não foi testado** (nenhum paciente de teste tem exame feito).
> 7. A função `klingo-agenda-api` (no Supabase) já faz o essencial, mas **ainda não está ligada ao chat**. A API tem **limite de requisições** (429).

Arquivos relacionados nesta pasta: `Klingo_API_Externa_Referencia.pdf` (guia oficial), `swagger-1.0.0.json` (definição completa), `swagger-telefonia-1.0.0.json` (API de confirmação), `roteiro-reuniao-suporte.md` (perguntas para o Klingo), `teste-marcacao.sh` (teste manual). Diário dos testes: `docs/klingo-api-agendamento.md`.

---

## 1. Conceitos

| Item | Valor |
|---|---|
| Endereço | `https://api-externa.klingo.app/api` (só https) |
| Documentação | https://app.swaggerhub.com/apis/agsx30/klingo-api-externa/1.0.0 |
| Suporte | suporte@klingo.com.br e o grupo de WhatsApp "Implantação Klingo - CSI" |
| Homologação (teste sem afetar a agenda) | **não existe na documentação.** Todo teste é em produção. Perguntar ao Klingo. |
| Teste de que está no ar | `GET /live` → `OK [API1]` ou `OK [API2]` (há mais de um servidor) |

### As duas credenciais
| Credencial | Cabeçalho | Para quê |
|---|---|---|
| **Chave da clínica** | `X-APP-TOKEN: clinicacsi:<código>` | Catálogos, horários livres, achar paciente, cadastrar, entrar (login), resultados, relatórios. |
| **Sessão do paciente** | `Authorization: Bearer <access_token>` | Reservar, marcar, cancelar, ver marcações, check-in, dados do paciente. |

- A chave **tem o prefixo `clinicacsi:`**. Sem o prefixo o Klingo responde `401 Token inválido`. É a mesma chave dos relatórios (`/api/info/relatorio`). Fica **só** no secret `KLINGO_APP_TOKEN` do Supabase; nunca em arquivo, repositório, página ou conversa.
- A sessão do paciente sai de `POST /externo/login` e vale **10 horas** (`expires_in: 36000`).
- Horários e catálogos aceitam qualquer uma das duas.

### Onde testar (importante)
O ambiente de testes do Claude envia as chamadas por um proxy que **mexe nos cabeçalhos**: lá, as rotas de paciente deram `401 "ID de cliente inválido []"` mesmo estando certas. **De dentro do Supabase (Edge Function) e do computador do dono funcionam.** Se aparecer esse 401 num ambiente estranho, teste de outro lugar antes de achar que o Klingo está errado.

---

## 2. Fluxos (passo a passo)

### 2.1 Consultar horários livres (**provado**)
```
GET /agenda/horarios?especialidade=225112&inicio=2026-11-17&fim=2026-11-27     (consulta: CBOS)
GET /agenda/horarios?exame=1479&inicio=…&fim=…                                  (exame: id do procedimento)
```
Parâmetros úteis: `plano` (**número** do plano; nome dá erro), `cnes`/`crm` (filtram unidade e médico; na CSI o `cnes` é nulo, então a unidade se identifica pelo `id`/`sigla`), `revisao`, `subespecialidade`, `telemed`, `sexo`/`nascimento` (quando não há sessão do paciente). Sem `fim`, a API busca 10 dias.

Resposta (resumo): `operadora`, `procedimento` (número, ex.: 1096), `detalhe`, `periodo` e `horarios[]`. Cada item é um **dia de um médico**:
```json
{ "id": "2026-11-17|63|312|2", "data": "2026-11-17", "procedimento": 1096,
  "profissional": { "id": 63, "nome": "…", "conselho": "CRM", "numero": 8993, "uf": "BA" },
  "unidade": { "id": 2, "nome": "DESENVOAR", "sigla": "PEDIATRIA", "cnes": null },
  "ordem_chegada": false, "faixa_ordem_chegada": null,
  "horarios": { "2026-11-17|63|312|2|14:00": "14:00", "2026-11-17|63|312|2|15:00": "15:00" } }
```
**A chave do horário** (`data|médico|agenda|unidade|hora`) é o que se manda para reservar e marcar. Sem plano informado, a API usa **PARTICULAR (plano 1)**. Depois de uma marcação, o horário some da lista.

Erros normais (não são falha do sistema):
- `403 "Nenhum médico credenciado para CONSULTA (68), para operadora X."` → esse convênio não atende com nenhum médico.
- `403 "Plano X inativo."` → o plano existe, mas está inativo (ex.: BRADESCO SAUDE, id 17).
- `403 {"plano":["Plano não identificado."]}` → o número do plano não existe (ou foi passado o nome).

### 2.2 Paciente que já tem cadastro (**provado**)
1. `GET /paciente/cpf?cpf=<11 dígitos, sem pontos>` → devolve o cadastro, com `id` já no formato **`P123456`**, `nome`, `sexo` (`M`/`F`), `dt_nasc`, `mae`, `docs`, `contatos`, `endereco`, `convenio`. Com pontos: `403 "O campo cpf deve ter 11 dígitos"`. Se não achar: `403 … "code":"PACIENTE_NAO_IDENTIFICADO"` (a mensagem repete o CPF; não registrar em log).
2. **Conferir o nascimento** (`dt_nasc` = o que o paciente informou). Se não bater, parar.
3. `POST /externo/login` com `{"id":"P123456"}` (o `id` **exatamente** como veio). Resposta: `access_token`, `user {id, nome, id_paciente, sexo, nascimento, plano {id, nome}}`.
4. **Conferir quem abriu a sessão**: `user.id` = o id, `user.nascimento` = o informado. Se não bater, descartar a sessão.
5. (Opcional) `POST /agenda/reservar` com `{"id":"<chave do horário>","procedimento":"1096","plano":1,"email":false}` e o Bearer → segura o horário por **10 minutos** e devolve `id` (da reserva), `data`, `hora`, `expira` (ex.: `2026-11-12 13:03:17`), `profissional`, `instrucao` e `validacao[]`. **Reservar antes não é obrigatório**: dá para marcar direto. Enquanto está reservado, o horário **continua aparecendo** na lista pública, mas qualquer outra pessoa que tente reservar ou marcar recebe `403 "Horário já ocupado. [reservado 2026-11-17 11:00/6901]"` (reservar) ou `400` com a mesma frase (marcar).
6. `POST /agenda/horario` com o mesmo corpo → **marca** e devolve o voucher: `id`, `status` (`agendado`), `data`, `hora`, `procedimento`, `realizador` (médico), `unidade`.
7. Se a marcação falhar depois da reserva, soltar a reserva: `DELETE /agenda/reservar` com `{"id": <id da reserva, número>}` → `200 {"status":"…"}` (**provado**; o horário volta à lista).

Alternativa para achar o paciente: `POST /paciente/identificar` com `{"cpf":"…","dt_nascimento":"AAAA-MM-DD"}` (ou telefone + nascimento) → **200 já com a sessão** (`access_token`, `user`, `unidade`) para paciente com cadastro (**provado**). Para quem só tem pré-cadastro (ou não existe): `403 PACIENTE_NAO_IDENTIFICADO`.

`GET /paciente` (Bearer) devolve o cadastro do próprio paciente: `id`, `chave`, `nome`, `sexo`, `dt_nasc`, `mae`, `docs`, `contatos`, `endereco`, `convenio {id, nome, reg_ans, id_paciente, validade…}`. `PUT /paciente` atualiza (**provado**: `200` devolvendo o cadastro; basta mandar o trecho a mudar, ex.: `{"contatos":{"celular":"…"}}`).

### 2.3 Paciente novo (**provado**)
1. `POST /externo/register` com
```json
{ "paciente": { "nome": "…", "sexo": "M", "dt_nasc": "AAAA-MM-DD", "mae": "…",
                "docs": { "cpf": "11 dígitos" }, "contatos": { "celular": "71999999999" } } }
```
→ `200 {"id": 7960}`. Esse é o id do **pré-cadastro**. Bastaram estes campos; e-mail e endereço não foram exigidos (o Swagger não marca nenhum campo como obrigatório).
2. `POST /externo/login` com `{"id":"7960"}` — **sem o `P`**. A sessão vem com `user.id` = 7960 e `id_paciente` **vazio** (é pré-cadastro, ainda sem cadastro definitivo).
3. **Conferir id, nome e nascimento da sessão.**
4. Reservar e marcar exatamente como no paciente já cadastrado (2.2, passos 5 e 6). Funcionou sem aprovação da recepção.

> ⚠️ **O perigo do `P`.** O número do pré-cadastro e o número de um paciente definitivo vêm de tabelas diferentes e **podem coincidir**. Logar `P7960` abriu a sessão de **outra paciente** que já existia. Regra: **pré-cadastro = número puro; definitivo = `P` + número**, e nunca misturar. E o login aceita **qualquer id** só com a chave da clínica: por isso o sistema deve sempre conferir a identidade antes e depois.

Como o Klingo explicou: "toda marcação gera pré-cadastro" e "vai pra agenda": o pré-cadastro não precisa de aprovação antes de marcar; a recepção o completa depois.

**Provado sobre o pré-cadastro (12/11/2026):**
- `GET /paciente`, `GET /vouchers`, reservar, marcar, trocar procedimento e cancelar funcionam com a sessão do pré-cadastro (`id_paciente` vazio).
- **Registrar o mesmo CPF de novo NÃO é recusado: cria outro pré-cadastro** (outro id: 7960 → 7992). A API não evita duplicidade. **O sistema precisa guardar o id do pré-cadastro por paciente e nunca chamar `/externo/register` de novo para a mesma pessoa.**
- `GET /paciente/cpf` continua sem achar o CPF mesmo depois de marcar e depois do segundo registro.
- O campo `mae` enviado no registro **não aparece** depois (`mae` vem vazio em `GET /paciente`); celular e CPF aparecem.
- O Planserv (convênio) foi aceito na marcação mesmo com o cadastro sem convênio nenhum (ver 2.4).

Pontos em aberto do paciente novo:
- **A busca por CPF não acha quem só tem pré-cadastro.** Se a pessoa voltar, o sistema não sabe que ela já se cadastrou e pode gerar um segundo pré-cadastro. Precisa de uma regra (ex.: guardar o id do pré-cadastro no nosso banco, por paciente) e de combinar com a recepção como juntam duplicados.
- O que a recepção vê do pré-cadastro na agenda (a conferir com o Klingo).

### 2.4 Convênio (**provado** na consulta e na marcação)
- Lista: `GET /convenios` → 31 convênios, cada um com os seus `planos`. O `plano` que vai na busca e na marcação é o **id do plano** (ex.: PARTICULAR = 1, PLANSERV = 28, SUS = 34).
- **Planos inativos não aparecem na lista**, mas respondem pelo número (`Plano X inativo`).
- **ASSEFAZ não foi encontrado** (nem na lista, nem pelo nome). Falta o número do plano com a recepção.
- Planos dentro de "Particular": 1 PARTICULAR, 8 CORTESIA, 9 COLABORADOR (DESCONTO), 10 FAZ BEM BENEFÍCIOS, 4949 MEU TESOURO.
- `GET /agenda/verificar_horario` e `GET /agenda/horario_procedimentos?horario=<chave>` mostram operadoras e procedimentos aceitos por um horário. **Provado na marcação:** com o plano **Planserv (28)** a marcação foi **aceita sem carteirinha/matrícula** no cadastro (a recepção confere depois); com plano **inativo** (Bradesco, 17) a marcação é recusada: `403 "Plano BRADESCO SAUDE inativado."`. `GET /agenda/especialidades?id_plano=28` lista as especialidades que o plano atende (neurologia e pediatria para o Planserv). `GET /preco?id_procedimento=1096&id_plano=1` → `{id_item_tabela, valor}` (o valor veio inteiro; `id_item_tabela` nulo nesses casos). O que o cadastro guarda de convênio fica em `convenio` (`id`, `nome`, `reg_ans`, `id_plano`, `validade`…).

### 2.5 Cancelar, remarcar, trocar procedimento, check-in e ver marcações (**provado**)
- `GET /vouchers` (Bearer): lista as marcações **ativas** do paciente (`id`, `status` = `agendado`/`atendido`/`checkin`, `tipo`, `data`, `hora`, `realizador`, `unidade`…). **Marcação cancelada não aparece.** Não tem filtro de período. Paciente sem marcação: `[]`.
- **Cancelar:** `DELETE /voucher` com `{"id":"26638"}` (Bearer) → `200`, e o horário **volta à lista na hora**. Cancelar de novo: `403 "Agendamento já cancelado."`. Os vouchers de teste foram cancelados assim, pela API.
- **Remarcar:** `POST /agenda/horario` com o novo horário e `"remarcacao": <id do voucher antigo, número>` → `200` com o **voucher novo**; o antigo é **cancelado sozinho**.
- **Trocar o procedimento** de uma marcação: `PUT /agenda/procedimento` com `{"id_marcacao": <número>, "id_procedimento": 1472}` → `200` com o voucher.
- **Check-in:** `POST /checkin` só vale **no dia do atendimento**; de outra data: `403 "Agendamento para outra data: 26641 / 2026-11-17"`. (Check-in no dia, `DELETE /checkin` e a resposta do check-in expresso **não foram testados**.)
- **Opções da marcação, provadas:** `id_externo` fica gravado no voucher; `obs` fica gravada (`"obs":"…"` no voucher); `revisao:true` e `confirmado:"texto"` foram aceitos (o `status` continua `agendado`; a confirmação não aparece em `/vouchers`); `email:false` não envia e-mail.

### 2.6 Resultado de exame (**parcialmente testado**)
- Rotas com **só a chave da clínica**: `GET /resultado/{id_marcacao}` (laudo em HTML e PDF base64, `pronto`, `status`), `GET /resultado/pdf/{id_marcacao}` (laboratório), `GET /resultado/pdf/an/{accession_number}` (imagem; confere nascimento ou id do paciente). `GET /atendimentos?data=` lista os atendimentos do dia.
- **Não existe link nem senha**: o resultado vem como arquivo. Não há como ler senha de portal pela API (só criar conta com `/externo/portal/register` ou mandar e-mail de recuperação com `/externo/portal/recuperar`).
- Para achar o número da marcação: entrar como o paciente e ler `GET /vouchers` (os `atendido`).
- **Provado:** para uma marcação **sem laudo** (voucher de teste cancelado), `GET /resultado/{id}` e `GET /resultado/pdf/{id}` respondem **`403` com uma página HTML** (não JSON). O código deve tratar 403 como "sem resultado" e **não** tentar ler JSON. **Não testado:** o laudo pronto em si (nenhum paciente de teste tem exame feito; não se buscou laudo de terceiros).
- Cuidado: `GET /atendimentos?data=AAAA-MM-DD` devolve **todos os atendimentos do dia com dados completos dos pacientes** (nome, CPF, mãe, endereço, telefone; ~140 a 250 linhas) — não usar sem necessidade; **não traz o número da marcação**, então não leva ao laudo.
- Regras: conferir CPF + nascimento antes; só entregar se `pronto` for verdadeiro; não guardar o PDF nem logar o conteúdo.

### 2.7 Aviso automático de mudança (webhook, **não configurado**)
O Klingo chama uma URL nossa quando a marcação muda. Cabeçalhos `X-APP-TOKEN`, `X-DOMAIN`, `X-EVENT` (`STATUS-MARCACAO`, `REMARCACAO`, `CHAMADA`, `FIM-ATENDIMENTO`). Corpo: `id_marcacao`, `status` (A aberto, B bloqueado, C cancelado), `motivo`, `checkin`, `evento {nome, local}`, `nova` (só na remarcação). Substitui a leitura de relatórios para saber que um paciente chegou ou cancelou.

### 2.8 API de Confirmação ("telefonia")
`https://api-externa.klingo.app/api/telefonia` (chave da clínica): `POST /entrada`, `GET /lista/{data}` (marcações do dia para confirmar), `GET /{id}`, `POST /confirmar`, `POST /nps`, `GET /lista_ultimo_por_cpf`, `GET /bloqueios`. É para ligações de confirmação, NPS e bloqueios de agenda. **Não trata de cadastro nem de marcação.** **Testada em 12/11/2026:** `GET /api/telefonia/live` e `GET /api/telefonia/bloqueios` responderam **404** com a chave da clínica: provavelmente **não está habilitada** para a CSI. Perguntar ao Klingo se for útil.

---

## 3. O que existe na clínica CSI (consultado em 12/11/2026)

| Item | Valores |
|---|---|
| Unidades | **1** = CLÍNICA DE SAÚDE E IMAGEM - CSI (sigla CSI) · **2** = DESENVOAR (sigla PEDIATRIA). `cnes` nulo nas duas. |
| Especialidades na API | só **3**: NEUROLOGIA (cbos `225112`), PEDIATRIA (`225124`), RADIOLOGIA (`225320`). Conferir se bate com o que o chat oferece. |
| Procedimentos de consulta | neurologia **1096** CONSULTA e **1472** CONSULTA NEUROPEDIATRIA · pediatria **1132** CONSULTA · radiologia **1150** CONSULTA MÉDICA. |
| Exames | `GET /agenda/exames?busca=ultra` devolve id, descrição, TUSS, classe (ex.: `USG`). |
| Convênios | 31 ativos na lista (AMIL, BRADESCO, SULAMÉRICA, UNIMED, PLANSERV, SUS…). Planos inativos ficam escondidos. |
| Unidade de exames | existe uma terceira unidade, **"CSI - 2" (id 3)**, usada por ressonância (apareceu na chave do horário: `…|101|77|3|07:00`). `GET /unidades` listou só 1; a lista de horários mostra as outras. |
| Exames com horário (15 dias) | ECG (1853) 8; mamografia (1244/1889/586/1573) ~603 (14 dias); ultrassons (1724, 1725) 19 e 71; ecocardiograma/elastografia (1920, 1558) 4; ressonância defecorresonância (1996) 414. Todos pela unidade CSI; exame sem horário devolve lista vazia. |
| Outros catálogos | `GET /profissionais?especialidade=225112` → 2 médicos (com `especialidades[].paciente_idade_maxima`); `GET /profissional?id_medico=63` → inclui `regras` (`in_prazo_revisao`, idade mínima/máxima, sexo); `GET /agenda/profissionais?id_procedimento&id_plano`; `GET /agenda/consultas?cbos=225112` → 1096 e 1472; `GET /formas_de_pagamento` → 9 formas; `GET /recepcoes?cnes=1` → 3 recepções; `GET /regiao_cd?cnes=1` → vazio (sem coleta domiciliar). |
| Disponibilidade vista | neurologia: 71 horários em 15 dias (uma médica, unidade PEDIATRIA); pediatria: 50 em 11 dias (vários médicos); radiologia: poucos (unidade CSI). |

---

## 3.1 Limite de requisições e tabela de erros (**provado**)

- **Limite:** depois de ~14 chamadas seguidas, sem pausa, o Klingo respondeu **`429`** com uma página HTML. A função de testes passou a esperar **0,8 s entre chamadas** e não viu mais 429; o limite exato é desconhecido (perguntar ao Klingo). O código deve esperar e tentar de novo, e **nunca martelar** a API.
- Respostas de erro podem ser JSON `{"status_code","msg","code"}` ou, em alguns casos (403 de resultado, 429), **uma página HTML**: sempre checar o tipo antes de ler JSON.

| Situação | Código e mensagem |
|---|---|
| Chave ausente | `401 Token de app não enviado. [HEADER:X-APP-TOKEN]` |
| Chave errada ou sem o prefixo `clinicacsi:` | `401 Token inválido. [HEADER:X-APP-TOKEN]` |
| Rota de paciente sem sessão válida (ex.: proxy que muda o cabeçalho) | `401 ID de cliente inválido []` |
| CPF fora do formato | `403 {"cpf":["O campo cpf deve ter 11 dígitos."]}` |
| Paciente não encontrado | `403 {"msg":"Paciente não identificado: . <cpf>","code":"PACIENTE_NAO_IDENTIFICADO"}` (a mensagem repete o CPF: não registrar em log) |
| Plano que não existe (ou passado pelo nome) | `403 {"plano":["Plano não identificado."]}` |
| Plano inativo (busca) | `403 {"status_code":403,"msg":"Plano BRADESCO SAUDE inativo."}` |
| Plano inativo (marcação) | `403 {"msg":"Plano BRADESCO SAUDE inativado.","status_code":403}` |
| Convênio sem médico | `403 "Nenhum médico credenciado para CONSULTA (68), para operadora X."` |
| Horário reservado/ocupado (reservar) | `403 "Horário já ocupado. [reservado 2026-11-17 11:00/6901]"` |
| Horário reservado/ocupado (marcar) | `400 "Horário já ocupado. …ID: 6901"` (com `code` e `origem`) |
| Cancelar voucher já cancelado | `403 "Agendamento já cancelado."` |
| Check-in fora do dia | `403 "Agendamento para outra data: <voucher> / <data>"` |
| Resultado sem laudo | `403` com página HTML |
| Limite de requisições | `429` com página HTML |

> **Atualização de 12/11/2026 (noite):** a `klingo-agenda-api` passou à **versão 0.4, sem escrita** (`marcar` e `marcar_pre` respondem 410). Quem marca agora é a `klingo-executar`, só com o id de uma operação aprovada pelo banco, e quem pede horários ao chat é a `chat-agenda-api`. As linhas `marcar` e `marcar_pre` da tabela abaixo descrevem o que a função fazia na v0.3. Ver `docs/klingo-autoatendimento.md`.

## 4. A função `klingo-agenda-api` (no Supabase)

Código em `supabase/functions/klingo-agenda-api/` (`api.ts` = cliente; `index.ts` = função; `api.test.ts` = 11 testes). Publicada em 12/11/2026 com `verify_jwt=false`, protegida pelo cabeçalho `x-sync-key` (= `config.ia_segredo`), como as outras funções do projeto. Usa o secret `KLINGO_APP_TOKEN`. (Desde 12/11/2026 à noite só lê; o chat usa `chat-agenda-api` e `klingo-executar`.)

| Ação | O que faz | Efeito |
|---|---|---|
| `versao` | confere se a API está no ar | só lê |
| `horarios` | horários livres (`especialidade` ou `exame`, `inicio`, `fim` até 31 dias, `plano`…), em lista enxuta | só lê |
| `marcar` | paciente **com cadastro**: CPF + nascimento → sessão conferida → reservar → marcar. Sem `"executar": true` é só ensaio. | marca de verdade com `executar:true` |
| `marcar_pre` | paciente **novo** (pré-cadastro): `pre_id` (só dígitos) + `nome` + `nascimento` → login sem `P` → sessão conferida (id, nome e nascimento) → reservar → marcar | marca de verdade com `executar:true` |

Segurança embutida: `marcar` só aceita id no formato `P` + dígitos; `marcar_pre` só aceita dígitos puros e exige o nome; a sessão é descartada se id, nome ou nascimento não baterem; o erro do Klingo nunca é repassado (só status e caminho); se a marcação falha, a reserva é solta; `403` de plano vira `ok:true, total:0, motivo:"sem_medico_credenciado"`; nada de paciente vai para log.

Exemplo de chamada de dentro do banco (a chave interna é lida no próprio SQL e **nunca é mostrada**):
```sql
select net.http_post(
  url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/klingo-agenda-api',
  headers := jsonb_build_object('Content-Type','application/json','x-sync-key',(select valor from public.config where chave='ia_segredo')),
  body := jsonb_build_object('acao','horarios','especialidade','225112','inicio','2026-11-17','fim','2026-11-20'));
-- a resposta fica em net._http_response (id devolvido acima)
```
**Função temporária `klingo-teste-api`:** foi usada em 12/11/2026 para rodar os testes com sessão de paciente (o ambiente do Claude não consegue, por causa do proxy). **Foi desativada** (responde 410 e exige JWT) e **pode ser apagada** no painel do Supabase. Não foi para o repositório de propósito: ela executava passos arbitrários na API com a sessão de qualquer paciente (protegida só pela chave interna).

Publicar de novo: painel https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions (ou a ferramenta de deploy), mantendo `verify_jwt=false`.

---

## 5. Registro dos testes reais (12/11/2026)

| Teste | Resultado |
|---|---|
| Chave sem prefixo `clinicacsi:` | 401 "Token inválido" |
| Chave completa: relatório #14028, catálogos, horários, convênios | tudo 200 |
| Horários com e sem sessão de paciente | iguais (Particular) |
| `plano=12` (ALERTA VIDA), `plano=17` (BRADESCO) | 403 sem médico credenciado / plano inativo |
| `GET /paciente/cpf` de quem não existe | 403 `PACIENTE_NAO_IDENTIFICADO` |
| Pré-cadastro (`/externo/register`) | 200 com o id do pré-cadastro |
| Login `P<id do pré-cadastro>` | abriu **outro paciente** (perigo) |
| Login do pré-cadastro **sem `P`** | sessão certa (id_paciente vazio) |
| Reserva/`GET /paciente` **pelo ambiente do Claude** | 401 "ID de cliente inválido" (era o proxy) |
| Marcação, paciente com cadastro, pela função | **voucher 26610** (e 26617 na repetição) |
| Marcação, paciente novo, pela função | **voucher 26616** |
| `ASSEFAZ` no catálogo e no filtro | não encontrado (provavelmente plano inativo/escondido; falta o número com a recepção) |
| **Grupo 1** (paciente novo): `GET /paciente`, `GET /vouchers` | 200; `[]` sem marcações |
| Reservar → ver lista → soltar → lista | reserva 200 (expira em 10 min); horário continua na lista pública; soltar 200 |
| Marcar, `PUT /agenda/procedimento`, `DELETE /voucher` | 200 / 200 / 200; horário volta à lista |
| **Grupo 2:** conflito entre dois pacientes | 2º recebe 403 (reservar) e 400 (marcar): "Horário já ocupado" |
| Remarcar (`remarcacao`) | 200; voucher antigo cancelado sozinho |
| Cancelar voucher já cancelado | 403 "Agendamento já cancelado." |
| Check-in de consulta futura | 403 "Agendamento para outra data" |
| **Grupo 3:** `GET /paciente`, `/vouchers`, `/autorizacoes` (paciente com cadastro) | 200 (vazios) |
| `POST /paciente/identificar` com CPF + nascimento | 200 com sessão |
| Marcar com Planserv (28), sem convênio no cadastro | 200 (aceito); cancelado |
| Marcar com plano inativo (17) | 403 "Plano … inativado." |
| `PUT /paciente` | 200 |
| `POST /externo/register` repetido (mesmo CPF) | 200 com **outro id** (duplicidade permitida) |
| `GET /resultado/{id}` e `/pdf/{id}` sem laudo | 403 HTML |
| Catálogos (profissionais, consultas, preço, formas de pagamento, recepções) | 200; `/precos` deu 429 (limite) |
| API de telefonia (`/live`, `/bloqueios`) | 404 (não habilitada) |
| **Grupo 4:** marcar exame ultrassom 1725; ressonância 1996 (unidade 3); `revisao`, `obs`, `confirmado` | todos 200; cancelados |
| Sobrou marcação de teste? | não (conferido por `GET /vouchers` nos dois pacientes) |

Vouchers de teste (todos neurologia, 17/11/2026, Dra. Geanne, unidade DESENVOAR, plano 1): 26610, 26616, 26617 — já cancelados pelo call center.

---

## 5.1 O que continua NÃO testado (e por quê)
- **Laudo pronto** (HTML/PDF): nenhum paciente de teste tem exame feito; não se buscou laudo de terceiros.
- **Check-in no dia do atendimento** e `DELETE /checkin`: exigiria uma marcação para hoje.
- **`POST /externo/portal/register`, `/externo/portal/login`, `/externo/portal/recuperar`**: criam conta do portal (e-mail e senha) e mandam e-mail; não são necessários para marcar.
- **Webhook**: quem configura a URL é o Klingo (pedir a eles).
- **Plano ASSEFAZ**: não aparece no catálogo; falta o número com a recepção.
- **`email: true`** (e-mail de confirmação ao paciente): os pacientes de teste não têm e-mail cadastrado.
- **`GET /agenda/verificar_horario`**: é um GET com corpo (a documentação é estranha aqui); usar `horario_procedimentos`.
- **Telemedicina (`telemed`), coleta domiciliar (`id_regiao_cd`), agenda por ordem de chegada (`ordem_chegada`), `lista` de procedimentos associados, `solicitante` em exame, `/requisicao`**: nenhum horário de teste usou.
- **Dinheiro** (`/adiantamento`, `/pagamento`, `/registrar_atendimento`): **de propósito não testados**; validar com o suporte.
- **Homologação**: não existe; todos os testes foram em produção e **cancelados no fim**.

## 6. Plano para ligar ao chat

Regras do projeto (`CLAUDE.md`): toda mudança de banco = arquivo novo em `supabase/` (fluxograma, versão, rollback) → testar no clone → aplicar em partes → medir → refazer o retrato → `npm run test:retrato`; toda mudança de tela troca `VERSAO_APP` (chat) e `VERSAO` nos `sw.js`.

0. **Limite de requisições:** o chat não pode chamar a API a cada tecla; guardar o resultado por alguns segundos (como a `chat-agenda-ao-vivo` faz) e tratar `429` com espera.
1. **Horários pela API (primeiro, sem risco de marcar):** no passo `horario` do chat, pedir os horários à função (com o token da conversa, como a `chat-agenda-ao-vivo`), guardar a **chave do horário** escolhido no pedido e mostrar dia, hora, médico e unidade. A grade atual (`catalogo_agenda` − `agenda_ocupacao`) fica como **plano B**, com interruptor em `config`. Tratar `sem_medico_credenciado` e plano inativo com mensagem clara.
2. **Marcação de quem já tem cadastro:** no passo `confirmar`, chamar `marcar` com `executar:true`, gravar o voucher no pedido e marcar "Agendado". Se o horário foi tomado, voltar ao passo `horario` com horários novos.
3. **Paciente novo:** a função passa a fazer o `/externo/register` + `marcar_pre`. **Guardar o id do pré-cadastro por paciente no nosso banco e nunca registrar de novo** (a API aceita duplicar: provado). Combinar com a recepção como juntam os duplicados.
4. **Webhook** do Klingo para status/chegada/cancelamento; depois desligar as rotinas que leem relatório (`agenda-conferir`, `agendamento-reconhecer-klingo`, ocupação por relatório), **só depois de medir**.
5. **Resultados:** ação `resultados` na função, com conferência de CPF + nascimento.

**Decisões do dono ainda abertas:** o que o chat faz com convênio inativo ou não atendido (encaminhar à equipe?); se o paciente novo marca direto ou fica com confirmação da equipe; qual o plano da ASSEFAZ; se o e-mail de confirmação do Klingo ao paciente deve ser enviado (`email: true`).

## 7. Perguntas para o Klingo (ver `roteiro-reuniao-suporte.md`)
Ambiente de homologação; limite de requisições; campos obrigatórios de `POST /agenda/horario` e do `register`; o que a recepção vê do pré-cadastro e como duplicidade de CPF é tratada; se há como achar pré-cadastro por CPF; como o `id_externo` aparece na agenda; erro quando o horário foi tomado entre a reserva e a marcação; número do plano ASSEFAZ; o login `P<id>` aceitar qualquer id é esperado?

## 8. Cuidados (privacidade e operação)
- A chave do Klingo **nunca** vai para repositório, página, conversa ou log. Se ela foi colada em algum chat, peça uma nova ao suporte e troque o secret.
- Dado de paciente (nome, CPF, nascimento, telefone, laudo) **não** vai para log nem para arquivo do projeto; a função só devolve o necessário (voucher, data, hora, médico, unidade).
- **Marcar é ação real**: ocupa agenda, pode disparar e-mail ao paciente. Testar só com paciente que autorizou e avisar o call center para cancelar.
- Rotas de **dinheiro** (`/adiantamento`, `/pagamento`, `/registrar_atendimento`): validar com o suporte antes de qualquer uso.
- Identidade: sempre conferir **antes** (CPF + nascimento) e **depois** (id/nome/nascimento da sessão) do login.

## 9. Glossário
**Voucher** = a marcação (agendamento). **Chave do horário** = `data|médico|agenda|unidade|hora`. **Pré-cadastro** = cadastro provisório criado pela API; id sem `P`. **Cadastro definitivo** = paciente do Klingo; id com `P`. **Plano** = convênio/plano (id numérico); Particular = 1. **CBOS** = código da especialidade. **Sessão** = o `access_token` do paciente (Bearer).
