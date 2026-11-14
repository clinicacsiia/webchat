# Reestruturação do WebChat e integração Klingo — leia primeiro

Versão 2.0 — 14/11/2026 / Mudança: continuação depois das decisões do dono (função `klingo-agendamento` mantida e protegida; agendamento automático para todos; telefone do GitHub tratado; pós-agendamento, resultado de exame e próximo horário do médico implementados; testes completos). Branch `ccr-462c5406-8n7vre`. **Nada foi aplicado na produção, nada foi mesclado, nenhuma função foi publicada, nenhuma operação real foi feita no Klingo.**

## Em uma frase

O chat passou a mostrar **somente horários que a API do Klingo devolveu** (calendário, lista de médicos, aceite de oferta antiga); quem não achou horário **registra disponibilidade futura** (não é agendamento); o paciente pode **ver, cancelar e remarcar** as marcações dele pelo chat (cancelamento só "confirmado" depois do OK do Klingo, remarcação confere se sobrou o horário antigo); o público inteiro é atendido por **chaves separadas** (arquivo pronto, não aplicado); a função pública `klingo-agendamento` foi **mantida e protegida no servidor**; e tudo está testado — **sempre com o Klingo simulado**. **Falta a sua autorização para publicar e a validação com o Klingo real.**

## O que eu preciso de você (só você pode)

1. **Autorizar a publicação** na ordem de [`06-plano-de-publicacao.md`](06-plano-de-publicacao.md) (há uma janela em que o público fica sem marcação automática; o plano a concentra num passo só).
2. **Validar com o Klingo real** (um paciente de teste e uma agenda que a equipe aceite cancelar): marcar, ver, cancelar, remarcar. Nenhum teste fez isso.
3. **Decidir** sobre o telefone na `main` ([`08`](08-limpeza-do-telefone-no-github.md)) e sobre o **segundo fator** da `klingo-agendamento` ([`07`](07-auditoria-klingo-agendamento.md) §5).
4. Pendências do suporte do Klingo: [`05-pendencias.md`](05-pendencias.md) seção A.

## Seus critérios (seção 12 do pedido) — situação

| Critério | Situação |
|---|---|
| `klingo-agendamento` preservada e segurança verificada | ✅ Preservada (não apaguei, não desativei, **não publiquei nada nela**). Auditada, com chamada direta testada; trava no servidor pronta (v1.1). **Segundo fator não feito (decisão sua).** `07` |
| Agendamento existente continua autorizado para todos | ✅ A configuração produtiva **não foi tocada** (`klingo_auto` continua `sim`). |
| Nova configuração preparada para o público | ✅ `supabase/webchat-v2-config-publica.sql` (**não aplicado**) + teste com paciente fora de qualquer lista (10/10). |
| Telefone removido dos arquivos e histórico da branch tratado | ✅ na minha branch (0 ocorrências, push controlado). ⚠️ **O mesmo número já estava no histórico da `main` desde 10/11 e em branches antigas; o GitHub guarda commits antigos por SHA.** Não afirmo que sumiu da internet. `08` |
| Nenhum horário estimado aparece como disponível | ✅ Testado em calendário, escolha, previsão, lista de médicos, aceite de oferta antiga. A grade só serve de **catálogo** (quais exames e médicos existem). |
| Todos os horários reserváveis vêm da API | ✅ (mesmos testes). |
| Próximo horário por médico não usa a grade | ✅ `webchat-v2-parte4`; sem consulta real a lista volta vazia (nada escrito). A tela não lê mais ocupação nenhuma. |
| Agendado exige resposta válida do Klingo | ✅ (pipeline existente, testado: só `sucesso` com voucher agenda). |
| Operações duplicadas prevenidas | ✅ `UNIQUE chave_idem`, duplo clique, 2 chamadas simultâneas, **incerto bloqueia nova marcação do mesmo pedido**. |
| Operações incertas conciliadas | ⚠️ **Parcial:** o executor reconcilia pelo `id_externo` e cancelamento/remarcação conferem a lista; o que não dá para provar cai na equipe com "conferir ANTES de marcar de novo". Depende de E4 (Klingo). |
| Solicitação futura independente do agendamento | ✅ nunca cria operação nem agenda (24 + painel). |
| Consulta de agendamentos | ✅ implementada, **Klingo simulado** (E8: marcações do balcão não confirmadas). |
| Cancelamento | ✅ implementado e testado (24 h, confirmação, incerto, "cancelado" só com OK do Klingo). |
| Remarcação e cenários de falha | ✅ implementada e testada (antigo ativo, antigo já cancelado + incerto, horário ocupado, sem pedido original, desistência). **Remarcação atômica não comprovada com o Klingo (E3).** Marcação feita no balcão sem pedido nosso → equipe. |
| Resultado de exame até o limite da integração | ✅ experiência completa e configurável; com a chave ligada **só confere se o laudo está liberado** (nunca o conteúdo). **Laudo liberado nunca foi testado de verdade (E2); entrega de link/senha continua com a equipe.** |
| Painel coerente com o chat | ✅ chaves por capacidade, disponibilidade futura, números do pós-agendamento (5/5 no navegador). |
| Testes Python executados | ✅ 27 de 27 (`pytest` instalado **só no ambiente**; nenhum arquivo de dependência foi alterado). |
| Todos os testes aplicáveis passaram | ⚠️ **Quase:** **288 de 288** verificações das suítes desta reestruturação; da corrente `npm test`, **86 de 87 scripts** na corrida final. O que falhou foi `test:equipe-assume` (cenário "corrida", teste de navegador **intermitente**: 1 falha em 14 repetições isoladas, 0 em 12 na versão base); repetido, passa. Não alterei o teste. `04` |
| Dependências do suporte Klingo documentadas | ✅ `05` seção A (E1 a E9). |
| Plano de publicação e reversão validado | ⚠️ Plano e reversão escritos; a **reversão foi testada no banco clonado** (`rollback`, idempotência e preservação de dados). A publicação em si só se valida na produção. |
| Nenhuma alteração nova publicada na produção | ✅ Confirmado: nenhuma migração, função, configuração ou merge. A única chamada à produção foi `acao: "inexistente"` na `klingo-agendamento` (sem efeito) e leituras de estrutura. |

## Mapa do que foi feito (arquivos)

| Assunto | Arquivos |
|---|---|
| Segurança da `klingo-agendamento` | `supabase/functions/klingo-agendamento/` (restaurada da produção + v1.1), `supabase/klingo-agendamento-seguranca.sql`, `07` |
| Modos por capacidade, auditoria | `supabase/webchat-v2-parte1-modos.sql`, `03` |
| Calendário só com a API | `webchat-v2-parte2-calendario-api.sql`, `chat-agenda-api`, `index.html` |
| Próximo horário do médico, oferta antiga | `webchat-v2-parte4-medicos-api.sql` (a tela não chama mais `chat-agenda-ao-vivo`) |
| Disponibilidade futura | `webchat-v2-parte3-disponibilidade-futura.sql`, `disponibilidade-vigia`, painel |
| Pós-agendamento, resultado, "não fica preso" | `webchat-v2-parte5-pos-agendamento.sql`, `klingo-executar` v1.1 (`ler_vouchers`, conferência do antigo), `klingo-api.ts` (5 cópias iguais) |
| Configuração pública (não aplicada) | `webchat-v2-config-publica.sql` |
| Telas | `index.html` (`VERSAO_APP 2026.11.14-2`, `sw v40`), `painel/index.html` (`sw v25`) |
| Testes | `testes/` (ver `04` e `testes/README.md`) |

## Onde ler o resto

`01-diagnostico-e-inventario.md` · `02-arquitetura-e-estados.md` · `03-matriz-de-configuracao.md` · `04-matriz-de-testes.md` · `05-pendencias.md` · `06-plano-de-publicacao.md` · `07-auditoria-klingo-agendamento.md` · `08-limpeza-do-telefone-no-github.md` · `diff-funcoes.json` · `regressao.json`.
