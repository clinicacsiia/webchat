# Tela do teste (v20261125a) no piloto, marcando de verdade

Versão 1.2 — 27/11/2026 / Mudança: **pedido vence em 24 h no servidor**, lista completa de médicos (cadastro das agendas), pedido do piloto gravado no painel e a mesma mudança na cópia do teste (ver a última seção). Versão 1.1 — 27/11/2026: calendário em verde, médicos de referência e pop-up de ciência. Versão 1.0 — 25/11/2026: primeira fase construída e publicada; ligada só com `marcacao_etapas_modo = 'teste'` e só para os telefones de `marcacao_etapas_telefones`.

## O que é
A tela do ambiente de teste (`painel/testedowebchat/`: `marcacao.js`, `marcacao.css`, `agenda-real.js`) foi copiada para a raiz do site e ligada ao **motor real** do banco por `integracao-real.js`. A tela é a mesma do teste (mesma ordem: pagamento, convênio, plano, carteirinha, consulta, médico, horário, condições, resumo). Só mudou o fim: no "Confirmar marcação", `marcar()` conduz o motor (consulta, médico, plano, horário, confirmar) com as travas de sempre (PIN, retorno em menos de 30 dias, unidade autorizada, médico escolhido nunca trocado).

Quando o motor pergunta algo que a tela do teste não sabe responder, **a conversa continua na tela por etapas (`etapas.js`), na mesma conversa**, sem perder nada.

## Como ligar e desligar
- Ligar: `update public.config set valor = 'teste' where chave = 'marcacao_etapas_modo';`
- Voltar para a tela por etapas de produção: valor `piloto`. Voltar ao chat de sempre: `nao`.
- Os telefones do piloto ficam em `marcacao_etapas_telefones` (hoje só o do dono).

## O que funciona na fase 1
- Tela e ordem iguais ao teste; horários e médicos reais do Klingo (leitura).
- Marcação real pelo motor quando o cadastro está completo, o plano é Particular ou convênio da lista e o horário ainda existe.
- Voltar na primeira pergunta e "Fazer outra marcação" levam ao menu principal.
- "Acompanhar" abre "Acompanhe seus pedidos" (`minha-vez/?acompanhar=1`), onde o cancelamento real já existe.

## Feito na fase 2 (25/11/2026)
- **Pré-marcação real** pela tela do teste: a ciência é gravada no servidor (`marcacao_ciencia_registrar`) e o motor recebe "Não sei" (convênio ou plano), "Nenhum horário serve" ou "Não tenho a carteirinha agora", levando o pedido para a equipe. "Não, obrigado" vira pedido de atendente.
- **Foto da carteirinha** enviada à conversa (`chat_anexo_enviar`) quando a pessoa anexa.
- **Valor Particular**: a tela do teste mostra o valor do motor, com "Concordo e quero marcar" e "Não quero".
- **Cancelar e remarcar**: "Acompanhar" abre "Acompanhe seus pedidos", que já cancela e remarca de verdade. O "remarcar até 2 vezes" e o "Completar agora" simulados do teste não existem aqui.

## Pendências (anotadas)
1. **Dados do cadastro** (endereço, contato, sexo) quando faltam: a tela por etapas assume. A tela do teste não tem essas perguntas.
2. **Previsão de marcação** (perguntas de turno, período e antecedência que o motor faz depois da pré-marcação): a tela por etapas assume.
3. **Leituras abertas**: a tela usa `teste-agenda-klingo` e `teste-planos-klingo` (funções abertas, só leitura) para listar médicos, horários e planos antes de existir a marcação. Trocar por `chat-agenda-api`/`chat_horarios` exige conduzir o motor passo a passo durante as perguntas, não só no fim. **Não apagar essas funções antes.**
4. **Antecedência de 24 h e política de cancelamento** do teste valem só como filtro e texto da tela; o motor tem as suas regras. Conferir se coincidem.
5. **Retrato do banco** (`supabase/producao/`) não foi refeito para `marcacao_etapas_pode`, `marcacao_ciencia_registrar`, `chat_config` e a tabela `marcacao_ciencia` (procedimento em `supabase/producao/LEIAME.md`, `parcial.py`).
6. **Teste contra o banco real**: só foi feito com o motor simulado e com a tela em página isolada. A primeira marcação e a primeira pré-marcação reais são o teste de verdade.

## Calendário em verde, médicos de referência e pop-up de ciência (27/11/2026, chat 2026.11.27-1, sw v93)
Só `marcacao.js`, `marcacao.css`, `integracao-real.js`, `index.html` e `sw.js`. **Nenhuma mudança de banco.** A cópia do teste (`painel/testedowebchat/`) **não** foi alterada.
- **Calendário:** nas etapas *Horário* e *Preferências* os dias com horário real aparecem em **verde** num calendário mensal, com filtros (Manhã, Tarde, dias da semana), botão "Ir para o dia mais próximo", setas para passar de dia em dia e de mês em mês. Sem nenhum horário, a tela segue como antes (período e dias da semana).
- **Médicos:** o Klingo devolve "sem médico credenciado" para alguns planos (medido em 27/11/2026: Amor Saúde/PERNAMBUES, consulta com pediatra, 0 horários; Particular: 162 horários e 10 médicos). Antes a lista vinha vazia e a tela dizia "agendada pela equipe". Agora, se o plano não devolve médico, mostra os médicos da consulta pelo Particular, com a nota "a equipe confere se atendem o seu convênio e plano". Também na tela "Sem horário pelo site". A mesma regra vale para os horários da etapa *Preferências*.
- **Médico escolhido chega ao motor:** `confirmar()` não enviava `medico`/`medicoNome`, então o motor sempre recebia "Tanto faz". Agora envia; com "Tanto faz" e horário escolhido, pede o(a) médico(a) daquele horário. Na pré-marcação, se o nome não existir na lista do motor, vale "Tanto faz".
- **Pop-up de ciência:** ao tocar em "Sim, quero a pré-marcação" abre um pop-up com o prazo (`prazo_pre_horas`, 24 h), o que a equipe vai confirmar e "não garante o horário"; marcar "Li as regras e estou ciente" liga o botão vermelho e **um toque** registra a ciência e já avança. Voltar/Esc desfaz o "Sim". O botão vermelho antigo só aparece se a pessoa voltar sem ter dado ciência.

### Segunda rodada (27/11/2026, mesma versão do chat 2026.11.27-1, painel v82): vencimento de 24 h, médicos do cadastro, cópia do teste
- **O pedido vence em 24 h, no servidor.** `supabase/pre-marcacao-vencimento.sql` (aplicada em 5 partes: `pre_marcacao_vencimento_parte1_prazo`, `parte2_registrar`, `parte3_vencer`, `parte4_rotina`, `parte5_medicos`). O prazo vem de `config.pre_marcacao_prazo_horas` (24) e **não** do aparelho (só a página de teste, que tem o seletor da diretoria, pode escolher de 12 a 72 h). A rotina `pre-marcacao-vigia` (a cada 10 min) chama `pre_marcacao_vencer()`: pedido `aguardando_equipe` com prazo passado vira `vencido`; se estava na fila "novo" sai dela (descartado, com anotação); se a equipe já estava "em contato" fica na fila dela. Resolvido, descartado, marcado e contato por WhatsApp não são tocados. Pedido vencido **não reabre** (o aparelho que tenta atualizar é ignorado). Para mudar o prazo: `update public.config set valor = '48' where chave = 'pre_marcacao_prazo_horas';`
- **Texto para o paciente** (pop-up, tela da pré-marcação e tela final): "O seu pedido fica guardado por 24 horas. Só seguimos com ele no sistema da clínica depois que você mandar todos os arquivos que faltam (fotos e documentos). Passado o prazo, o pedido vence e você faz um novo." (o texto diz "sistema da clínica" e não "Klingo", que o paciente não conhece).
- **O piloto grava o pedido no painel.** Ao concluir uma pré-marcação, `integracao-real.js` chama `pre_marcacao_registrar` com `origem = 'piloto'` (sem foto da carteirinha). A aba **Pré-marcação** do painel mostra o selo "Piloto", o prazo e "Prazo vencido". A conversa na equipe continua como antes. **Dado novo guardado no banco:** nome, telefone, e-mail, consulta, convênio e plano do pedido (mesma tabela e mesma regra de acesso da página de teste: só admin e atendente leem). Os termos de privacidade ainda não citam isso (`docs/lgpd.md`).
- **Todos os médicos da consulta.** Nova função `consulta_medicos(p_procedimento_id)` (só nomes, vinda do cadastro das agendas `catalogo_agenda`, só unidades que marcam sozinhas, sem médico bloqueado; executável pelo público, como o cardápio). A tela junta esses nomes aos médicos que o Klingo mostra: o médico que atende a consulta aparece mesmo sem horário nos próximos 45 dias. Medido em 27/11/2026: pediatra tem 9 médicos no cadastro. Médico do cadastro sem horário entra como "preferência" na pré-marcação; na marcação real só entram médicos com horário.
- **Cópia do teste** (`painel/testedowebchat/`): `marcacao.js`, `marcacao.css` e `integracao-simulada.js` receberam as mesmas mudanças (calendário, médicos, pop-up, texto das 24 h). Os testes novos são `npm run test:pre-marcacao-vencimento` (banco, 20 casos) e `npm run test:marcacao-tela` (navegador, 30 casos em cada uma das duas telas).
- **Ainda não existe:** o paciente **completar** a pré-marcação pelo celular dentro das 24 h (o piloto não tem "Completar agora"; quem recebe os arquivos é a equipe, pela conversa). O vencimento só protege a fila da equipe.
