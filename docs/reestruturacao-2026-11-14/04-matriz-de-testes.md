# 04 — Matriz de testes

Versão 1.0 — 14/11/2026 / Mudança: gerada a partir da execução real dos testes (`gerar-matriz`), não escrita à mão. **117 de 117 verificações novas passaram.**

**O que estes testes provam e o que não provam.** Rodam num Postgres embutido com a estrutura REAL da produção (retrato de 14/11/2026), num navegador real (Chromium) com o Supabase simulado e em TypeScript puro. **O Klingo é sempre simulado** (nenhuma chamada real, nenhuma marcação real) e não há paciente real. Não provam: Realtime por WebSocket, push, rede do Supabase, resposta real da API do Klingo, Edge Functions executadas no Deno (`index.ts` de `chat-agenda-api` e `disponibilidade-vigia` não são executados; testam-se as regras puras e o banco).

Grupos do prompt mestre: **A** disponibilidade · **B** agendamento · **C** solicitação futura · **D** pós-agendamento · **E** segurança e produção.

## Cobertura por grupo

| Grupo | Situação |
|---|---|
| A Disponibilidade | Coberto: horários, lista vazia, estrutura inválida, tudo filtrado, expirado, oferta vencida durante a escolha, serviço sem integração, convênio sem tradução, API indisponível (estado), sombra sem exposição. **Não coberto:** "API lenta" como cenário (só a métrica de tempo), "horário ocupado após seleção" na API real. |
| B Agendamento | Coberto sobre o pipeline existente com Klingo simulado: sucesso comprovado, duplo clique, duas chamadas, incerto, retentativa do job, horário tomado, falha definitiva, CPF divergente, plano sem tradução, vários exames, comum fora da lista, reabertura, transferência humana. **Não coberto:** "timeout após sucesso externo" com o Klingo real e a conciliação por protocolo (depende de E4); 5xx do Klingo é só classificado (`klingo-api.ts`), não exercitado de ponta a ponta. |
| C Solicitação futura | Coberto (todos os cenários listados, com ofertas simuladas), exceto "convênio volta a funcionar" que é equivalente a "nova oferta compatível" (mesmo caminho). |
| D Pós-agendamento | **NÃO coberto**: consultar, cancelar, remarcar e resultado de exame não foram alterados nem receberam teste novo (ver `05-pendencias.md`). |
| E Segurança e produção | Coberto: não autorizado, token inválido, acesso cruzado, responsável com dois filhos, RLS das tabelas novas, permissões (anon), flags teste e sombra, autogestão, migração, rollback. **Não coberto:** token revogado, rate limit por IP, "função sem JWT com autenticação própria" (documentado em `01`, não testado), regressão visual automatizada. |

## Verificações

| Grupo | Suíte | Cenário e resultado esperado | Resultado obtido | Evidência | Situação |
|---|---|---|---|---|---|
| A/E | Modos, flags, auditoria, autogestão, catálogo | o retrato da produção monta inteiro e a migração webchat-v2-parte1 aplica sem erro | — | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | BUG ORIGINAL: mestre "sim" + marcar "teste": o paciente comum NÃO marca; só o telefone da lista de teste | fora=nao; lista=teste | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | mestre "sim" + horários "sombra": o paciente comum fica em SOMBRA (só mede): não está "ativo" e nada é exposto | fora=sombra/ativo=false; lista=sombra/ativo=false | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | "sombra" em capacidade de ESCRITA (marcar, cancelar, pré-cadastro) vale "nao": sombra nunca escreve | nao,nao,nao | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | mestre "sim" + chave "sim" a 100%: todos usam; a 0%: só a lista de teste | 100%=sim; 0% comum=nao; 0% lista=sim | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | mestre "teste" é TETO: mesmo com a chave em "sim" só a lista usa; sombra de leitura continua medindo | fora=nao; lista=teste; horários comum=sombra | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | mestre "nao" desliga TUDO (inclusive a lista de teste e a sombra) | nao,nao,nao | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | mestre "legado" ou valor inválido: "legado" não promove nada; valor desconhecido na chave = "nao" | marcar comum=nao; horários inválido=nao | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | cancelar e remarcar herdam klingo_api_pos enquanto não têm chave própria; com chave própria vale a própria | herdado comum=nao; herdado lista=teste; próprio nao=nao | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | conversa inexistente e erro interno nunca liberam: modo "nao" | {"m":"nao","n":"nao"} | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | AUDITORIA: cada mudança em config grava chave, antes, depois, origem e versão; mesma valor não grava; segredo sai oculto | 3 linhas (esperado 3: insert, update a>b, delete); {"tres":true,"insert":true,"antes_depois":true,"apagou":true,"versao":true,"origem":true,"semVazar":true} | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | AUDITORIA da migração: as chaves novas e a mudança de klingo_so_liberados ficaram registradas com a origem "migracao:webchat-v2.0" | klingo_api_cancelar,klingo_api_remarcar,klingo_api_resultado,notificacao_modo,previsao_modo,previsao_monitor_modo | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | só o administrador lê a auditoria (atendente e anon veem zero linhas ou são recusados) | atendente=0; admin=33 | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | klingo_decidir RECUA (sim > teste) mas RECUSA subir (teste > sim) sem autorização | após recuo=teste; subida recusada=true; valor=teste | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | AUTOGESTÃO: com 25 marcações de teste perfeitas só RECOMENDA (a chave continua "teste", uma recomendação, sem repetir) | marcar=teste; recomendações=1; ações 1ª=["marcar:recomendado"]; 2ª=[] | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | AUTOGESTÃO: horários em sombra com muitas respostas VAZIAS não geram recomendação (só "com horários" conta) | recomendações=0; ações=[] | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | AUTOGESTÃO RECUA o mestre (sim > teste) com 2 marcações incertas em 24 h e avisa a gestão; nunca sobe | mestre=teste; marcar=teste; avisos=2; origem da auditoria=autogestao; ações=["mestre:recuou","marcar:recuou"] | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | PROMOVER: atendente é recusado; admin sem justificativa é recusado; admin com justificativa promove, e fica na auditoria e em klingo_decisao | atendente=Somente o administrador autoriza esta mu; sem justificativa=Escreva a justificativa (mínimo 10 letra; admin=ok; auditoria=promocao:00000000-0000-4000-8000-0000000000a1 | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | klingo_promover recusa chave que não é interruptor (ex.: textos) e valor inválido | recusou,recusou | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | CATÁLOGO: klingo_so_liberados = sim NÃO esconde serviço (klingo_liberado sempre true); klingo_automatizavel só diz se a API reconhece | {"a":true,"b":true,"c":true,"d":false,"e":true} | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | CONSULTA: cada resultado vira UMA linha em klingo_consulta e a métrica certa; "com horários" só quando sobrou horário; sem dado pessoal | ok=3 (HTTP ok = 3: com, sem, filtrados); com horários=1; sem=1; estrutura inválida=1; erro=1; colunas sem PII=true | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | OFERTAS: gravação de sombra não apaga as ofertas reais da conversa (e vice-versa); sombra fica marcada | [{"hora":"08:00","sombra":false},{"hora":"09:00","sombra":true}] | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | klingo_pode_marcar não aceita oferta de sombra como base e remarcar usa klingo_api_remarcar (patch aplicado) | estrutural | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A/E | Modos, flags, auditoria, autogestão, catálogo | permissões: as funções novas não são chamáveis por anon; klingo_promover só por logado | nenhuma exposta | `sql-webchat-v2-modos.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | o retrato da produção monta inteiro e as partes 1 e 2 do WebChat v2 aplicam sem erro | — | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | CRITÉRIO 1: com a API desligada (nao) o calendário NÃO mostra os horários da grade, mesmo havendo grade; vem estado "nao_integrado" e o aviso certo | a grade teria 160 horários; o calendário mostra 0; estado=nao_integrado | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | modo SOMBRA: nem a grade nem as ofertas medidas aparecem para o paciente comum | slots=0; estado=nao_integrado | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | CRITÉRIO 2: com a API ativa e 3 ofertas, o calendário mostra EXATAMENTE as 3 (não os ~8 por dia da grade), com a chave da oferta e origem "api_klingo" | esperado 3; obtido 3; estado=com_horarios | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | ESTADO DE API: API respondeu sem horários => "sem_horarios" com a mensagem pedida (não confundir com falha técnica) | estado=sem_horarios; aviso=Não encontramos horários disponíveis para esse atendimento no momento. | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | ESTADO DE API: todos os horários filtrados também é "sem_horarios"; estrutura inválida, erro e limite são "indisponivel" (falha técnica) | {"todos_filtrados":"sem_horarios","estrutura_invalida":"indisponivel","erro_api":"indisponivel","limite":"indisponivel","erro_gravacao":"indisponivel","sem_traducao_plano":"nao_integrado","fora_do_escopo":"nao_integrado","dados_in | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | sem nenhuma consulta recente o estado é "sem_consulta" (a tela consulta a API antes de decidir) e nunca mostra a grade | estado=sem_consulta | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | oferta VENCIDA ou no PASSADO não aparece; filtros de período e unidade valem sobre as ofertas | manhã=2 (11:30 venceu); tarde=0; outra unidade=0 | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | ESCOLHA: só uma oferta real; guarda a chave da oferta e a origem; o texto NÃO diz que está marcado | CA DE SAÚDE E IMAGEM - CSI. (Horário livre na agenda agora; a equipe confirma a marcação.) | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | ESCOLHA de horário que só existe na GRADE (ex.: 08:00, sem oferta) é recusada: "acabou de ficar indisponível" (P0002) | {"code":"P0002","msg":"Esse horário acabou de ficar indisponível. Escolha outro, por favor."} | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | ESCOLHA de oferta VENCIDA enquanto o paciente decidia é recusada (a marcação nunca nasce de oferta velha) | {"code":"P0002","msg":"Esse horário acabou de ficar indisponível. Escolha outro, por favor."} | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | ESCOLHA de oferta de SOMBRA é recusada | {"code":"P0002","msg":"Esse horário acabou de ficar indisponível. Escolha outro, por favor."} | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | ESCOLHA em conversa sem a API ativa (comum, modo teste) é recusada com a mensagem de atendimento pela equipe | {"code":"P0001","msg":"Este atendimento é agendado pela equipe; não há horário para escolher aqui."} | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | token errado não lê nem escolhe horário de outra conversa (28000) | {"code":"28000","msg":"Conversa não encontrada."} | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | VÁRIOS EXAMES: sem operação composta suportada pela API => "nao_integrado" (varios_procedimentos), pedido preservado | itens=2; grupos=2; estado=nao_integrado/varios_procedimentos | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | previsao_buscar devolve só OFERTAS DA API (turno e antecedência respeitados) e lista vazia quando não há oferta, mesmo havendo grade | sem oferta=0; manhã=2; tarde=1; antecedência de 30 dias=0 | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| A | Disponibilidade: calendário só com API | pedido_horario_vigiar NÃO oferece mais horário da grade: pedido com data que passou vira alerta para a equipe, sem "oferta pendente" | ofertas=0; avisos à equipe=1; alerta="Pedido sem horário: a data escolhida (02" | `sql-webchat-v2-calendario.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | o retrato da produção monta inteiro e as partes 1 e 2 aplicam sem erro | — | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | MARCAÇÃO BEM-SUCEDIDA (passo 1): ao confirmar, nasce UMA operação "pendente" sem dado pessoal; o pedido AINDA NÃO está agendado; o executor é chamado só com o id | operações=1/pendente; pedido=rascunho; corpo da chamada=operacao_id | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | DUPLO CLIQUE: criar a operação de novo devolve a MESMA e não chama o executor outra vez; UNIQUE no banco impede a segunda linha mesmo por caminho direto | mesma operação=true; inserção direta duplicada=23505 | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | DUAS CHAMADAS AO MESMO TEMPO: o executor só pega a operação UMA vez (a 2ª recebe "nao_pendente") | pegaram=true,false | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | SUCESSO COMPROVADO: só com o voucher do Klingo o pedido vira "agendado" (origem chat_api, protocolo guardado) e o paciente recebe o cartão; concluir de novo é inofensivo | pedido=agendado/chat_api; protocolo=26777; repetição=true | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | REABERTURA / NOVA TENTATIVA depois de agendado não cria 2ª marcação: criar de novo devolve a operação concluída | operações=1 | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | TIMEOUT / RESULTADO INCERTO: o pedido NÃO vira agendado, a equipe é chamada com "conferir ANTES de marcar de novo", e nova tentativa NÃO cria outra operação | pedido=pronto; ia_ativa=false; operações=1 | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | RETENTATIVA DO JOB: operação parada é refeita (mesma operação, sem duplicar) e, esgotadas as tentativas, vira INCERTA e vai para a equipe; nunca fica presa | redisparadas=1; depois=incerto; operações=1 | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | HORÁRIO OCUPADO NA HORA DE MARCAR: a oferta é descartada, o pedido volta à escolha do horário, nada fica "agendado" e nada vai para a equipe | pedido=rascunho; ofertas=0; passo=horario | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | FALHA DEFINITIVA (plano inativo): não vira agendado; a equipe resolve o convênio com o motivo no resumo | pedido=pronto; ia_ativa=false | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | CPF DIVERGENTE: o cadastro do Klingo tem outra data de nascimento => NENHUMA operação é criada; a equipe assume | motivo=cadastro_divergente; operações=0 | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | PLANO SEM TRADUÇÃO / PACIENTE NOVO sem chave de pré-cadastro / VÁRIOS EXAMES: klingo_pode_marcar recusa com o motivo certo e nenhuma operação nasce | sem tradução=sem_traducao; paciente novo=paciente_novo; vários exames=varios_procedimentos | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | OFERTA DE SOMBRA / HORÁRIO DA GRADE nunca servem de base: sem oferta real klingo_pode_marcar devolve "sem_oferta_da_api" | sombra=sem_oferta_da_api; apagada=sem_oferta_da_api | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | PACIENTE COMUM (fora da lista de teste, mestre "sim" + marcar "teste"): NÃO há operação nem marcação automática; o pedido vai à equipe | klingo_pode_marcar=desligado; modo=nao | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| B | Agendamento (pipeline existente, Klingo simulado) | TRANSFERÊNCIA HUMANA COM OPERAÇÃO EM ANDAMENTO / DEPOIS DE AGENDAR: a rotina NÃO encerra sozinha uma conversa que já teve atendente | status=aguardando | `sql-webchat-v2-agendamento.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | o retrato da produção monta inteiro e as partes 1 a 3 do WebChat v2 aplicam sem erro | — | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | CRIAR: solicitação fica "ativa", NÃO cria agendamento nem operação no Klingo, avisa que NÃO é agendamento e o fluxo segue (não fica preso) | estado=ativa; pedido=rascunho; operações=0; fluxo seguiu=true | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | CRIAR sem autorização de recurso: paciente comum (modo "teste", fora da lista) é recusado com mensagem de equipe (P0001) | {"code":"P0001","msg":"Este recurso ainda não está disponível para você. A equipe pode ajudar."} | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | VALIDAÇÃO: data final antes da inicial, período > 1 ano, turno e horário inválidos são recusados; dias vazios = todos | recusas=22023,22023,22023,22023,22023; dias vazios -> 7 dias | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | IDEMPOTÊNCIA: registrar de novo a mesma solicitação (duplo clique, outra conversa da mesma pessoa) atualiza a MESMA, sem duplicar | abertas=1; criada=1; editada=2 | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | EDITAR e CONSULTAR: o paciente altera preferências e vê a solicitação; sem dado pessoal no retorno | turno=manha; dias=[2,4] | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | SEM BUSCA AUTOMÁTICA: vários exames ou serviço sem integração NÃO viram solicitação (seguem para a equipe); nada é prometido que não será procurado | {"code":"P0001","msg":"Este atendimento é agendado pela nossa equipe: não há busca automática de vaga para ele."}; solicitações=0 | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | VAGA COMPATÍVEL: oferta real que cruza com dia da semana, turno e período vira oportunidade (estado "oportunidade_identificada") e a notificação fica PENDENTE (nada foi enviado) | compatíveis=1; oportunidades=[{"hora":"09:00","estado":"nova"}]; notificação=pendente | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | NÃO ENVIA sem a chave: com notificacao_modo "nao" nada é entregue (nenhuma mensagem de aviso é simulada) e a fila continua visível | entregues=0; mensagens 15->15; notificação=pendente | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | NOTIFICA com a chave ligada e canal autorizado: mensagem no chat SEM afirmar agendamento; estado "notificada"; entrega registrada | texto: Encontramos uma possibilidade de horário compatível com a sua solicitação (RESSONANCIA MAGNETICA DO JOELHO (UNILATERAL))... | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | NOTIFICAÇÃO DUPLICADA: a mesma vaga nunca gera um segundo aviso para a mesma solicitação, mesmo achada de novo | 1 -> 1 | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | OPORTUNIDADE VENCIDA / paciente responde depois que o horário foi ocupado: nada é reservado, a solicitação volta a "ativa" e o paciente é avisado | oportunidade_expirada; estado=ativa | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | VAGA INCOMPATÍVEL: fim de semana, fora do período, turno errado e outra unidade (quando não aceita outras) NÃO viram oportunidade | compatíveis=0; novas=0 | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | NOVA ABERTURA DE AGENDA / convênio volta: uma oferta nova e compatível depois gera NOVA oportunidade; aceitar volta ao calendário normal (consulta nova), sem reservar nada | acao=abrir_calendario; estado=aguardando_resposta; pedido=rascunho; passo=horario; operações=0 | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | CONVERSÃO: agendamento confirmado fecha a solicitação ("convertida_em_agendamento") com o pedido associado; estado final não aceita mais mudança nem oferta | estado=convertida_em_agendamento; transição inválida=23514; nova oferta=estado_convertida_em_agendamento | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | CANCELAR: o paciente cancela; solicitação cancelada não recebe mais oferta; cancelar de novo é inofensivo | cancelada; reenvio=true; oferta=estado_cancelada | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | EXPIRAR: passou do período => "expirada" pela rotina; expirada não recebe oferta e some da busca | estado=expirada; rotina={"alvos":1,"disparou":false,"entregues":0,"expiradas":1} | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | SEM AUTORIZAÇÃO para notificar: a oportunidade é registrada, a notificação fica "bloqueada_sem_autorizacao", NADA é enviado e a equipe vê "precisa de humano" | canais=[]; notificação=bloqueada_sem_autorizacao; mensagens de aviso=0; precisa_humano=true | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | LIMITE de avisos por dia: a 2ª vaga no mesmo dia é registrada mas NÃO notificada ("bloqueada_limite") | entregue_ao_chat > bloqueada_limite | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | RESPONSÁVEL COM DOIS FILHOS (mesmo telefone/CPF do responsável, nascimentos diferentes): duas solicitações separadas; um não vê nem cancela a do outro | pessoas=2; F1 vê 1; cancelar a do outro=P0002 | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | SEGURANÇA: token errado, token de outra conversa e leitura direta das tabelas são recusados para o paciente; atendente lê pelo painel; quem não é da equipe não | token errado=28000; token alheio=28000; leitura direta=42501,42501,42501,42501; não-equipe=42501; itens no painel=8 | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | MOTOR: em "nao" não busca nada; em "sombra" busca e só conta (nenhuma oportunidade); em "teste" só a lista; o alvo some por 9 min depois de verificado | nao=0; sombra=1/sombra; compatíveis em sombra=1; oportunidades gravadas=0; logo após verificar=0 | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | A previsão antiga (grade) acabou: previsao_ativa = false, previsao_vigiar é o motor novo e a lista antiga não tem linhas | previsao_ativa=false; vigiar={"alvos":3,"disparou":false,"entregues":0,"expiradas":0}; linhas antigas=0 | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| C | Solicitação de disponibilidade futura | POLÍTICA DE ENCERRAMENTO é configurável e vem DESLIGADA: por padrão a conversa não é encerrada; ligada, encerra só sem humano nem operação pendente | padrão=aguardando; ligado=encerrada/outro/sistema | `sql-webchat-v2-disponibilidade.test.mjs` | ✅ passou |
| E | Migração e rollback | ANTES da migração o defeito existe (retrato da produção): mestre "sim" + marcar "teste" libera o paciente comum | klingo_ativo(comum, marcar) = true | `sql-webchat-v2-rollback.test.mjs` | ✅ passou |
| E | Migração e rollback | as 3 migrações aplicam sem erro sobre um banco que já tem dados | — | `sql-webchat-v2-rollback.test.mjs` | ✅ passou |
| E | Migração e rollback | MIGRAÇÃO PRESERVA DADOS: nenhuma linha existente foi apagada ou alterada (configuração, conversas, contatos, ofertas, previsão antiga); só entram chaves novas | chaves 56->65; oferta antiga sombra=false; novas=klingo_api_cancelar=teste,klingo_api_remarcar=teste,klingo_api_resultado=nao,previsao_modo=teste,previsao_monitor_modo=nao,notificacao_modo=nao | `sql-webchat-v2-rollback.test.mjs` | ✅ passou |
| E | Migração e rollback | DEPOIS da migração o paciente comum NÃO é liberado (mesmos valores de configuração, comportamento corrigido) | marcar ativo=false; horários=sombra | `sql-webchat-v2-rollback.test.mjs` | ✅ passou |
| E | Migração e rollback | ROLLBACK: reaplicar as 12 funções do retrato executa sem erro | — | `sql-webchat-v2-rollback.test.mjs` | ✅ passou |
| E | Migração e rollback | ROLLBACK devolve o comportamento anterior (inclusive o defeito, que é o que "voltar atrás" significa) e as tabelas novas ficam sem uso nem dano | klingo_ativo(comum, marcar)=true (comportamento antigo); tabelas novas preservadas: auditoria=10 | `sql-webchat-v2-rollback.test.mjs` | ✅ passou |
| A | Tela do paciente (navegador) | COM HORÁRIOS: mostra só os horários que vieram da API, diz que só ficam marcados depois da confirmação e oferece "Procurar mais datas" | slots=08:00,08:30,09:00; ordem=fn:chat-agenda-api>chat_horarios | `calendario-api.navegador.mjs` | ✅ passou |
| A | Tela do paciente (navegador) | SEM HORÁRIOS (a API respondeu e não há vaga): mensagem pedida e três saídas; NENHUM horário aparece | botões=Registrar minha disponibilidade para uma vaga futura \| Consultar de novo \| Falar com a equipe | `calendario-api.navegador.mjs` | ✅ passou |
| A | Tela do paciente (navegador) | FALHA TÉCNICA (API fora do ar) NÃO é "sem vaga": avisa que não foi possível consultar e oferece "Tentar de novo" (que consulta a API de novo, sem usar a lista guardada) | botões=Tentar de novo \| Registrar minha disponibilidade para uma vaga futura \| Falar com a equipe; última chamada={"janela":0,"fresco":true} | `calendario-api.navegador.mjs` | ✅ passou |
| A | Tela do paciente (navegador) | SERVIÇO SEM INTEGRAÇÃO: diz que é agendado pela equipe, NÃO oferece registrar disponibilidade (não seria procurado) e "Enviar meu pedido para a equipe" responde "sem_horario" ao assistente | botões=Enviar meu pedido para a equipe \| Falar com a equipe; resposta="sem_horario" | `calendario-api.navegador.mjs` | ✅ passou |
| A | Tela do paciente (navegador) | REGISTRAR DISPONIBILIDADE: formulário com período, dias, turno, aviso desmarcado por padrão e texto "não é um agendamento"; envia os dados certos | {"data_ini":"2026-11-15","data_fim":"2026-12-29","dias_semana":[1,2,3,4,5],"turno":"manha","aceita_outras_unidades":true,"aceita_outros_profissionais":true,"aceita_notificacao":true,"canais":["chat"]} | `calendario-api.navegador.mjs` | ✅ passou |
| A | Tela do paciente (navegador) | REGISTRAR sem autorizar aviso: canais vazios (não há consentimento presumido); datas invertidas e nenhum dia são recusados na tela, sem chamar o servidor | Escolha as datas: a final precisa ser depois da inicial. | `calendario-api.navegador.mjs` | ✅ passou |
| A | Tela do paciente (navegador) | "PROCURAR MAIS DATAS": consulta a próxima janela (janela=1) e mantém o calendário | janelas pedidas=0,1 | `calendario-api.navegador.mjs` | ✅ passou |
| A | Tela do paciente (navegador) | CONFIRMAR: antes de gravar a escolha a API é consultada DE NOVO (fresco); se o horário sumiu, avisa e não grava | consultas frescas=1; escolha gravada=null | `calendario-api.navegador.mjs` | ✅ passou |
| A | Tela do paciente (navegador) | AVISO DE VAGA no chat: mostra que NÃO está reservado; "Ver horários agora" aceita e abre o calendário normal; "Agora não" volta a procurar | respostas=[{"id":"sol-1","aceita":false},{"id":"sol-1","aceita":true}] | `calendario-api.navegador.mjs` | ✅ passou |
| A | Tela do paciente (navegador) | MENU "Minha disponibilidade": lista as solicitações, deixa alterar e cancelar, e explica que não é agendamento | cancelados=sol-1 | `calendario-api.navegador.mjs` | ✅ passou |
| C | Painel da equipe (navegador) | Atendente vê o botão e a lista: vaga encontrada em destaque, "Precisa de pessoa" explicado, aviso de que NÃO é agendamento nem reserva | [["RM JOELHO · Particular","13/11/2026 a 28/11/2026 · Tarde · Seg Qua Sex","Vaga encontradaPrecisa de pessoa: Sem autorização para avisar"],["CONSULTA · Unimed","13/11/2026 a 30/11/2026 · Manhã · Ter Qui","Procurando vaga"],["US A | `previsao.navegador.mjs` | ✅ passou |
| C | Painel da equipe (navegador) | Filtros por situação (uma lista só): "Precisam de pessoa", "Expiradas" e "Procurando" mostram as linhas certas | precisam de pessoa=1; expiradas=1; procurando=1 | `previsao.navegador.mjs` | ✅ passou |
| C | Painel da equipe (navegador) | Texto vindo do banco é mostrado como texto (nunca vira HTML) | nome=João <b>Lima</b> (filho/a) <b> na tabela=1 | `previsao.navegador.mjs` | ✅ passou |
| C | Painel da equipe (navegador) | Lista vazia mostra a mensagem; erro do banco mostra aviso e o painel continua funcionando | itens=1 exceções=0 | `previsao.navegador.mjs` | ✅ passou |
| C | Painel da equipe (navegador) | "Abrir conversa" fecha o quadro e abre a conversa da paciente | dialogs abertos=0 | `previsao.navegador.mjs` | ✅ passou |
| C | Painel da equipe (navegador) | O botão "Equipe agora" da chefia continua funcionando junto | — | `previsao.navegador.mjs` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | A1 API retorna horários: ok_com_horarios com a contagem de cada etapa | (asserts do teste) | `chat-agenda-api/diagnostico.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | A2 API retorna lista vazia (HTTP 200): api_sem_horarios, NÃO é erro nem 'ok com horários' | (asserts do teste) | `chat-agenda-api/diagnostico.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | A3 API retorna dados inválidos / estrutura inesperada: estrutura_invalida (≠ vazio), estado indisponivel | (asserts do teste) | `chat-agenda-api/diagnostico.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | A4 horários recebidos mas TODOS filtrados: todos_filtrados com recebidos > 0 (passado, hoje já passou, hora ou chave inválida) | (asserts do teste) | `chat-agenda-api/diagnostico.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | A5 horário EXPIRADO hoje: só vale o que ainda não passou; o resto da lista continua | (asserts do teste) | `chat-agenda-api/diagnostico.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | A6 duplicata não vira duas ofertas (mesma chave) | (asserts do teste) | `chat-agenda-api/diagnostico.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | A7 formato de lista de objetos também é lido (variação da API) | (asserts do teste) | `chat-agenda-api/diagnostico.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | A8 limite de ofertas guardadas | (asserts do teste) | `chat-agenda-api/diagnostico.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | A9 procedimento sem integração: a conversa não vai para a API (pedidoDaApi nulo); vários exames também não | (asserts do teste) | `chat-agenda-api/diagnostico.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | A10 motivos técnicos viram resultados do registro (convênio sem tradução, plano inativo, limite, indisponível) | (asserts do teste) | `chat-agenda-api/diagnostico.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | A11 janelas de 15 dias seguidas (limite da API) não se sobrepõem | (asserts do teste) | `chat-agenda-api/diagnostico.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | período curto vira uma janela só; o início nunca é no passado | (asserts do teste) | `disponibilidade-vigia/vigia.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | período longo é cortado em janelas de 15 dias seguidas, no máximo 3 por rodada (cota) | (asserts do teste) | `disponibilidade-vigia/vigia.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | período que já terminou ou datas inválidas: nenhuma janela (a solicitação expira, não consulta a API) | (asserts do teste) | `disponibilidade-vigia/vigia.test.ts` | ✅ passou |
| A | Diagnóstico da resposta da API (TypeScript) | começa no futuro: a primeira janela começa na data inicial pedida | (asserts do teste) | `disponibilidade-vigia/vigia.test.ts` | ✅ passou |

## Regressão completa (`npm test`, script a script)

79 scripts da corrente rodados um a um (`rodar-tudo`), 77 passaram. Duração total ≈ 8 min.

| Script | Resultado | Observação |
|---|---|---|
| `test:retrato` | ✅ 10 de 10 verifica |  |
| `test:edge` | ✅  |  |
| `test:python` | ❌  | falta `pytest` neste ambiente (teste da biometria, não relacionado) |
| `test:sql` | ✅ 46/46 verifica |  |
| `test:delta` | ✅ 5/5 verifica |  |
| `test:saida-n8n-fila` | ✅ 8/8 verifica |  |
| `test:saida-n8n` | ✅ 7/7 verifica |  |
| `test:sw` | ✅ 16/16 verifica |  |
| `test:sentinela` | ✅ 14/14 verifica |  |
| `test:paciente-status` | ✅ 20/20 verifica |  |
| `test:nomes` | ✅ 28/28 verifica |  |
| `test:sql9` | ✅ 14/14 verifica |  |
| `test:espera` | ✅ 18/18 verifica |  |
| `test:cronometro-grupo` | ✅  |  |
| `test:convenio` | ✅ 20 de 20 verifica |  |
| `test:assuntos` | ✅ 21 de 21 verifica |  |
| `test:contas` | ✅  |  |
| `test:protecao` | ✅  |  |
| `test:login-sql` | ✅  |  |
| `test:meus-dados` | ✅ 15 de 15 verifica |  |
| `test:navegador` | ✅ 4/4 verifica |  |
| `test:convenios-painel` | ✅ 6/6 verifica |  |
| `test:catalogo-painel` | ✅  |  |
| `test:foto-pedido` | ✅ 3/3 verifica |  |
| `test:corrida` | ✅ 4/4 verifica |  |
| `test:historico` | ✅ 8/8 verifica |  |
| `test:sentinela-navegador` | ✅ 20/20 verifica |  |
| `test:login` | ✅  |  |
| `test:quadro` | ✅ 9/9 verifica |  |
| `test:lista-agrupada` | ✅ 5/5 verifica |  |
| `test:indicadores` | ✅ 28/28 verifica |  |
| `test:jornada` | ✅ 18/18 verifica |  |
| `test:pessoa-sql` | ✅ 54 de 54 verifica |  |
| `test:pessoa` | ✅ 24/24 verifica |  |
| `test:chegada-sql` | ✅  |  |
| `test:checkin-sql` | ✅  |  |
| `test:jornada-paciente` | ✅  |  |
| `test:identificar` | ✅  |  |
| `test:minha-vez` | ✅  |  |
| `test:medicos-sql` | ✅  |  |
| `test:medicos` | ✅  |  |
| `test:encerramento-sql` | ✅ 14 de 14 verifica |  |
| `test:agendado-sql` | ✅ 24 de 24 verifica |  |
| `test:encerramento` | ✅ 13/13 verifica |  |
| `test:despedida-sql` | ✅ 14 de 14 verifica |  |
| `test:despedida` | ✅ 4/4 verifica |  |
| `test:autoencerrar-sql` | ✅ 18 de 18 verifica |  |
| `test:avaliacao-sql` | ✅ 11 de 11 verifica |  |
| `test:avaliacao` | ✅ 9/9 verifica |  |
| `test:cabecalho` | ✅ 7/7 verifica |  |
| `test:voltar-sql` | ❌ 6/9 passaram | falhou na 1ª rodada (3 casos assumiam CPF depois do motivo); **ajustado ao fluxo real e reexecutado: 9/9** |
| `test:voltar` | ✅ 2/2 passaram |  |
| `test:reconhecer-sql` | ✅ 16 de 16 verifica |  |
| `test:ao-vivo-sql` | ✅ 18 de 18 passaram |  |
| `test:ao-vivo` | ✅ 3 de 3 passaram |  |
| `test:etapa0-sql` | ✅ 17 de 17 passaram |  |
| `test:indicadores-sql` | ✅ 20 de 20 passaram |  |
| `test:autoria-sql` | ✅ 5 de 5 passaram |  |
| `test:c1-sql` | ✅ 17/17 verifica |  |
| `test:c1` | ✅ 8/8 verifica |  |
| `test:estrutura-sql` | ✅ 13/13 verifica |  |
| `test:transferir-sql` | ✅ 9/9 verifica |  |
| `test:convenio-suspenso-sql` | ✅ 8/8 verifica |  |
| `test:vinculo-sql` | ✅ 8/8 verifica |  |
| `test:sino` | ✅ 3/3 verifica |  |
| `test:autoencerrar-zap-sql` | ✅ 15 de 15 verifica |  |
| `test:producao-sql` | ✅ 29 de 29 verifica |  |
| `test:ponta-a-ponta` | ✅ 19 de 19 verifica |  |
| `test:v2-modos` | ✅ 24 de 24 verifica |  |
| `test:v2-calendario` | ✅ 17 de 17 verifica |  |
| `test:v2-disponibilidade` | ✅ 24 de 24 verifica |  |
| `test:calendario-api` | ✅ 10/10 verifica |  |
| `test:marcado` | ✅ 4 de 4 verifica |  |
| `test:equipe-assume` | ✅ 9 de 9 verifica |  |
| `test:painel-recarga` | ✅ 4 de 4 verifica |  |
| `test:equipe-agora` | ✅ 5/5 verifica |  |
| `test:agendou-credito` | ✅ 6 de 6 verifica |  |
| `test:conferencia-sql` | ✅ 19 de 19 verifica |  |
| `test:carga` | ✅  |  |

Rodados à parte depois desta lista (entraram na corrente depois): `test:v2-agendamento` e `test:v2-rollback` (tabela acima).
