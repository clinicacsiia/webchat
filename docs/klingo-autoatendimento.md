# Autoatendimento com a API do Klingo

Versão 1.0 — 12/11/2026 / Mudança: primeira implementação do planejamento `planejamento-autoatendimento-klingo.md` (etapas 0 a 5, com cancelar e remarcar; as etapas 6 e 7 ficam para quando houver um segundo fator de confirmação e decisão sobre a IA).

Este documento diz **o que foi feito, o que está ligado, o que está desligado e por quê**, e como o sistema se cuida sozinho. Para entender o desenho completo e os riscos, leia o planejamento. Para os testes reais da API, `klingo-api-externa/GUIA-COMPLETO.md`.

---

## 1. Em linguagem simples

- O chat agora **pede CPF e data de nascimento logo depois de escolher o exame ou a consulta** (antes do convênio). Sem os dois, o pedido não segue. Quem voltava ao chat sem CPF no cadastro também é perguntado de novo.
- Esses dados são conferidos **na API do Klingo** (`/paciente/cpf`): o sistema descobre se a pessoa já é paciente, se o nascimento bate e qual convênio ela tem cadastrado. Só ficam guardados um **código embaralhado do CPF** (hash), o número do cadastro no Klingo e o resultado. O CPF em claro continua só onde já estava (`pre_agendamentos.paciente`).
- **Todos os pacientes antigos** que já tinham deixado CPF e nascimento foram conferidos de uma vez (ver seção 5) e continuam sendo conferidos sozinhos se aparecer algum novo sem conferência.
- O chat sabe pedir à API os **horários livres de verdade** e, quando for liberado, **marcar sozinho**, mostrando o cartão do agendamento (com botão "Adicionar à minha agenda") e um pequeno menu depois. Se qualquer coisa não for segura, o pedido vai para a equipe **exatamente como antes**.
- O sistema **se cuida sozinho**: avança quando os números mostram que está bom e **recua e avisa a gestão** quando algo piora (seção 4). O ser humano só entra quando o sistema recua ou quando o caso é sensível (dinheiro, vários exames, convênio sem tradução, divergência de cadastro, resultado incerto).

## 2. O que está ligado hoje e o que não está

| Peça | Situação em 12/11/2026 | Por quê |
|---|---|---|
| CPF + nascimento obrigatórios no chat | **Ligado** | Pedido do dono. Valida os números do CPF e a data. |
| Conferência de CPF + nascimento pela API | **Ligada** (nos pacientes novos e nos antigos) | Só leitura. |
| Revisão dos pacientes antigos | **Feita** (109 pares) | Seção 5. |
| Tradução convênio → plano do Klingo | **Feita** (31 convênios traduzidos sozinhos; 5 "não atende pela API") | Sincroniza toda madrugada. |
| Horários reais da API (`klingo_api_horarios`) | **`sombra`**: a API roda em paralelo e só compara com a grade; a tela do paciente **não muda** | O plano manda medir antes. O sistema passa para `sim` sozinho quando os números permitirem. |
| Marcar sozinho (`klingo_api_marcar`) | **`teste`**: só vale para telefones da lista `klingo_api_telefones_teste` (hoje **vazia** = ninguém) | O plano exige 20 marcações reais de teste sem erro antes de abrir ao público. Ver seção 6. |
| Paciente novo marca sozinho (`klingo_api_pre_cadastro`) | `teste` (mesma regra) | Cria pré-cadastro no Klingo; só depois de provado o caso com cadastro. |
| Webhook do Klingo (`klingo_webhook`) | `nao`; a função está publicada e pronta | O Klingo precisa cadastrar a URL. Ver `pendencias-do-dono.md`. |
| Cancelar e remarcar pelo chat (`klingo_api_pos`) | **Feito, em modo `teste`** (liga junto com a marcação: a autogestão libera quando a marcação chega a 100% e estável). Só o que ESTE chat marcou; prazo mínimo de 24 h (`klingo_pos_prazo_horas`); cancelar pede confirmação ("Sim, cancelar") | Etapa 4 do plano. Com `nao`/`teste` o menu só tem "ver", "falar com a equipe" e "tudo certo". |
| Resultado de exame, atualizar contato, check-in, IA intérprete (etapas 6 e 7) | **Não feitos** | Etapas 6 e 7: precisam de um segundo fator (código por SMS/e-mail) que a clínica ainda não tem, e o plano manda deixar com a equipe até lá. |

## 3. Como funciona (fluxo)

```
Paciente escolhe exame/consulta
   └─> passo "cpf_nasc" (CPF + nascimento, obrigatórios)
        └─> gatilho do banco manda conferir na API (klingo-identificar) -> klingo_identidade (só hash) + nota para a equipe
   └─> plano (convênio) -> horário
        └─> o chat chama chat-agenda-api: GET /agenda/horarios com plano, sexo e nascimento
             sombra: mede (api × grade); sim: o calendário só mostra horários que a API também oferece
        └─> o horário escolhido guarda a "chave do Klingo" (klingo_oferta: o servidor lembra o que ofereceu)
   └─> dados e confirmação -> fluxo_finalizar
        ├─ klingo_pode_marcar = não  -> pedido para a equipe (como sempre), com a nota do motivo
        └─ klingo_pode_marcar = sim  -> klingo_operacao (chave única: duplo toque = 1 só) -> "Reservando seu horário…"
             └─ klingo-executar (recebe SÓ o id da operação)
                  identidade na API -> plano -> login com o id exato + sessão conferida -> o horário ainda existe? -> reservar -> marcar (id_externo = id da operação)
                  ├─ sucesso: pedido "agendado" (origem chat_api), cartão do voucher, menu
                  ├─ horário tomado: volta à escolha do horário com lista nova
                  ├─ incerto (tempo esgotado/erro 5xx): reconcilia por GET /vouchers; se não achar, equipe com a nota "conferir ANTES de marcar de novo"
                  └─ falha (convênio inativo, divergência...): equipe, com o motivo

Depois do cartão do agendamento: menu "Ver a minha marcação / Remarcar / Cancelar / Falar com a equipe / Está tudo certo".
   Cancelar: prazo (24 h) -> confirmação -> operação "cancelar" -> klingo-executar vê se o voucher está entre as marcações ATIVAS da sessão conferida e chama DELETE /voucher.
   Remarcar: prazo -> volta ao horário (o atual só é trocado quando o novo estiver confirmado) -> operação "remarcar" (a API cancela o antigo sozinha).
   Qualquer falha ou resposta incerta: equipe, SEM mexer no agendamento atual e com o número do voucher na nota.
```

Regras que valem sempre:
- `klingo-executar` **não recebe CPF, nascimento, horário nem plano de ninguém**: lê tudo do banco, onde já foi validado. Segredo próprio no cofre (`klingo_interno_segredo`), diferente do antigo `ia_segredo`.
- Identidade conferida **antes** (CPF + nascimento batem com o Klingo) e **depois** do login (id, nascimento e, no pré-cadastro, nome). Id definitivo é `P`+número; pré-cadastro é número puro (restrição no banco: misturar abre a sessão de outra pessoa).
- Nada vira "agendado" sem voucher devolvido pela API. Resposta perdida vira **incerto**, nunca "tenta de novo".
- Paciente novo: um pré-cadastro por CPF (trava no banco; a API aceitaria duplicar). Se a resposta do `register` se perder, **não registra de novo**: vai para a equipe.
- Só consultas (qualquer convênio traduzido) e exames **Particular** marcam sozinhos por enquanto (`klingo_api_exame_convenio` = `nao`): exame com convênio pode exigir autorização prévia, que a API não diz.
- Um pedido com 2 ou mais exames sempre vai para a equipe.

## 4. Autogestão (o sistema avança e recua sozinho)

Rotina `klingo-autogestao`, a cada 10 minutos (`klingo_autogestao()`), ligada por `config.klingo_autogestao = 'sim'`. Toda decisão fica em `klingo_decisao` e **avisa a gestão** (administradores, TI e gerência) pelo sino.

| Decisão | Condição |
|---|---|
| Horários `sombra` → `sim` | 30+ consultas com API boa nos últimos 7 dias, ≤ 5% de erro/limite, ≤ 5% mais lentas que 3 s, 200+ horários comparados e ≥ 85% dos horários da API aparecem também na grade |
| Horários `sim` → `sombra` | Hoje, 20+ erros e metade (ou mais) das consultas falharam (espera 30 min entre recuos) |
| Marcar `teste` → `sim` (10%) | 20+ marcações com sucesso em 30 dias, nenhuma incerta, ≥ 90% de sucesso técnico |
| Marcar 10% → 50% → 100% | A cada 2 dias, 10+ marcações desde o último passo, nenhuma incerta, ≥ 95% de sucesso |
| Marcar `sim` → `teste` | 2 incertas em 24 h, ou 3+ falhas técnicas que sejam 20%+ das marcações do dia |
| Cancelar/remarcar `teste` → `sim` | Marcação em 100% há mais de 2 dias e estável; recua junto com a marcação |

Falha por regra de negócio (convênio inativo, sem médico credenciado, nascimento divergente) **não** conta como falha técnica.

Para voltar tudo ao modo antigo na hora: `update public.config set valor = 'nao' where chave in ('klingo_api_horarios', 'klingo_api_marcar', 'klingo_api_pre_cadastro', 'klingo_api_pos', 'klingo_autogestao');`

## 5. Revisão dos pacientes antigos (feita em 12/11/2026)

Fonte: pedidos (`pre_agendamentos`) e `pacientes` com CPF **válido** e data de nascimento. Resultado da conferência na API (109 pares distintos, nenhum dado pessoal lido):

| Situação | Quantos | O que o sistema fez |
|---|---|---|
| Cadastro encontrado e nascimento confere | 41 | Ligou os pedidos ao cadastro do Klingo (`pre_agendamentos.klingo_paciente_id` = id da API, 45 pedidos), guardou o plano cadastrado e quais contatos faltam |
| CPF não encontrado (paciente novo) | 55 | Anotou; na hora de marcar o sistema cria o pré-cadastro (se liberado) |
| CPF existe, mas o nascimento é outro | 13 | Anotou como divergente. **Não marca sozinho**; a equipe confere (pode ser CPF do responsável de uma criança) |

Achados importantes:
- **O número do prontuário dos relatórios NÃO é o número da API** (0 iguais em 38 comparações). Por isso o id da API fica só em `klingo_identidade` e `pre_agendamentos.klingo_paciente_id`; `paciente_klingo_vinculo.prontuario` (que o `klingo-reconhecer` usa) **não foi tocado**.
- A conferência pela API achou 41 dos 109 pares com CPF + nascimento corretos e separou os outros 68 em "paciente novo" (55) e "nascimento diferente" (13); o relatório A dava `nao_encontrado` em 57% sem distinguir os dois (planejamento, seção 0). A API é a fonte confiável para identificar.
- Dos pedidos antigos, 147 de 269 **não têm CPF**: não dá para conferir. Quando essas pessoas voltarem, o chat pede o CPF.

A rotina `klingo-revisar-pacientes` (a cada 5 minutos) confere sozinha quem aparecer sem conferência; só chama a função se houver alguém na fila.

## 6. Como fazer o primeiro teste real de marcação (único passo humano para abrir a marcação sozinha)

O plano (seção E, Etapa 2) exige marcações **reais** de teste. Sem isso a marcação fica em modo `teste` (ninguém usa). Para liberar:

1. Avise o call center de que haverá marcações de teste para cancelar (a API não tem homologação; é a agenda real).
2. Escolha **um paciente que autorize** (cadastrado no Klingo, com CPF e nascimento corretos). Em Configurações (ou no editor SQL), ponha o **celular que ele usará no chat** em `klingo_api_telefones_teste` (só números; vários separados por vírgula).
3. No chat, com esse celular, faça uma consulta de **pediatria ou neurologia** no convênio **Particular** (as duas especialidades da API) até o fim.
4. Confira no Klingo se a marcação apareceu, se o cartão veio no chat e **cancele** a marcação no Klingo. Repita até 20 vezes (o plano pede 20 sem erro; pode variar convênio e horário).
5. A partir daí o sistema decide sozinho (seção 4): 10%, 50% e 100%. Cada passo avisa a gestão.

Se algo sair do esperado, a operação fica em `klingo_operacao` com o código do motivo (sem dado pessoal) e o painel (Indicadores) mostra o resumo.

## 7. O que existe e onde está

| O quê | Onde |
|---|---|
| Tabelas novas (12) | `supabase/klingo-auto-parte1-tabelas.sql` (+ `klingo_conversa_ident` na parte 3 e `klingo_decisao` na parte 5) |
| Interruptores, segredos, cota, tradução de convênio, origem do agendado | parte 2 |
| Identidade, revisão dos antigos, conferência no gatilho | parte 3 |
| Ofertas, operação, `klingo_pode_marcar`, resultado da operação, vigia | parte 4a |
| Passo `cpf_nasc`, `fluxo_finalizar`, menu pós-marcação, horários pela API em `chat_horarios` e `chat_horario_escolher` | parte 4b (funções do motor com o código real da produção + as mudanças marcadas `klingo-auto`) |
| Medidas, autogestão, rotinas (cron) | parte 5 |
| Pré-cadastro único por CPF e webhook | parte 6 |
| Indicadores e resumo do painel | parte 7 |
| Cancelar e remarcar pelo chat | parte 8 |
| "Voltar e corrigir" com o passo CPF + nascimento | parte 9 |
| Edge Functions | `klingo-identificar`, `chat-agenda-api` (só leitura), `klingo-executar` (escrita, só com id de operação), `klingo-sincronizar`, `klingo-webhook`; a `klingo-agenda-api` **perdeu a escrita** (v0.4) |
| Cliente da API (idêntico nas 4 funções) | `supabase/functions/klingo-executar/klingo-api.ts` |
| Testes | `testes/sql-klingo-auto.test.mjs` (52 verificações no clone da produção) e `supabase/functions/klingo-executar/klingo-auto.test.ts` (30, com um Klingo de mentira) |

Diferença em relação ao planejamento: a tradução de convênio está em **`klingo_plano_map`** (tabela própria) em vez de uma coluna em `convenio_config`, para não mexer na tela de Convênios nem no que ela lista.

## 8. Segurança: o que mudou

- `klingo-agenda-api` (que marcava para qualquer CPF com o `x-sync-key`) **não marca mais**: responde 410. A escrita só existe em `klingo-executar`, com segredo próprio do cofre e só com o id de uma operação aprovada pelo banco (item J-01 do planejamento).
- Hash do CPF com um sal **próprio** do cofre (`klingo_hash_sal`), separado do `ia_segredo` (que continua sendo sal do hash de telefone da Jornada: **não troque o `ia_segredo`** antes de separar esse sal, item J-04, ainda pendente).
- Todas as funções novas são só do `service_role` (nenhuma é chamável por `anon` nem pela equipe logada), com exceção de `painel_automacao_resumo` (equipe). Todas as 12 tabelas novas têm RLS ligada e nenhuma regra de acesso.
- O cliente da API nunca devolve nem registra o corpo de um erro do Klingo (pode ter CPF); só status, caminho e um tipo interno.

## 9. O que ainda depende de decisão ou de terceiros

Ver `pendencias-do-dono.md`, seção "Autoatendimento Klingo": primeiro teste real, perguntas ao suporte do Klingo (URL do webhook, limite de chamadas, mais especialidades na API, plano da ASSEFAZ, agenda de teste), revisão da política de privacidade para citar a marcação automática, e o canal de código (SMS/e-mail) para liberar resultado de exame.
