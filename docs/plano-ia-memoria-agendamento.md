# Plano: memória da IA, listas de escolha e conferência com o Klingo

Data: 29/10/2026. Base: PDF "Klingo: fluxo de agendamento e API para IA de pré-cadastro" e o que já está no ar (workflow `Triagem IA - Atendimento`, projeto Supabase `webchat-atendimento`).

## Onde estamos hoje

| Peça | Situação |
|---|---|
| Catálogo | `catalogo_procedimento` (2.149), `catalogo_agenda` (16.382 linhas de grade), `catalogo_plano` (4.742 planos, 36 operadoras). Recarregado toda noite por `sync-catalogo-klingo`, que **apaga e regrava**: não sobra histórico. |
| Qualidade do cadastro | Só 772 dos 2.149 procedimentos têm agenda vigente. Só 2 têm preparo. 16 nomes duplicados. 2 linhas de agenda de profissional "teste". |
| Preço | Não entra. O 13983 traz valor por operadora (Hapvida testado), mas o Particular não veio. |
| IA | A cada mensagem, recebe o histórico inteiro + uma busca no catálogo pelo texto das últimas 4 mensagens. Não sabe em que etapa está; o "rascunho" do pré-agendamento é a única memória. |
| Fim do fluxo | O atendente clica "Marcar como agendado" à mão. Ninguém confere se o que foi marcado no Klingo bate com o pedido. |
| Paciente que volta | Cada conversa começa do zero. |

## A ideia central: memória em vez de treino

Não precisa treinar (fine-tuning) o modelo. O jeito certo é a IA consultar, a cada passo, uma **memória organizada no Supabase**, com só o que serve para aquele passo. Ela fica "experiente" porque a memória guarda o resultado das conversas anteriores. Ela não guarda dados no próprio modelo.

São quatro camadas:

1. **Conhecimento da clínica**: o catálogo curado (procedimento, onde é feito, quem faz, preparo, preço por plano), com data e origem de cada dado.
2. **Histórico de mudanças**: o que entrou, saiu, mudou de valor ou foi bloqueado, e quando.
3. **Experiência**: o que os pacientes escreveram e o que o atendente de fato marcou. Isso vira sinônimos aprendidos e exemplos de conversas bem resolvidas.
4. **Memória do paciente**: agendamentos anteriores e o cadastro já confirmado, para a próxima vez ser rápida.

Nada disso fica ligado à API de marcação o tempo todo. A memória é atualizada por cópias periódicas de relatórios do Klingo, que já funcionam hoje com o `X-APP-TOKEN`.

## Fase 0: confirmar no Klingo antes de programar (concluída em 29/10/2026)

Resultado completo em `docs/fase-0-verificacao.md`; texto para o suporte em `docs/fase-0-email-suporte-klingo.md`.

- [x] **Relatório de marcações:** não precisa criar. Os relatórios #7 (Agendas Marcadas), #13825 (Visão Consolidada por Marcação) e #47 (Bloqueadas e Canceladas) já saem pela API com filtro de data. Nenhum traz CPF; a conferência casa por nome + celular + procedimento + data/hora + operadora + unidade.
- [x] **Preço Particular:** vem do valor das marcações do #13825 (184 procedimentos com valor; 63 com mais de um valor, que exigem regra de confiança). Convênio continua no #13983.
- [x] **Bloqueio:** existe para procedimento (Faturamento Ativo), marcação (Status) e agenda (vigência). Para plano, perguntar ao suporte.
- [ ] **Filtros do #13983 pela API:** descobrir os ids na Fase 1 (a resposta da API lista os filtros).
- [x] **Teste real do #7:** feito em 29/10/2026 (ver `docs/fase-0-verificacao.md`).
- [ ] **Perguntas ao suporte:** e-mail pronto como rascunho no Gmail; falta enviar (pessoa).

## Fase 1: base de conhecimento com histórico (antes de limpar o cadastro) — CONCLUÍDA em 29/10/2026

Entregue: foto de referência, comparação noturna com histórico, preços (convênio e Particular com confiança), demanda, lista de limpeza, aba Catálogo, IA citando preço como previsão. Diferenças do plano: não há foto diária (a foto de referência + `catalogo_mudanca` bastam); o Particular vem do #13825, não do #13983.

**Objetivo:** guardar uma foto de tudo que existe hoje, passar a enxergar mudanças, e só então limpar o cadastro no Klingo.

Banco:

- `catalogo_foto (id, tipo, tirada_em, linhas, dados jsonb)`: cópia bruta de cada relatório a cada sincronização, guardada por 180 dias. A foto de hoje fica marcada como **referência pré-limpeza** e não é apagada.
- `catalogo_preco (procedimento_id, operadora, plano, tabela, valor, moeda, vigente_desde, visto_em, status)`, com `status` = `ativo | bloqueado | removido`.
- `catalogo_mudanca (id, tipo, chave, campo, antes, depois, detectada_em)`: `tipo` = `novo | alterado | removido | bloqueado | reativado`. Vale para procedimento, preço, plano e agenda.

Sincronização (`sync-catalogo-klingo`):

- Em vez de apagar e regravar, **compara** com o que já existe: insere o novo, atualiza o alterado, marca como `removido` o que sumiu (não apaga), e registra cada diferença em `catalogo_mudanca`.
- Passa a ler também o 13983 (preços), uma chamada por operadora.
- Se um relatório vier com menos de 50% das linhas da véspera, não aplica nada e avisa (proteção contra relatório cortado apagar o catálogo).

**Por que este valor:** cada preço guarda a tabela, a operadora, desde quando vale e quando foi visto pela última vez. A IA responde algo como: "Pela tabela Hapvida 2026, a RM de joelho está R$ X (atualizado em 28/10). O atendente confirma na marcação." Se o valor mudou nos últimos 30 dias, o painel mostra o valor anterior ao atendente.

**Relatório de limpeza** (gerado da foto, para a equipe agir no Klingo):

| Candidato a limpar | Hoje |
|---|---|
| Procedimento sem agenda vigente | 1.377 |
| Nome de procedimento duplicado | 16 |
| Agenda de profissional "teste" | 2 |
| Procedimento sem preço em nenhuma operadora | a medir após Fase 1 |
| Plano sem uso (nenhuma agenda aceita a operadora) | a medir |
| Procedimento mais pedido sem preparo | lista para cadastrar |

Uma tela "Mudanças do catálogo" no painel (só admin) mostra o histórico de mudanças. Depois da limpeza, o que sumiu aparece como `removido`, com data, e a IA deixa de oferecer.

Também antes de entrar em produção: apagar do Supabase as 7 conversas e 48 mensagens de teste.

## Fase 2 (CONCLUÍDA em 30/10/2026; falta só mergear o PR e republicar o fluxo do n8n, ver LEIAME): etapas, carregamento seletivo e listas de escolha

### A IA passa a saber em que etapa está

Novo campo `pre_agendamentos.etapa`:

`pedido → plano → preferencias → data_hora → dados → confirmacao → pronto → em_marcacao → conferido | divergente | erro | cancelado`

A cada mensagem, `ia_contexto` devolve só o que a etapa pede:

| Etapa | O que a IA recebe |
|---|---|
| pedido | tipos de exame e partes do corpo; até 8 procedimentos que batem com o texto (só os com agenda vigente) |
| plano | operadoras aceitas na agenda daquele procedimento + preço por operadora, se houver |
| preferencias | unidades, profissionais e dias da semana daquele procedimento |
| data_hora | próximas datas e faixas de horário da grade (14 dias), marcadas como **preferência** |
| dados | cadastro já conhecido do paciente (se houver) e o que falta |
| confirmacao | o resumo completo para ler de volta |

O prompt fixo (regras) vai no início e com cache (`cache_control` da API da Anthropic). Para isso, o nó do Claude no n8n vira uma chamada HTTP direta à API. Cada mensagem passa a custar só o contexto da etapa, não o catálogo inteiro.

### Listas com caixas de seleção no chat

A resposta da IA ganha o campo `opcoes`:

```json
{ "pergunta": "Qual parte do corpo?", "tipo": "multipla", "lista": "regiao", "outro": true }
```

A IA escolhe **qual lista** mostrar. Os itens vêm do banco (função `ia_opcoes(lista, filtro)`), então a IA não inventa opção. Listas:

- **Tipo de exame**: Ressonância, Tomografia, Ultrassom, Ultrassom com Doppler, Raio-X, Mamografia, Densitometria, Consulta (agrupando as classes do 13981).
- **Parte do corpo**: cabeça/crânio, pescoço, coluna, tórax, abdome, pelve, mama, ombro/braço, mão/punho, quadril, joelho, perna, pé/tornozelo, vasos. A nova tabela `catalogo_regiao` liga cada procedimento a uma região por regras de palavra no nome, com revisão manual.
- **Procedimento**: até 8 do filtro acima.
- **Plano**: Particular + operadoras aceitas para aquele procedimento.
- **Unidade, profissional, dia da semana, período** (manhã/tarde/noite), conforme a grade.
- **Data e hora desejadas**: datas e faixas da grade.

No chat (`index.html`), a mensagem com `opcoes` mostra caixas de seleção (ou botões, se for escolha única), um campo "Outro: digite aqui" e o botão Enviar. A escolha vai como texto normal ("Escolhi: Ressonância, Joelho") e também estruturada, para a IA não ter que adivinhar. Novo campo `mensagens.opcoes jsonb`.

### Regras novas do prompt

- Pode informar preço **se** o catálogo trouxer valor do plano escolhido, citando tabela e data e dizendo que o atendente confirma.
- Não oferece procedimento, plano ou agenda com status `bloqueado`/`removido`. Se o paciente pedir, diz que o atendente verifica.

## Fase 3: data e hora escolhidas pelo paciente + conferência de encerramento

### Escolha

O paciente escolhe data e hora desejadas a partir da grade (campos `data_desejada`, `hora_desejada`, `alternativas`). A IA sempre diz que é preferência: quem ocupa o horário é o atendente.

### Conferência automática

1. O atendente marca no Klingo e clica **"Marcado no Klingo"** no cartão (`etapa = em_marcacao`).
2. A Edge Function `conferir-marcacoes`, a cada 10 minutos (pg_cron), lê o relatório de marcações da Fase 0 e procura o pré-agendamento por CPF (ou nome + data de nascimento) + procedimento.
3. Ela confronta: procedimento, data, hora, unidade, profissional, plano e os dados do cadastro (nome, data de nascimento, celular).
4. Resultado:

| Resultado | O que acontece sozinho |
|---|---|
| **conferido**: tudo bate | Conversa vai para `encerrada`; o paciente recebe "Seu exame foi marcado para dd/mm às hh:mm na unidade X" + preparo cadastrado; vira registro no histórico do paciente. |
| **divergente**: achou, mas algo difere (outra data, outro plano, nome escrito diferente) | Cartão fica amarelo com "Pedido: X / Klingo: Y" campo a campo. O atendente clica "Está certo assim" (ex.: combinou outra data com o paciente) ou corrige no Klingo; a próxima conferência reavalia. |
| **erro**: não achou depois de 2 h em `em_marcacao` | Cartão fica vermelho e a conversa volta para a fila com o aviso "Marcação não encontrada no Klingo". |

LGPD: o relatório de marcações traz dados de pacientes. A função processa em memória e grava só o resultado da conferência (`conferencias`: pré-agendamento, id da marcação no Klingo, campos divergentes, data). Ela nunca grava o relatório inteiro.

Se a Fase 0 mostrar que o relatório de marcações não sai pela API, a conferência vira semiautomática: o atendente cola o nº da marcação e a data/hora marcadas, e o sistema confronta com o pedido do paciente.

## Fase 4 (conferência de identidade e cadastro reaproveitado: CONCLUÍDA em 30/10/2026; falta o histórico de agendamentos anteriores): paciente que volta

- Nova tabela `pacientes`, com chave CPF: cadastro confirmado, `klingo_paciente_id`, ligação com os `contatos` (telefones) e histórico de agendamentos conferidos.
- Quando uma conversa nova começa por um telefone conhecido, a IA **primeiro confirma a identidade** (data de nascimento ou 3 últimos dígitos do CPF). O telefone sozinho não prova quem é, e o histórico é dado de saúde.
- Confirmada a identidade: "Que bom te ver de novo, Maria! Da última vez você fez Ressonância de joelho pelo Hapvida na unidade CSI. É algo parecido agora?" O cadastro vem pronto: a IA só pergunta "seus dados continuam os mesmos?" e pede o que faltar ou tiver mudado.
- **Retomar conversa**: se há pré-agendamento parado (rascunho) dos últimos 7 dias, a IA oferece continuar de onde parou, na mesma etapa.
- Retenção: sem nova marcação em 2 anos, o cadastro guardado é anonimizado (a definir com a clínica).

## Fase 5: aprendizado contínuo ("já fez outras vezes")

- **Sinônimos aprendidos** (`ia_sinonimo_aprendido`: termo, procedimento_id, vezes): cada conferência `conferido` registra as palavras que o paciente usou e o procedimento que de fato foi marcado. Exemplos: "ressonância do joelho" e "RM joelho esquerdo". A busca do catálogo passa a ranquear por esse histórico. O mesmo vale para planos ("unimed" → operadora certa).
- **Exemplos**: o admin marca conversas bem resolvidas como exemplo (anonimizadas). As 2 ou 3 mais parecidas com o pedido atual entram no contexto da IA.
- **Perguntas frequentes**: respostas que a equipe deu e o admin aprovou viram base de respostas da IA (horário de funcionamento, endereço, estacionamento etc.).
- **Indicadores no painel**: % de pré-agendamentos conferidos sem divergência, em que campo mais diverge, em que etapa o paciente desiste, tempo do pronto até a marcação.

## Ordem sugerida

| Ordem | Fase | Depende de |
|---|---|---|
| 1 | Fase 0 (perguntas ao Klingo / criar relatório de marcações) | equipe |
| 2 | Fase 1 (foto, preços, mudanças, relatório de limpeza) → só então limpar o cadastro no Klingo | 0 (preço Particular) |
| 3 | Fase 2 (etapas, contexto por etapa, listas com caixas de seleção) | 1 |
| 4 | Fase 3 (data/hora, conferência e status automáticos) | 0 (relatório de marcações), 2 |
| 5 | Fase 4 (paciente que volta) | 3 |
| 6 | Fase 5 (aprendizado) | 3 |

## Riscos

- **Conferência depende do relatório de marcações.** Sem ele via API, a conferência fica semiautomática.
- **Polling, não tempo real.** "Assim que marcar" significa em até 10 minutos. O Klingo não tem aviso automático (webhook) conhecido.
- **Preço é referência.** Autorização de convênio e valor final continuam com o atendente; a IA sempre diz isso.
- **Dados pessoais.** CPF, mãe e histórico ficam só no Supabase (RLS: admin/atendente), nunca no prompt além da etapa de confirmação, e credenciais só no servidor.
