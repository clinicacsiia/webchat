# 05 — Pendências (o que NÃO está pronto) e dependências do suporte do Klingo

Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Nada aqui está marcado como concluído sem implementação e teste.

## A. Pendências externas (dependem de resposta ou liberação do suporte do Klingo)

Para cada uma: o que já foi investigado e o que falta confirmar. Texto-base do e-mail: `docs/klingo-api-externa/roteiro-reuniao-suporte.md`.

| # | Funcionalidade | Já investigado | Falta confirmar |
|---|---|---|---|
| E1 | **Webhook** | `klingo-webhook` pronta e desligada (token em tempo constante, idempotência por hash, chave `klingo_webhook`). | O Klingo cadastrar `https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/klingo-webhook` com o `X-APP-TOKEN`; se o evento traz **id, hora ou assinatura** (hoje não traz: fora de ordem só se resolve por reconciliação). |
| E2 | **Resultado de exame** | O código da função removida `klingo-agendamento` chamava `GET /resultado/{id}` e `GET /resultado/pdf/{id}` (sem sessão do paciente, 403 em HTML quando não há laudo). **Isso não foi validado nesta rodada**; o relatório C só diz "laudo pronto" e não tem link nem senha. | Se esses endpoints são oficiais e liberados; que identificador usam (voucher?); se exigem senha; como validar o responsável de menor. Sem isso `klingo_api_resultado` fica `nao` e **nenhuma consulta é simulada**. |
| E3 | **Remarcação atômica** | O `POST /agenda/horario` aceita `remarcacao` (voucher antigo) e o Klingo "cancela sozinho" (pipeline atual). Não foi provado, em ambiente real, o que acontece se a nova marcação falhar depois do aceite, nem se existe janela com duas marcações. | Confirmar atomicidade e o erro em caso de conflito; sem isso vale a estratégia compensatória (ver B3). |
| E4 | **Conciliação ativa de operação incerta** | Hoje a incerta vai para a equipe com a nota "conferir antes de marcar de novo". | Se `GET /vouchers` devolve o `id_externo` enviado na marcação (permitiria conferir sozinho). |
| E5 | **Limite de chamadas** | Cota global do banco (10 fichas, 1/s) e tratamento de 429. | O limite real por minuto, para dimensionar o motor de vagas. |
| E6 | **Catálogo da API** | Só 3 especialidades liberadas (neurologia, pediatria, radiologia). | Liberar as demais (ortopedia, endocrinologia…) e o plano da ASSEFAZ; uma agenda de teste. |
| E7 | **Preço Particular, convênio inativado, hora real do atendimento** | Já listadas em `docs/pendencias-do-dono.md` 2.3. | Respostas do suporte. |

Relatórios do Klingo a criar/editar para esta tarefa: **nenhum** (regra do `CLAUDE.md`).

## B. Pendências do projeto

### Bloqueantes (impedem ligar para o público)

| # | Item | Por quê |
|---|---|---|
| B0 | **Apagar `klingo-agendamento`** | Risco ativo R1 (escrita real, pública, fora das chaves). Ação do dono: 1 clique. |
| B1 | **Aprovar e aplicar as 3 migrações** (`webchat-v2-parte1/2/3`) em partes, no Supabase, depois publicar a tela e a Edge Function `chat-agenda-api` v2 e `disponibilidade-vigia` | Nada disso está na produção. Ver `06-plano-de-publicacao.md`. |
| B2 | **Piloto**: ≥ 20 marcações de teste com paciente autorizado e agenda de teste, e conferência delas no Klingo | O motor de marcação nunca criou uma operação real (0 em `klingo_operacao`). Os testes desta rodada usam o Klingo simulado. **Nenhuma marcação real foi feita.** |
| B3 | **Remarcação: unificar** o caminho "preserva o horário anterior" com o "equipe cancela depois" e tratar o risco de dois agendamentos | [NÃO feito]. Depende de E3 para a versão atômica. Enquanto isso o pipeline atual (voucher antigo no corpo da marcação) é o único caminho automático. |
| B4 | **Token da conversa guardado no aparelho como única prova** para operações sensíveis | [NÃO feito]. Hoje marcar/cancelar exigem CPF + nascimento conferidos, e a marcação só nasce de oferta válida, mas ver agendamento, cancelar e (no futuro) resultado deveriam exigir segundo fator (SMS/e-mail), já previsto em `planejamento-autoatendimento-klingo.md`. |

### Importantes

| # | Item |
|---|---|
| I1 | Tela para o administrador chamar `klingo_promover` (hoje só SQL) e ver `config_auditoria` e as recomendações. |
| I2 | Estados separados de forma explícita (conversa / pedido / operação): "dependente de equipe" e "conciliada" ainda são combinações de campos. |
| I3 | Ver minha marcação consultando o Klingo antes de mostrar (hoje usa o que o chat guardou). |
| I4 | Cancelamento e consulta com a regra de 24 h revalidadas com fuso (`America/Bahia`): a regra existe e é testada no legado; não foi reauditada aqui. |
| I5 | Política de encerramento por solicitação futura: decidir `disponibilidade_encerra_conversa` (hoje `nao`) e a inatividade de 24 h (hoje "Chamar no WhatsApp"). |
| I6 | Mais de um exame ou conjunto de procedimentos na solicitação futura (o modelo suporta; a busca automática ainda não): hoje segue para a equipe com a mensagem clara. |
| I7 | Notificação por WhatsApp/SMS/e-mail (canais autorizados): só o chat existe. Exige integração validada e base legal revisada (item 2.5 das pendências do dono). |
| I8 | Rate limit por IP nas funções públicas (`chat-agenda-api` já é limitada por token e cota global; não há limite por IP). |
| I9 | Comparação linha a linha das demais Edge Functions publicadas × repositório (só `chat-agenda-api` foi comparada). |
| I10 | `privacidade.html`: citar solicitação de disponibilidade, finalidade, base legal, retenção (`config_auditoria` 1 ano; `klingo_consulta` 30 dias; solicitações encerradas: definir prazo) e opt-out. Revisão jurídica. |
| I11 | Comparação de segredo em tempo constante nas funções com `x-sync-key`. |

### Melhorias futuras

* Painel de saúde do motor de vagas (taxa de oportunidade → aceite → conversão).
* Unificar a lista da atendente com um indicador "tem solicitação futura ativa" no cartão do pedido (hoje o pedido continua indo à equipe como "sem horário" com a nota "nada a fazer agora").
* Regressão visual automatizada além dos testes de navegador atuais.
* Acessibilidade do novo formulário (foco preso na folha, anúncio de erro) revisada com leitor de tela.

## C. Limitações conhecidas desta entrega (para não haver surpresa)

1. O teste legado `sql-klingo-auto.test.mjs` foi retirado da corrente (21 de 73 verificações assumem o fluxo de 12/11). O comportamento que ele cobria (marcação, cancelar, remarcar, incerto, divergência, voltar) **está na produção e não foi alterado**, mas ficou sem teste automatizado equivalente sobre o retrato novo. Reescrevê-lo contra o fluxo atual é item **importante**.
2. `previsao_ativa` agora devolve sempre `false`: o assistente antigo da "lista de espera" (turno/período/antecedência) **deixa de existir**. A tabela `pedido_previsao` e suas funções (`previsao_iniciar`, `previsao_responder`, `previsao_pergunta`) ficam no banco, sem uso, por compatibilidade (0 linhas hoje).
3. `chat-agenda-ao-vivo` (leitura da ocupação por relatório) continua publicada e usada na lista de médicos ("próximo horário de cada médico"), que **ainda vem da grade/ocupação**. É informação de apoio, não oferta, mas viola o espírito do item 5.3 se for lida como vaga: **[pendência I12]** trocá-la por ofertas da API ou rotular como "estimativa".
4. Janela de datas: a API devolve ≤ 15 dias por consulta; a tela soma até 3 janelas (≈ 45 dias) sob demanda.
5. Gêmeos com o mesmo responsável, mesma data de nascimento e mesmo nome se confundem na chave da solicitação (limitação do desenho sem guardar dado pessoal).
6. **Ofertas antigas já criadas em `horario_oferta`** (assistente que oferecia o "horário mais próximo" da grade, só no modo `teste`): se um paciente tinha uma pendente e aceita, `fluxo_aplicar` ainda confere a grade e grava a escolha **sem `klingo_chave`**. Resultado seguro: `klingo_pode_marcar` recusa (`sem_oferta_da_api`/`horario_nao_unico`) e o pedido vai à equipe; nenhuma oferta nova é criada (a origem foi desligada). Revisar `fluxo_aplicar` para validar na API é item **importante** (I13).
