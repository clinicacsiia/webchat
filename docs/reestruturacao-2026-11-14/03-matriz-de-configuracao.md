# 03 — Matriz de configuração (chaves, modos, precedência)

Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Implementado em `supabase/webchat-v2-parte1-modos.sql` (funções `klingo_modo`, `klingo_ativo`, `klingo_sombra`).

## Precedência (da mais forte para a mais fraca)

1. `klingo_auto = nao` → **tudo desligado**, inclusive sombra e a lista de teste.
2. Chave da capacidade em `nao` → desligada.
3. Chave em **`sombra`** → só **lê e mede** (capacidades de leitura). Não depende da lista de teste nem do percentual, **nunca** aparece ao paciente e **nunca** escreve. Em capacidade de escrita (marcar, cancelar, remarcar, pré-cadastro, pós, notificação, solicitação futura) `sombra` vale `nao`.
4. Telefone da lista `klingo_api_telefones_teste` → usa a capacidade (modo efetivo `teste`; `sim` se a chave e o mestre permitirem).
5. `klingo_auto = teste` é **teto**: todo o resto fica `nao`. Chave em `teste` também: só a lista.
6. Chave em `sim` com mestre `sim`/`legado` → `klingo_api_percentual` % das conversas.
7. **O mestre nunca sobe uma chave** (`sim` no mestre não transforma `teste`/`sombra` em `sim`). Valor desconhecido = `nao`. Conversa inexistente = `nao`.

## Chaves

| Chave | Valores | Padrão novo | Valor em 14/11/2026 | Efeito |
|---|---|---|---|---|
| `klingo_auto` | `nao` · `teste` · `sim` · `legado` | — | `sim` | Teto geral (ver precedência). `legado` = igual a `sim` (não promove). |
| `klingo_api_horarios` | `nao` · `sombra` · `teste` · `sim` | `nao` | `sombra` | Consulta de disponibilidade. Em `sombra` mede e não expõe. |
| `klingo_api_marcar` | `nao` · `teste` · `sim` | `nao` | `teste` | Marcação. |
| `klingo_api_pre_cadastro` | `nao` · `teste` · `sim` | `nao` | `teste` | Pré-cadastro de paciente novo. |
| `klingo_api_cancelar` | `nao` · `teste` · `sim` | **novo**, copia `klingo_api_pos` | `teste` | Cancelamento. |
| `klingo_api_remarcar` | `nao` · `teste` · `sim` | **novo**, copia `klingo_api_pos` | `teste` | Remarcação. |
| `klingo_api_pos` | `nao` · `teste` · `sim` | (legado) | `teste` | Mantida só como herança enquanto as duas acima não existirem. |
| `klingo_api_resultado` | `nao` · `sombra` · `teste` · `sim` | **novo**, `nao` | — | Resultado de exame (**sem integração**: não faz nada hoje). |
| `previsao_modo` | `nao` · `teste` · `sim` | **novo**, `teste` | — | Registrar solicitação de disponibilidade. |
| `previsao_monitor_modo` | `nao` · `sombra` · `teste` · `sim` | **novo**, `nao` | — | Motor que procura vagas na API (consome cota). |
| `notificacao_modo` | `nao` · `teste` · `sim` | **novo**, `nao` | — | Entrega do aviso de vaga no chat. |
| `klingo_webhook` | `nao` · `sim` | `nao` | `nao` | Aplicar avisos do Klingo (URL e autenticação ainda não cadastradas no Klingo). |
| `klingo_api_telefones_teste` | números | — | 1 número | Lista de teste. |
| `klingo_api_percentual` | 0–100 | `100` | `100` | Só em `sim`. |
| `klingo_autogestao` | `sim`/`nao` | `sim` | `sim` | **Só recua e recomenda.** |
| `klingo_so_liberados` | — | **desativada** (`nao`) | `sim` → `nao` pela migração | Sem efeito: nenhum serviço some. |
| `pedido_horario_modo` | `desligado` · `teste` · `ligado` | — | `teste` | A oferta automática da grade foi desativada; só alerta a equipe. |
| `disponibilidade_max_avisos_dia` / `_total` | número | `2` / `6` | — | Limites por solicitação. |
| `disponibilidade_encerra_conversa` | `sim`/`nao` | `nao` | — | Política de encerramento (decisão operacional pendente). |

## O que acontece na produção ao aplicar a migração (sem mexer em nada à mão)

| Antes | Depois |
|---|---|
| Marcar, pós e pré-cadastro: **todos os pacientes** (mestre `sim` + chave `teste`) | Só o telefone de teste |
| Horários `sombra`: gravava ofertas e **filtrava o calendário de todos** | Só mede; calendário não usa |
| Serviços ocultos por `klingo_so_liberados` | Todos visíveis |
| Autogestão podia subir modos (mestre `legado`) | Só recua e recomenda |
| Mudanças de configuração sem trilha | `config_auditoria` |

## Promoção de teste para público (item 9.4)

Só por `klingo_promover(chave, valor, justificativa)`: administrador logado, justificativa ≥ 10 letras, grava `config_auditoria` (origem `promocao:<uid>`) e `klingo_decisao`. `klingo_decidir` (usada pela autogestão) **recusa** subir um modo. A recomendação da autogestão fica em `klingo_decisao` (`recomendacao:<chave>`) e avisa a gestão, no máximo 1 por chave a cada 7 dias. **Não existe tela** para chamar `klingo_promover` ainda: hoje o administrador chama pelo SQL (pendência listada).
