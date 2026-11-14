# 06 — Plano de publicação (nada disso foi executado)

Versão 1.0 — 14/11/2026 / Mudança: primeira versão. **Nenhum passo abaixo foi aplicado na produção.** Todos dependem de autorização explícita do dono. Não houve merge, deploy, mudança de configuração produtiva nem operação real no Klingo.

Projeto: `nrvuynjwcgwpjdptkiay` (https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay). Branch de trabalho: `ccr-462c5406-8n7vre`.

## ATENÇÃO — efeito para o público durante a transição (decisão sua)

Com as chaves de hoje (`klingo_api_horarios = sombra`) e a grade **proibida como vaga**, depois de aplicar as migrações **nenhum paciente comum recebe horário da API**: o calendário mostra "Este atendimento é agendado pela nossa equipe" e o botão "Enviar meu pedido para a equipe" (o pedido chega **sem dia/hora escolhidos**, como hoje chega o "Nenhum horário serve"). Só o telefone de teste vê horários reais.

Para o público voltar a escolher horário, é preciso promover `klingo_api_horarios` para `sim` (com `klingo_api_percentual`), **depois do piloto**, por `klingo_promover`. Alternativas para a transição:

1. **(Recomendada)** Publicar tudo, rodar o piloto só com o telefone de teste e promover `horarios` por etapas (10 % → 50 % → 100 %). Enquanto isso, quem não está no percentual vai para "pedido para a equipe", sem horário.
2. Só publicar a migração depois do piloto (o chat público segue como hoje até lá, **com o risco R2 contido** pela chave `klingo_auto = teste`).
3. Manter, só durante a transição, um calendário da grade rotulado "preferência de horário para a equipe, não é vaga". **Não foi implementado**: contraria o pedido de 4.1 e exigiria o terceiro estado visual "pedido para equipe" com outro nome e cor.

## 0. Antes de tudo (contenção, independente da migração)

1. **Apagar `klingo-agendamento`**: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions/klingo-agendamento (R1). Opcional: apagar também `klingo-comparar-chat`, `klingo-comparar-14554`, `klingo-teste-api`, `klingo-inspecionar-chat`.
2. Se a migração não for aplicada hoje: `update public.config set valor = 'teste' where chave = 'klingo_auto';` (R2). Reversão: `sim`.

## 1. Pré-requisitos

* Ler `01-diagnostico-e-inventario.md` e `03-matriz-de-configuracao.md`.
* Backup lógico das definições (o retrato em `supabase/producao/` já é o estado "antes": rollback = reaplicar as funções dali).
* Aviso ao call center de que haverá teste de marcação (piloto) e quem cancela.
* Paciente de teste autorizado e uma agenda de teste (pendência E6 do Klingo ajuda; sem ela, usar procedimento/agenda que a equipe aceite cancelar).

## 2. Ordem de publicação (cada passo é reversível e mede-se antes do seguinte)

| Passo | O quê | Como | Verificação | Reversão |
|---|---|---|---|---|
| 1 | **Parte 1** (modos, auditoria, autogestão, catálogo, `klingo_consulta`) | `supabase/webchat-v2-parte1-modos.sql` em partes pequenas (CLAUDE.md: `create or replace`; o bloco `do $m$` e as tabelas novas não pedem confirmação de `drop`) | `select * from klingo_modo(<conversa de teste>, 'klingo_api_marcar')`; `select count(*) from config_auditoria`; o painel mostra todos os serviços | reaplicar `funcoes/{klingo_ativo,klingo_liberado,klingo_decidir,klingo_autogestao,klingo_pode_marcar}.sql`; `klingo_so_liberados` volta a `sim` |
| 2 | **Edge `chat-agenda-api` v2** (+ cópias de `klingo-api.ts` em `klingo-executar`, `klingo-identificar`, `klingo-sincronizar`) | Deploy das 4 pastas | `select resultado, count(*) from klingo_consulta group by 1` depois de 1 conversa de teste; `klingo_oferta` com `sombra=false` só para a lista | redeploy da versão anterior (v8) |
| 3 | **Parte 2** (calendário só com ofertas da API) | `webchat-v2-parte2-calendario-api.sql` | conversa de teste: calendário = ofertas; conversa comum: "agendado pela equipe" | reaplicar `funcoes/{chat_horarios,chat_horario_escolher,previsao_buscar,pedido_horario_vigiar}.sql` |
| 4 | **Tela do chat e service worker** | merge em `main` (GitHub Pages) — só com autorização | abrir em celular e desktop; `VERSAO_APP 2026.11.14-1`, `sw v39` | reverter o commit; a versão antiga volta em ~1 min. **Atenção:** a tela nova chama `chat_disponibilidade_*`: aplicar a parte 3 **antes** do merge (passo 5) |
| 5 | **Parte 3** (solicitação futura) | `webchat-v2-parte3-disponibilidade-futura.sql` | `select count(*) from disponibilidade_pedido` = 0; registrar uma solicitação de teste | as tabelas podem ficar; reaplicar `funcoes/{previsao_ativa,previsao_vigiar}.sql` |
| 6 | **Edge `disponibilidade-vigia`** + painel (`painel/sw.js v24`) | deploy + merge | `previsao_monitor_modo='sombra'` por 24 h: `klingo_medida` `disponibilidade_sombra_compativeis`, sem oportunidades gravadas | `previsao_monitor_modo='nao'` |
| 7 | **Refazer o retrato** da produção (`supabase/producao/LEIAME.md`) e rodar `npm run test:retrato` | pedir ao Claude | a lista "aguardam a migração" some | — |

Ordem **real** de dependência: 1 → 2 → 3 → 5 → 4/6. (A tela nova do passo 4 exige as funções dos passos 3 e 5.)

## 3. Piloto controlado (mínimo, não garantia)

1. Telefone do paciente de teste em `klingo_api_telefones_teste`; `klingo_auto = teste`; `klingo_api_horarios = teste`; `klingo_api_marcar = teste`; `previsao_modo = teste`; `previsao_monitor_modo = sombra` → `teste`; `notificacao_modo = teste`.
2. Rodar os cenários: marcar com horário real; sem horário → registrar disponibilidade → (forçar) vaga compatível → aviso no chat → "Ver horários agora" → marcar; cancelar; cenário de operação incerta.
3. **≥ 20 marcações de teste** sem nenhuma incerta (é o mínimo do piloto, **não** prova de segurança). A autogestão só **recomenda**.
4. Só então o administrador decide, **uma chave por vez**, com `klingo_promover(chave, valor, justificativa)`, começando por `klingo_api_horarios = sim` e `klingo_api_percentual = 10`.

## 4. Métricas para acompanhar (`klingo_consulta`, `klingo_medida`, `klingo_operacao`)

| Métrica | Alerta |
|---|---|
| `consulta_api_sem_horarios` / consultas | muito alta = catálogo da API pequeno (E6), não falha |
| `consulta_estrutura_invalida`, `consulta_erro_api`, `consulta_limite` | > 5 % em 1 h |
| `consulta_erro_gravacao` | qualquer ocorrência |
| `op_incerta` | ≥ 2 em 24 h (a autogestão recua sozinha) |
| `monitor_*` e `disponibilidade_sombra_compativeis` | motor ativo e proporção de vagas compatíveis |
| Avisos entregues × aceitos × convertidos | taxa de conversão; reclamações de aviso repetido = 0 |
| Solicitações `ativa` envelhecendo sem verificação | `ultima_verificacao_em` > 1 h |

## 5. Critérios de interrupção (voltar sem pedir licença)

* Qualquer marcação duplicada ou sem protocolo → `klingo_auto = nao`.
* Operação `incerta` repetida, ou aviso de vaga enviado a quem não autorizou → `notificacao_modo = nao` e `previsao_monitor_modo = nao`.
* Taxa de erro da API > 50 % → a autogestão já recua `horarios` para sombra; confirmar.
* Reclamação de paciente de dado/CPF exposto → `klingo_auto = nao` e abrir incidente (LGPD).

## 6. Rollback geral

Cada migração é `create or replace` / tabela ou coluna **nova** (nada é apagado): reaplicar as funções do retrato **da produção antes da migração** (git: commit `843b521`, pasta `supabase/producao/funcoes/`), e as chaves em `03-matriz-de-configuracao.md`. As tabelas `config_auditoria`, `klingo_consulta`, `disponibilidade_*` e a coluna `klingo_oferta.sombra` podem ficar.
