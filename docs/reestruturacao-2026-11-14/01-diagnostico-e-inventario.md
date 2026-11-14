# 01 — Diagnóstico e inventário (14/11/2026)

Versão 1.0 — 14/11/2026 / Mudança: primeira versão (Etapa 0 do prompt mestre). Tudo aqui foi **lido** da produção (estrutura, contagens, tempos, definições de função). Nenhuma linha de paciente foi lida e **nada foi alterado na produção**.

## 1. Riscos ativos encontrados (contenção recomendada)

| # | Risco | Evidência | Contenção (30 s) | Reversão |
|---|---|---|---|---|
| R1 | `klingo-agendamento` (v2) **está no ar, pública (`verify_jwt=false`) e faz escrita real no Klingo** (marcar, remarcar, cancelar, check-in, pré-cadastro, trocar procedimento) com CPF + nascimento como única prova. **Não lê nenhuma chave** `klingo_api_*` nem `klingo_auto`, então os modos `teste` não a seguram. A página que a usava foi removida do repositório em 14/11/2026. | Código publicado lido pelo conector (`index.ts`, `regras.ts`, `api.ts`). | Apagar em https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions/klingo-agendamento | Código no git: commits `8890756`, `d389d3c`. |
| R2 | `klingo_auto = sim` **promove** `teste` e `sombra` para **todos** os pacientes. | `klingo_ativo` publicada: `if v_m = 'sim' then return v_modo <> 'nao'`. A `chat-agenda-api` publicada: `modo = chave === "nao" ? "nao" : "sim"` (sombra vira sim). Efeito medido: 0 operações de marcação criadas até hoje (nenhum paciente chegou ao passo com oferta válida), mas qualquer um que chegasse seria marcado de verdade. | `update public.config set valor='teste' where chave='klingo_auto';` | Voltar para `sim`. |
| R3 | `klingo_autogestao` (publicada) **promove sozinha** `sombra→sim` (horários), `teste→sim` a 10% (marcar) e `pos→sim` quando o mestre está em `legado`. Contraria "não promover recurso de teste sem autorização". | Definição publicada lida. Hoje o mestre `sim` só faz o recuo; o risco é latente. | Já coberta pela migração (parte 1). Até lá, deixar `klingo_auto` ≠ `legado`. | — |
| R4 | `klingo_so_liberados = sim` + `klingo_ativo` em `sombra` **escondia serviços** (`klingo_liberado`). | Função publicada lida. | Coberta pela migração (parte 1). | — |

## 2. Funções temporárias / expostas (item 4.5)

| Função | `verify_jwt` | Autenticação própria | O que devolve / faz | Uso real | Decisão |
|---|---|---|---|---|---|
| `klingo-agendamento` | **false** | **Nenhuma** além de CPF + nascimento | Escrita real no Klingo (ver R1) | Nenhum (página removida) | **Apagar já** (R1). |
| `klingo-inspecionar-chat` | false | `x-sync-key` = `config.ia_segredo` (comparação simples) | Só estrutura e contagem de relatórios (lista fixa de 8 relatórios) | Diagnóstico manual | Autenticação comprovada. Pode ser apagada (pendência antiga). |
| `klingo-comparar-chat` | false | `x-sync-key` = `config.ia_segredo` (comparação simples) | Lê o relatório #14554 **na memória** e devolve só contagens e ids de marcação | Auditoria de 13/11 | Autenticação comprovada. **Apagar** (finalidade cumprida). |
| `klingo-comparar-14554` | true | JWT do Supabase | (função de comparação; não relida em detalhe) | Auditoria de 13/11 | **Apagar** (já está nas pendências do dono). |
| `klingo-teste-api` | true | JWT; já responde 410 | Nada (desativada) | Nenhum | **Apagar**. |

Observação de higiene: as funções com `x-sync-key` comparam o segredo com `!==` (não é tempo constante). O risco é baixo (segredo longo, só estrutura), mas as funções de produção (`klingo-webhook`) já usam comparação de tempo constante. Registrado como melhoria.

Funções com autenticação própria que continuam necessárias (por desenho): `chat-agenda-api`, `chat-agenda-ao-vivo` (token da conversa); `klingo-executar`, `klingo-identificar`, `klingo-sincronizar`, `klingo-saude`, `disponibilidade-vigia` (segredo do cofre pelo banco); `klingo-webhook` (X-APP-TOKEN em tempo constante + chave `klingo_webhook`).

## 3. Repositório × produção (item 4.6)

Comparação por hash do corpo normalizado de cada função (`docs/reestruturacao-2026-11-14/diff-funcoes.json`):

* Produção: **508** funções · repositório (retrato de 11–13/11): **487** arquivos.
* **20** só existem na produção: `catalogo_config_aplicar`, `chat_saude`, `convenio_seguir_klingo`, `fluxo_email_ok`, `fluxo_nome_ok`, `fluxo_ordenar`, `fluxo_telefone_ok`, `klingo_catalogo_cru_disparar`, `klingo_catalogo_cru_gravar`, `klingo_catalogo_normalizar`, `klingo_exames_sondar`, `klingo_horarios_motivo`, `klingo_liberado`, **`klingo_mestre`**, `klingo_motivo_texto`, `klingo_nao_sou_eu`, `klingo_saude_disparar`, `klingo_saude_gravar`, `klingo_sondagem_gravar`, `klingo_sondar_disparar`.
* **0** só no repositório.
* **37** diferentes (entre elas as que importam aqui): `klingo_ativo`, `klingo_autogestao`, `klingo_pode_marcar`, `klingo_operacao_criar/concluir/vigiar`, `klingo_pre_gravar/reservar`, `previsao_*`, `pedido_horario_vigiar`, `fluxo_aplicar/avancar/perguntar/proximo/finalizar/pos_responder`, `chat_iniciar`, `chat_voltar`, `chat_consultas`, `chat_exames*`, `painel_automacao_resumo`, `painel_previsao_lista`.
* Consequência: o retrato antigo escondia (a) 4 tabelas que a produção já usava (`klingo_saude`, `klingo_horarios_falha`, `fluxo_opcao_ordem`, `klingo_catalogo_cru`) e (b) uma mudança de fluxo real: **a produção hoje pergunta CPF + nascimento antes do motivo** (`cpf_nasc > motivo > …`); o teste ponta a ponta ainda esperava a ordem antiga.
* **Ação:** retrato **refeito por inteiro** (508 funções, 123 tabelas, 5 visões, 33 rotinas) com o procedimento do `supabase/producao/LEIAME.md`; testes ajustados à produção real. O teste legado `sql-klingo-auto.test.mjs` (reaplicava as 15 partes de 12/11 sobre o retrato) ficou fora da corrente: 21 de 73 verificações dependem do fluxo antigo e a produção já contém essas partes.
* Edge Functions: repositório 21 pastas; publicadas 22. **Só na produção (4):** `klingo-agendamento` (removida do repositório de propósito), `klingo-teste-api`, `klingo-comparar-chat`, `klingo-comparar-14554` (temporárias). **Só no repositório:** `ler-pedido`, `fila-emitir-link`, `fila-validar-assinatura` (não publicadas, por desenho) e, agora, `disponibilidade-vigia`. A comparação **linha a linha** das demais continua sendo a pendência 6 da lista "próxima rodada técnica": só `chat-agenda-api` foi comparada (a linha crítica do modo estava igual no repositório e na produção).

## 4. Chaves de configuração (item 4.2)

Valores de 14/11/2026: `klingo_auto=sim`, `klingo_api_horarios=sombra`, `klingo_api_marcar/pos/pre_cadastro=teste`, `klingo_so_liberados=sim`, `pedido_horario_modo=teste`, `klingo_webhook=nao`, `klingo_autogestao=sim`, telefones de teste: 1 número.

Diagnóstico: o "mestre" era lido de três jeitos diferentes (SQL `klingo_ativo`, Edge `chat-agenda-api`, autogestão) e os três **subiam** o modo. A correção está na migração `webchat-v2-parte1-modos.sql` (precedência definida em `03-matriz-de-configuracao.md`).

## 5. `klingo_oferta` vazia (item 4.3)

Observado: 6 consultas à API "OK" (média ≈ 1 s), 0 linhas em `klingo_oferta`.

Percurso investigado (código publicado da `chat-agenda-api` v8 + tabelas):

| Etapa | Achado |
|---|---|
| Requisição / HTTP | Normal (tempo ≈ 1 s). |
| **"OK" medido cedo demais** | `medir("horarios_api_ok")` rodava **antes** de olhar o tamanho da lista. HTTP 200 com lista vazia contava como OK. É a explicação direta de "6 OK, 0 ofertas". |
| Estrutura | `normalizarHorarios` devolvia `[]` tanto para "sem horário" quanto para "estrutura inesperada": indistinguíveis. |
| Filtros | `montarOfertas` descartava em silêncio (id/data/hora inválidos, duplicata); nada registrava quantos. |
| Persistência | `klingo_oferta_gravar` apagava as ofertas da conversa e inseria; com lista vazia, ficava vazia. Erro de gravação virava `throw` genérico. |
| Expiração | `expira_em = now() + 30 min`; `klingo_limpar` (04:27) apaga tudo vencido há > 1 dia. Consultas de hoje podem ter sido limpas antes da observação. |
| Contexto/chave | O calendário lia `klingo_horarios_api_ativa` (que, com o bug R2, ficava ativa também em `sombra`). |
| **Causa mais provável** | A API respondeu **sem horários** para os pedidos de teste (consistente com "A API possui somente 3 especialidades liberadas" e com 6 respostas rápidas), e a métrica chamava isso de "ok". **Não foi possível provar** com os dados disponíveis: o registro por etapa não existia. |

Correção: `klingo_consulta` (uma linha por consulta, sem dado pessoal) com **resultado por etapa** — `ok_com_horarios`, `api_sem_horarios`, `todos_filtrados`, `estrutura_invalida`, `erro_api`, `limite`, `erro_gravacao`, `sem_traducao_plano`, `fora_do_escopo`, `dados_incompletos`, `sem_pedido` — e contagens (recebidos, válidos, filtrados, gravados). A próxima consulta real já dirá exatamente qual caso ocorreu. Testes: `diagnostico.test.ts` (A1–A11) e `sql-webchat-v2-modos.test.mjs` (métricas).

## 6. Catálogo incompleto (item 4.4)

* A visibilidade dependia de `klingo_liberado` (`klingo_so_liberados` + chave de horários). Agora `klingo_liberado` devolve sempre `true`: **nenhum serviço some**.
* Três camadas separadas: **serviço da clínica** (catálogo existente) · **integrado ao Klingo** (`klingo_especialidade.liberada_api` e `klingo_proc_api`) · **automatizável** (`klingo_automatizavel(proc, tipo)`). O caminho do paciente decide por esta última: automatizável → horários reais; senão → "agendado pela equipe" (sem horário inventado).

## 7. Confiabilidade da integração (itens 9.1–9.4) — estado verificado

| Item | Estado | Evidência |
|---|---|---|
| Idempotência no banco | **Existe** | `klingo_operacao.chave_idem` com `UNIQUE (klingo_operacao_chave_idem_key)`; `klingo_operacao_criar` usa `on conflict (chave_idem) do nothing` e reaproveita a operação em andamento. Não alterado. |
| Operação incerta | **Existe** | `klingo_operacao_vigiar` (1 min): refaz chamada perdida, marca `incerto` o que passou de 3 min e transfere para a equipe com a nota "conferir ANTES de marcar de novo". Não alterado. A conciliação **ativa** (consultar `/vouchers` por `id_externo`) depende de resposta do Klingo (pendência externa). |
| Webhook | **Pronto e desligado** | `klingo-webhook`: `X-APP-TOKEN` em tempo constante, chave `klingo_webhook=nao`, idempotência por hash do evento, nunca registra o corpo. O Klingo não manda id, horário nem assinatura do evento: fora de ordem só é tratável por reconciliação periódica (rotinas de relatório continuam). **Não foi ativado.** |
| Autogestão | **Corrigida** | só recua e recomenda (parte 1). |
| Trilha de configuração | **Nova** | `config_auditoria` (chave, antes, depois, origem, justificativa, versão). |
