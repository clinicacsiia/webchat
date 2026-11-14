# Reestruturação do WebChat e integração Klingo — leia primeiro

Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Branch `ccr-462c5406-8n7vre`. **Nada foi aplicado na produção, nada foi mesclado, nenhuma operação real foi feita no Klingo.**

## Em uma frase

O calendário do chat passou a mostrar **somente horários que a API do Klingo devolveu**; quando não há, o paciente **registra a disponibilidade futura** (que não é agendamento) ou fala com a equipe; as chaves de teste deixaram de valer para todos; e tudo isso está testado no banco clonado e no navegador, **mas ainda depende da sua autorização para entrar na produção**.

## ATENÇÃO — efeito para o público durante a transição (decisão sua)

Com as chaves de hoje (`klingo_api_horarios = sombra`) e a grade **proibida como vaga**, depois de aplicar as migrações **nenhum paciente comum recebe horário da API**: o calendário mostra "Este atendimento é agendado pela nossa equipe" e o botão "Enviar meu pedido para a equipe" (o pedido chega **sem dia/hora escolhidos**, como hoje chega o "Nenhum horário serve"). Só o telefone de teste vê horários reais.

Para o público voltar a escolher horário, é preciso promover `klingo_api_horarios` para `sim` (com `klingo_api_percentual`), **depois do piloto**, por `klingo_promover`. Alternativas para a transição:

1. **(Recomendada)** Publicar tudo, rodar o piloto só com o telefone de teste e promover `horarios` por etapas (10 % → 50 % → 100 %). Enquanto isso, quem não está no percentual vai para "pedido para a equipe", sem horário.
2. Só publicar a migração depois do piloto (o chat público segue como hoje até lá, **com o risco R2 contido** pela chave `klingo_auto = teste`).
3. Manter, só durante a transição, um calendário da grade rotulado "preferência de horário para a equipe, não é vaga". **Não foi implementado**: contraria o pedido de 4.1 e exigiria o terceiro estado visual "pedido para equipe" com outro nome e cor.

## 1. Faça agora (risco ativo, 30 segundos)

Apagar `klingo-agendamento` (função pública que escreve no Klingo, fora das chaves): https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions/klingo-agendamento — detalhes em `01-diagnostico-e-inventario.md`, seção 1 (R1 a R4).

## 2. O que mudou (inventário de alterações — entregável 1)

| Onde | Problema anterior | Correção | Por quê |
|---|---|---|---|
| `supabase/producao/` (retrato) | 57 funções diferentes da produção, 4 tabelas ausentes, fluxo antigo nos testes | Refeito por inteiro (508 funções, 123 tabelas) | A verdade do banco é a produção (`CLAUDE.md`) |
| `webchat-v2-parte1-modos.sql` · `klingo_ativo`, `klingo_modo`, `klingo_sombra` | `klingo_auto = sim` promovia teste/sombra a todos | Modo efetivo por capacidade; mestre só limita; sombra só lê | Item 4.2 |
| idem · `klingo_autogestao`, `klingo_decidir`, `klingo_promover`, `klingo_recomendar` | Autogestão avançava chaves sozinha | Só recua e recomenda; promover exige administrador + justificativa | Item 9.4 |
| idem · `config_auditoria` (+ gatilho em `config`) | Sem trilha de mudança | Chave, antes, depois, origem, justificativa, versão | Item 9.4 |
| idem · `klingo_liberado`, `klingo_automatizavel` | Serviços sumiam do chat | Nenhum serviço some; eligibilidade separada | Item 4.4 |
| idem · `klingo_consulta`, `klingo_oferta.sombra`, `klingo_oferta_gravar_v2`, `klingo_consulta_registrar` | HTTP 200 contava como "ok"; não havia registro por etapa | Resultado e contagens de cada consulta (sem dado pessoal); sombra marcada | Item 4.3 |
| `webchat-v2-parte2-calendario-api.sql` · `chat_horarios`, `chat_horario_escolher` | Calendário partia da **grade**; a API só filtrava | Só ofertas da API, com `estado`; escolha só de oferta válida | Itens 4.1, 5.3 |
| idem · `previsao_buscar`, `pedido_horario_vigiar` | Ofereciam horário **da grade** como vaga | Só ofertas da API / alerta à equipe | Critério 1 |
| `webchat-v2-parte3-disponibilidade-futura.sql` · `disponibilidade_*`, `chat_disponibilidade_*`, `painel_disponibilidade_*`, `previsao_vigiar`, `previsao_ativa` | "Previsão" era calendário estimado e lista da grade | Solicitação de preferências + motor + notificação autorizada + conversão | Item 6 |
| `supabase/functions/chat-agenda-api` | "sombra" virava "sim"; "ok" medido cedo | Modo do banco; diagnóstico por etapa; janelas de 15 dias; `fresco` | Itens 4.2, 4.3 |
| `supabase/functions/disponibilidade-vigia` (nova) | — | Motor que consulta a API para as solicitações ativas | Item 6.4 |
| `klingo-api.ts` (5 cópias iguais) | Sem resposta crua | `horariosBruto()` | Diagnóstico |
| `index.html` · `sw.js` v39 | Calendário "previsão", "Conferir de novo" da grade | 4 estados, 3 saídas, formulário, "Minha disponibilidade", aviso de vaga | Itens 5.4, 5.5, 6 |
| `painel/index.html` · `painel/sw.js` v24 | "Lista de previsão" (grade) | "Disponibilidade futura" com filtros | Item 6.6 |
| `testes/` | Testes assumiam fluxo e retrato antigos | Ajustados; 7 arquivos novos; legado aposentado com registro | Item 14 |

## 3. Critérios de aceite (item 15) — situação

| # | Critério | Situação |
|---|---|---|
| 1 | Nenhum horário da grade aparece como vaga | **Atendido no código novo** (teste: grade de 160 horários, calendário mostra 0). Resta `medicos_disponiveis_interno` (próximo horário por médico, ainda da grade): pendência I12. |
| 2 | Calendário só com ofertas válidas da API | Atendido (teste: exatamente as ofertas). |
| 3 | Ausência de oferta ≠ falsa disponibilidade | Atendido (estados `sem_horarios` / `indisponivel` / `nao_integrado`). |
| 4 | Solicitação futura não cria agendamento | Atendido (0 operações, pedido não vira `agendado`). |
| 5 | Motor identifica oportunidades compatíveis | Atendido em SQL com ofertas inventadas; a Edge Function **não** foi executada contra a API real. |
| 6 | Notificação não afirma agendamento | Atendido (texto testado). |
| 7 | Idempotência e concorrência da marcação | **Já existia** (`UNIQUE chave_idem`, `on conflict`); não alterada. **Agora com teste** (`sql-webchat-v2-agendamento`): duplo clique, 2 chamadas simultâneas, inserção direta duplicada recusada (23505). Klingo simulado. |
| 8 | Sem agendamento duplicado por repetição local | Idem (7), mais retentativa do job e reabertura: sempre a mesma operação. |
| 9 | Operações incertas reconciliadas | Parcial: `incerto` não vira agendado, chama a equipe com "conferir ANTES de marcar de novo" e **não cria 2ª operação** (testado); conciliação ativa depende do Klingo (E4). |
| 10 | Sem "agendado" sem confirmação válida | Existente; **testado**: só `sucesso` com voucher agenda; incerto, falha e horário tomado nunca agendam. |
| 11 | Serviços não somem | Atendido. |
| 12 | Estados independentes | **Parcial** (I2). |
| 13 | Remarcação respeita a segurança | **Não atendido nesta rodada** (B3, E3). |
| 14 | Cancelamento confirmado pelo Klingo | Existente (`klingo_operacao_concluir`); não alterado nem retestado. |
| 15 | Resultado de exame não simulado | Atendido por ausência: não foi implementado nem simulado (E2). |
| 16 | Flags de teste não liberam o público | Atendido (24 + 6 testes). |
| 17 | Autogestão não promove | Atendido (testes de recuo/recomendação/recusa). |
| 18 | Funções expostas com autenticação | **Parcial**: auditadas; apagar as temporárias depende do dono (B0). |
| 19 | Migrações preservam dados | Atendido (teste de rollback e preservação). |
| 20 | Fluxos não relacionados continuam | Regressão: **77 de 79 scripts passaram** na corrente; as 2 falhas eram `test:python` (falta `pytest` no ambiente) e `test:voltar-sql` (já corrigido, 9/9). Ver `04-matriz-de-testes.md`. |
| 21 | Testes obrigatórios com evidência | **Parcial**: A, B (sobre o pipeline existente, Klingo simulado), C e E cobertos; **D (pós-agendamento) não coberto**. Detalhe e lacunas em `04-matriz-de-testes.md`. |
| 22 | Documentação = comportamento | Atendido para o que foi implementado; limites em `05-pendencias.md`. |

## 4. Onde ler o resto

`01-diagnostico-e-inventario.md` · `02-arquitetura-e-estados.md` · `03-matriz-de-configuracao.md` · `04-matriz-de-testes.md` · `05-pendencias.md` · `06-plano-de-publicacao.md` · `diff-funcoes.json`.
