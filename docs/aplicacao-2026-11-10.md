# Aplicação do planejamento — 10/11/2026

Versão 1.1 — 10/11/2026 (noite) / Mudança: segunda rodada. Etapas A3, C1, B, D e E aplicadas no banco; chat e painel novos no repositório; três testes antigos corrigidos. Texto da primeira rodada (Etapas 0 e A) mantido na seção 1.

Este documento diz **o que já está no ar**, **o que só está no repositório esperando publicação**, **o que ainda falta** e **como desligar ou voltar atrás** cada coisa. Planejamento completo: `docs/planejamento-auditoria-2026-11-10.md`.

> **Aviso sobre o Klingo (regra do `CLAUDE.md`):** os 5 relatórios (#14024 a #14028) e o #14359 existem e foram usados. O que ainda **não** existe no Klingo e limita o trabalho: (1) onde fica o **preço Particular** (por isso o cardápio mostra "Sob consulta" até a equipe definir o valor); (2) um campo/relatório de **convênio inativado** (por isso a suspensão é controlada aqui, no chat, e não vem do Klingo); (3) **última atualização do cadastro** e **hora real do atendimento**. Nenhum relatório novo foi necessário nesta rodada.

## 1. Primeira rodada (já no ar desde a manhã)

| O quê | Efeito | Como desligar ou voltar |
|---|---|---|
| Lista de horários rápida (`agenda-horarios-rapido.sql`) | Ultrassom de 45 dias de 6,9 s para 0,28 s (o limite do chat é 3 s) | A definição antiga está em `agenda_horarios_klingo_v1` |
| Agenda ao vivo (`agenda-ao-vivo.sql` + `chat-agenda-ao-vivo`) | Lê o Klingo na hora em que a paciente chega ao calendário | `update public.config set valor = 'nao' where chave = 'agenda_ao_vivo';` |
| Médico disponível ao vivo | Próximo horário livre de cada médico | Só aparece com o chat novo |
| Klingo a cada 30 s (`klingo-30s.sql`) | Jornada e reconhecimento a cada 30 s, uma leitura por vez | `select cron.unschedule('jornada-klingo-30s');` |
| Reconhecimento pelo prontuário conferido (`klingo-reconhecer` 1.1) | O nome corrigido só no Klingo passa a ser reconhecido | `agendamento_reconhecer = nao` |
| Etapa 0 (`etapa0-eventos-e-teste.sql`) | Linha do tempo, primeiro atendimento humano, marca de teste | Ver o cabeçalho do arquivo |
| Indicadores v2 (`indicadores-v2.sql`) | Pessoas únicas por dia, reentradas, sem atendimento humano, concluídas pela data real | O painel antigo segue funcionando |

## 2. Segunda rodada (10/11/2026, noite)

### 2.1 Fechamento dos indicadores (A3) — no ar
- **Migração `agendado-autoria.sql` aplicada** (quem confirmou o agendamento: sistema × atendente). A função `painel_indicadores_extras_v2` foi testada de verdade (como administrador) e responde.
- **Conversas de teste do passado:** a lista foi gerada de novo no banco (30 conversas: 22 "dona é conta de teste", 5 "encerrada por conta de teste", 2 "respondida por conta de teste", 1 "contato de teste"; 28 encerradas e 2 abertas; 3 são mistas — a equipe também respondeu). Pela regra decidida (Alisson assumiu/respondeu/encerrou = teste) **as 30 foram marcadas como teste. Nada foi apagado** (199 conversas e as mensagens continuam; 30 eventos `teste_marcado` no histórico). Para desmarcar uma: `conversa_marcar_teste(id, false, 'motivo')` (só TI) — a marca fica no histórico.
- **Congelamento ligado** (`indicadores_fechar = sim`) e **12 dias fechados** (29/10 a 09/11). Conferência feita antes de ligar: concluídas e "sem atendimento humano" batem **exatamente** com a contagem direta nas tabelas, dia a dia; "pessoas" difere em 1 a 4 por dia porque o mesmo telefone com duas crianças conta como 2 pessoas (por desenho). A rotina das 00:10 fecha os dias seguintes.
- Para desligar o congelamento: `update public.config set valor = 'nao' where chave = 'indicadores_fechar';` (dias já fechados continuam fechados; não se apagam).

### 2.2 C1 — nova conversa e reentrada (`c1-reentrada.sql`) — banco no ar; tela no repositório
| Item | Como ficou |
|---|---|
| Tela de escolha | Só aparece se **este aparelho** guarda a conversa. Aberta: "Voltar ao tema anterior" ou "Abrir uma nova conversa" (avisa que a antiga será encerrada e que o histórico fica salvo). Encerrada em até 2 dias: as mesmas duas opções. Encerrada há mais de 2 dias: vai direto ao formulário |
| Encerrar e abrir numa chamada só | `chat_nova_conversa`: a antiga fecha (motivo `nova_conversa`, origem `paciente`) e a nova nasce na mesma transação; duas abas não criam duas conversas; a remarcação pendente passa para a nova; se a atendente estava atendendo, recebe aviso no sino |
| Janela de 2 dias | `config.reabrir_dias = 2`. Mensagem do paciente numa conversa encerrada há mais de 2 dias é recusada com texto claro; conversa fechada pelo próprio paciente (nova conversa) **não reabre** por mensagem (só a equipe) |
| Motivo da reentrada | Se a anterior é do mesmo dia: "Não tive retorno", "Outro assunto" (texto opcional) ou "Ver a conversa anterior". Guarda a resposta (`reentrada_motivo`) **e** o que a regra automática diria (`reentrada_motivo_auto`: sem resposta de pessoa ou inatividade = sem retorno). O texto digitado vira a **primeira mensagem** da conversa nova; só a categoria vai para os dados |
| Aviso de "previsão" | Caixa no início, com "Estou ciente…" **obrigatório**; grava `previsao_aceita_em`. O servidor aceita a ausência (aparelho com cache antigo) |
| Encerramento por inatividade | Texto próprio enviado uma vez (`config.despedida_inatividade_texto`) + aviso no sino da atendente (`equipe_notificacao`) + evento `autoencerrada` na linha do tempo. **Exame/pedido em aberto deixa de impedir** o fechamento; **remarcação pendente continua impedindo** |
| Transferência reinicia as 24 h | Gatilho: trocar o responsável de uma conversa que aguarda o paciente reinicia o relógio |
| Desligar partes | `reabrir_dias = 36500` (volta a reabrir sempre) · `despedida_inatividade_ativa = nao` (volta a despedida única) |

**Textos que o dono precisa aprovar (estão no ar com a redação proposta; editáveis em `config`):**
- Inatividade: *"Como não recebemos resposta nas últimas 24 horas, encerramos este atendimento por enquanto. Seu histórico fica salvo. Quando quiser continuar, é só enviar uma mensagem aqui (até 2 dias depois) ou abrir uma nova conversa. Estamos à disposição!"*
- Previsão (tela): *"Importante: os dias e horários que mostramos aqui são uma previsão de agendamento. Quem confirma o seu agendamento é uma pessoa da nossa equipe."*
- Convênio suspenso: *"O convênio {convenio} está temporariamente suspenso por decisão administrativa. Posso te ajudar a escolher outro convênio ou o atendimento particular?"*

### 2.3 B — estrutura e permissões (`etapa-b-estrutura.sql`) — no ar, em **modo observação**
- **Estrutura criada só com nomes provisórios:** 4 equipes (Call Center — transversal; Equipe Carla Adrielle; Equipe Juliana; Equipe Luzia — unidade CSI), cada uma com "Atendente 1 a 4"; Carla Adrielle é a supervisora da equipe dela; Juliana e Luzia aparecem como "(sem conta ainda)"; Alisson e Jonathan são TI. **Nenhuma conta foi criada e nenhum papel foi alterado** (a Carla Adrielle continua administradora).
- **Onde mexer:** aba Equipe > seção **Estrutura** (TI, gerência e supervisão): ligar cada "Atendente N" à conta real, definir a unidade da equipe, ver a simulação e trocar o modo.
- **Regra no servidor:** `pode_ver_conversa` (TI/administrador e marketing como hoje; gerência tudo; supervisão e atendentes veem a unidade da equipe, a triagem do Call Center — conversa sem unidade — e as próprias). Aplicada nas leituras de `conversas` e `mensagens` **só quando `permissao_modo = ligado`**.
- **Modo observação (padrão):** nada é bloqueado. O botão "Simular o que cada pessoa veria" mostra o efeito. **Simulação de hoje:** se ligasse agora, Carla Fernandes veria 8 das 31 conversas abertas e Aimê Brito 22 — porque ainda não há atendente ligada a equipe/unidade. **Por isso não deve ser ligado antes de preencher a estrutura.**
- **Pendente nesta etapa:** `pacientes`, `pre_agendamentos` e `contatos` ainda usam a regra antiga (leitura por papel); o `update` direto de `conversas` pelo navegador continua permitido (a transferência nova já passa pela função); a unidade das equipes de Carla Adrielle e Juliana está **"a definir"**.
- Voltar atrás: `update public.config set valor = 'desligado' where chave = 'permissao_modo';`

### 2.4 D — transferências, sino e indicadores (`etapa-d-transferencias.sql`) — no ar; telas no repositório
- **Transferência** (`conversa_transferir`): para uma **pessoa** ou para a **fila de uma unidade**; **em lote** (até 50, tudo ou nada, com resumo do que não pôde); grava evento (de, para, quem, motivo); avisa quem recebe (uma notificação por pessoa, não por conversa); no modo observação registra em `permissao_observacao` o que *seria* recusado. Painel: menu "Transferir…" com pessoa/unidade, e botão **"Transferir em lote"** na lista.
- **Sino do paciente:** item no menu do chat com 4 estados (ligado, silenciado, bloqueado no aparelho com instrução de como liberar, desligado); silenciar para o envio de push **daquela conversa**.
- **Indicadores por pessoa e equipe** (`painel_indicadores_equipe`): participou, mensagens, assumidas, encerradas, agendadas, transferiu, recebeu; total geral conta a conversa uma vez; "agendado pelo sistema" separado; TI/gerência veem todos, supervisão a equipe, atendente só ele. Botão na seção Estrutura.

### 2.5 E — catálogo e agenda
- **Convênio suspenso** (`etapa-e-convenio-suspenso.sql`): TI e gerência suspendem por **1 mês** na aba Convênios ("Suspensão temporária"). O paciente **não consegue escolher** o convênio e, se digitar o nome, recebe o aviso próprio; passado 1 mês a gestão recebe **aviso de revisão** no sino (rotina diária) e a suspensão **não termina sozinha** (renovar ou reativar). Nada é gravado no Klingo. **Limite:** a lista do chat ainda **não mostra o convênio esmaecido** com o aviso entre parênteses — hoje ele some da lista; mostrar esmaecido exige mexer no gerador de opções do motor e no chat (próxima rodada).
- **Cardápio só Particular:** a aba Catálogo mostra o preço Particular revisado ou **"Sob consulta"**; os convênios ficaram num bloco recolhido "só para conferência interna" (os alertas de divergência continuam). Depende da pergunta ao suporte do Klingo sobre onde fica o preço Particular.
- **Vínculo manual supervisionado** (`etapa-e-vinculo-manual.sql`): confirmar "é a mesma pessoa" agora **avisa** se já existe outro vínculo (nada é trocado em silêncio), só a supervisão troca, e **todo vínculo** (inclusive desfazer) fica em `vinculo_log` (quem, quando, antes, depois; imutável). Padrão `vinculo_manual_quem = equipe` (nada muda para quem usa hoje); trocar para `supervisao` exige supervisão/gerência/TI.

### 2.6 Testes que já falhavam (resolvidos)
Em todos os casos o **produto estava certo e o teste estava desatualizado**:
| Teste | Causa | Correção |
|---|---|---|
| `test:sentinela-navegador` (17/19) | O aviso de IA foi retirado da tela inicial de propósito (commit "Remove aviso da IA da tela inicial"); o envio do pedido hoje é `chat_pedido_enviar` | Teste passou a exigir o aviso de **previsão** + "estou ciente"; chamada corrigida → 19/19 |
| `test:login` (19/23) | A saudação é "Olá, Ana!" (não "Olá de novo") e a linha de dados mostra nome e telefone | Textos atualizados → 23/23 |
| `test:jornada` (16/17) | "Mudar status…" passou a oferecer todas as colunas e chama `jornada_definir_status` | Teste atualizado → 17/17 |
Também estavam desatualizados e foram corrigidos: `test:pessoa` (em tela larga o contexto vira coluna lateral), `test:convenios-painel` (o bloco "O que mudou" saiu em #96), `test:convenio` e `test:assuntos` (o cenário de teste não tinha a coluna `paciente` que o motor passou a usar). `test:python` (biometria) não roda neste ambiente por falta do `pytest`, sem relação com as mudanças.

**Resultado da suíte completa em 10/11/2026 (noite):** todos os scripts verdes, exceto `test:python` (ambiente). Durante a conferência apareceram e foram corrigidos dois erros **meus**: (1) a seção Estrutura do painel quebrava se o servidor respondesse incompleto (`test:navegador`); (2) `convenio_reativar` tinha uma exceção para o usuário `postgres` que, numa função `security definer`, deixaria qualquer pessoa logada reativar convênio — corrigido no banco e no arquivo, com teste (atendente e conta sem papel são barradas).

### 2.7 Dados pessoais no repositório
Um telefone de teste e o CPF do dono estavam em arquivos de teste e documentos. **Mascarei nos arquivos atuais** (troca por números fictícios; os testes continuam passando). **O histórico do Git ainda contém os valores originais.** Limpar o histórico (reescrever a história e forçar o envio) e/ou tornar o repositório privado são decisões do dono e **não foram feitas**.

## 3. O que falta (depende de você ou da próxima rodada)

1. **Publicar o chat e o painel novos:** o chat (tela de escolha, aceite da previsão, sino) e o painel (Estrutura, lote, suspensão) estão na branch `ccr-4005f683-4gtklr`; a branch anterior (`claude/dazzling-goodall-gw9a7f`) já foi juntada na `main` (PR #118). Publicar = juntar a branch nova na `main`.
2. **Dados da Etapa B:** e-mails de **Juliana e Luzia** (para criar as contas), **autorização para mudar o papel da Carla Adrielle** (de administradora para supervisora), a **unidade** das equipes de Carla Adrielle e Juliana, e quem atende em cada equipe (hoje "Atendente 1 a 4").
3. **Código do caso do nome corrigido** (AGE-01): ainda não recebido.
4. **Aprovar os 3 textos** da seção 2.2.
5. **Resposta do suporte do Klingo:** preço Particular, convênio inativado, última atualização do cadastro, hora real do atendimento.
6. **Próxima rodada técnica:** convênio esmaecido na lista do chat; aplicar a regra de unidade também a `pacientes`, `pre_agendamentos` e `contatos` e tirar o `update` direto de `conversas`; ligar `permissao_modo` depois de preencher a estrutura; MON-04 (travamento por atendente, sem reprodução); histórico completo da pessoa (CONV-04); separar "ao vivo" × "histórico" (CONV-05).

## 4. Como conferir
`cd testes && npm install && CHROMIUM_PATH=/opt/pw-browsers/chromium npm test` repete tudo. Novos nesta rodada: `test:c1-sql` (17), `test:c1` (8, navegador), `test:estrutura-sql` (13), `test:transferir-sql` (9), `test:convenio-suspenso-sql` (7), `test:vinculo-sql` (8), `test:sino` (3).
