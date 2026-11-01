# Uma pessoa, uma conversa; exame em aberto; falta e remarcação pelo chat (01/11/2026)

**Estado: pronto no repositório e testado em banco e navegador simulados. NÃO foi aplicado no Supabase.** Nada aqui muda o banco real até você rodar os dois arquivos SQL (seção "Como ligar").

Arquivos:

| Arquivo | O que faz |
|---|---|
| `supabase/pessoa-unica.sql` | Agrupamento das conversas da mesma pessoa, exame em aberto, desfechos, perguntas ao paciente e os passos novos do motor |
| `supabase/pessoa-unica-jornada.sql` | Liga o cartão do Klingo à pessoa do chat; remarcar falta pelo chat; fecha sozinho o exame que o Klingo já resolveu |
| `painel/index.html` | Atendimento e Jornada mostram uma pessoa por vez |
| `testes/sql-pessoa.test.mjs` | 48 verificações no Postgres embutido, com as funções reais do motor |
| `testes/pessoa.navegador.mjs` | 21 verificações no navegador (Supabase simulado) |

## 1. Quando duas conversas são da mesma pessoa

Regra: **3 informações**. O **nome** tem de conferir e **mais duas** destas têm de bater: telefone, e-mail, data de nascimento, conta de login. Exemplos que juntam sozinhos: nome + telefone + e-mail; nome + e-mail + nascimento (telefones diferentes).

| Situação | O que acontece |
|---|---|
| 3 informações batem | Une sozinho. O painel mostra "N conversas unidas" |
| Só 2 (nome + telefone, por exemplo) | **Sugestão**: no alto da lista aparece "Parece a mesma pessoa". Um atendente toca "É a mesma pessoa" (é a terceira informação, fica registrado quem confirmou) ou "Não é" (nunca mais é sugerido) |
| Algo se contradiz (nascimentos diferentes, contas de login diferentes, "para mim" contra "para meu filho") | Não une, nem a equipe consegue forçar. Se a contradição aparece **depois** (a data de nascimento chega mais tarde), a conversa sai do grupo sozinha |
| Mãe e filho no mesmo telefone e e-mail | **Nunca se juntam**: o nome comparado é o do paciente (o filho, no atendimento "para meu filho") |
| Nomes diferentes no mesmo telefone (família) | Não une |

**O que "unir" faz e não faz**
- É só uma **ligação**: nenhuma mensagem é movida ou apagada. Dá para **separar** uma conversa ("Não é a mesma pessoa" na faixa azul do chat); o robô não junta de novo.
- Na lista e no quadro, a pessoa aparece **uma vez**. Ao abrir, as mensagens das conversas aparecem juntas, em ordem de horário, com um aviso "Outra conversa da mesma pessoa" na troca.
- **A resposta da equipe vai para a conversa onde o paciente escreveu por último** (é a que o aparelho dele está lendo). Assumir, transferir e encerrar valem para todas as conversas da pessoa.
- Os contadores (Aguardando, Meus, Abertas) contam **pessoas**.
- O paciente não vê nada diferente e **nunca recebe o histórico de outra conversa**: a ligação é só da equipe. (Por isso o chat não "devolve" a conversa antiga a quem digita nome e telefone: isso entregaria o histórico a qualquer um.)

## 2. Exame marcado fica em aberto até alguém fechar

Quando o pré-agendamento vira **Agendado**, o exame fica **em aberto**: aparece na linha da lista ("Exame em aberto"), numa faixa amarela dentro da conversa e no cartão do quadro. Enquanto estiver em aberto, **a conversa não pode ser encerrada** (o painel avisa; o banco também recusa, para quem usa o painel).

Quem fecha:
1. **A equipe**, na faixa amarela: **Compareceu**, **Faltou**, **Cancelou** ou **Remarcou**.
2. **O paciente, pelo chat**: a equipe toca **Perguntar ao paciente pelo chat** e o paciente recebe quatro botões ("Fui e fiz o exame", "Não consegui ir", "Quero cancelar", "Quero remarcar para outro dia"). Também entende quem **digita** ("não fui", "quero cancelar", "fui sim").
3. **O Klingo, sozinho** (a cada 10 minutos): se o cartão do Klingo bate em 3 informações (nome + telefone + o mesmo dia) e o horário passou há mais de 1 hora, fecha como `compareceu` (atendido), `faltou`, `remarcou` ou `cancelou`. Sem as 3 informações, não faz nada.

O que o paciente informa é registrado com a origem **paciente**; o que o Klingo informa, **klingo**; o resto, **equipe**. "Compareci" e "Quero cancelar" ainda passam pela equipe (aviso na conversa): o chat não cancela nem confirma nada no Klingo, que só permite leitura.

## 3. Faltou: remarcar

Uma falta (marcada pela equipe, pelo paciente ou vinda do Klingo) vira **remarcação pendente**: faixa vermelha "Faltou" na conversa, selo "Remarcar" na lista, e na Jornada o cartão "Faltou" ganha a seção **Faltou: remarcar**.

| Quem | O que faz |
|---|---|
| Equipe remarca por fora (Klingo, telefone) | **Já remarcado** (fecha) ou **Paciente desistiu** |
| Equipe pede ao paciente | **Pedir ao paciente que remarque pelo chat**: ele recebe "Quer remarcar agora por aqui?" com 3 botões |
| Paciente toca **Sim, remarcar agora** | O pedido da marcação que falhou é **copiado** (exame, convênio, dados) e ele segue sozinho: dados que mudaram > calendário com os horários livres > confirmação. A equipe recebe o pedido pronto no fim, como em qualquer agendamento. Quando a equipe marcar o novo horário, a remarcação fecha sozinha ("feita") |
| Paciente toca **Prefiro falar com um atendente** ou **Não quero remarcar** | Registra a decisão e avisa a equipe |

- Se o pedido não puder ser copiado (o paciente já está montando outro pedido; ou a falta veio do Klingo, que não traz o código do exame do catálogo), ele **escolhe o exame de novo** e segue o mesmo caminho.
- A pergunta vai para a conversa mais recente da pessoa. Em conversa **sem o assistente automático** (motor `ia`), vai só uma mensagem de texto.

## 4. Jornada

- **Um cartão por paciente** (alternador na barra; a escolha fica guardada no aparelho). Fica o cartão que pede ação agora (falta, chegou/em atendimento, a confirmar...), com "+N da mesma pessoa". Ao abrir, aparecem os outros cartões da pessoa, cada um com **Abrir**.
- Cartão do Klingo ↔ conversa do chat: nome + a mesma marca de telefone que a Jornada já usa + **mesmo dia de uma marcação feita no chat** = une sozinho. Só nome + telefone = "Mesma pessoa do chat?" com o botão **É a mesma pessoa** (fica registrado; dá para **Desfazer**).
- Quem não tem conversa no chat não tem como receber mensagem: o cartão manda **ligar** (a tarefa "Ligar e oferecer nova data" continua existindo).

## 5. Como ligar (ordem)

1. Aplique `supabase/pessoa-unica.sql` e depois `supabase/pessoa-unica-jornada.sql` (SQL Editor ou migração). Pré-requisitos: `pacientes.sql`, `fase7-motor.sql`, `correcao-convenio-quem-volta.sql`, `assuntos-resolvidos.sql`, `login-paciente.sql`. Cada remendo nas funções do motor aparece **uma vez**; se o banco tiver uma versão diferente, o arquivo **para sem alterar nada** (foi testado).
2. Junte o que já existe: `select public.pessoa_agrupar_pendentes();` (a rotina `pessoa-agrupar` repete isso a cada 5 minutos). Em seguida, no painel, confira as sugestões.
   Conferido em 01/11/2026, só leitura, no banco real: os 4 trechos que o arquivo remenda (`fluxo_proximo`, `fluxo_perguntar`, `fluxo_aplicar`, `fluxo_ler_texto`) aparecem exatamente uma vez; nenhuma tabela, função ou rotina nova já existia; as 6 funções de que ele depende estão lá.
3. Publique o `painel/index.html`. **Sem o SQL, o painel continua funcionando como antes** (testado): cada conversa na sua linha, sem faixas novas.
4. Conferir que está vivo: `select jobname, schedule, active from cron.job where jobname in ('pessoa-agrupar','agendamento-klingo');` e `select count(*) from public.conversa_grupo;`.

**Voltar atrás:** `select cron.unschedule('pessoa-agrupar'); select cron.unschedule('agendamento-klingo'); drop trigger pessoa_agrupar_conversa on public.conversas; drop trigger pessoa_agrupar_pre on public.pre_agendamentos; drop trigger conversa_exame_aberto on public.conversas;` (as tabelas ficam; nada é apagado). Para desfazer um grupo à mão: `delete from public.conversa_grupo where grupo_id = '...';`.

## 6. Limites conhecidos

- **O paciente só vê a pergunta quando abre o chat** (ou se o aparelho estiver com o chat aberto). Não existe canal de aviso (WhatsApp, SMS, e-mail) ainda: depende de `docs/pendencias-e-dependencias.md`, itens C6 e D2. Enquanto isso, a equipe pode ligar ou chamar pelo link do WhatsApp do contato.
- **Exame em aberto só existe para o que foi marcado pelo chat** (pré-agendamento "Agendado"). Marcação feita direto no Klingo, sem chat, não entra na lista de "em aberto" (ela aparece na Jornada com os status do próprio Klingo).
- O arquivamento automático do cartão "Agendado (veio do chat)" da Jornada, 3 dias depois, não considera o exame em aberto. A pendência continua visível no Atendimento (selo "Exame em aberto", conversa que não encerra).
- A lista do Atendimento carrega as 300 conversas mais recentes. Uma pessoa com conversa mais antiga que isso aparece só com as que foram carregadas.
- "Compareci" informado pelo paciente fecha o exame, mas a equipe pode conferir no Klingo. O sistema não escreve no Klingo.
- Não testado com o Supabase real, o Realtime nem pessoas de verdade (só com Postgres e navegador simulados).

## 7. Automação completa (01/11/2026): o que muda sozinho

Instalador único: `supabase/aplicar-automacao.sql` (pessoa-unica + pessoa-unica-jornada + automacao-sistema). **Aplicar de uma vez no SQL Editor**: a ferramenta de migração pede confirmação por causa dos `delete` das funções de grupo e expira.

- **Klingo muda o status -> o chat acompanha na hora** (gatilho em `jornada_exame`; a rotina de 10 minutos fica como reserva). Só vale com 3 informações (nome + marca do telefone + o mesmo dia).
  - *atendido*: fecha o exame em aberto como "compareceu" **na hora**; *faltou, remarcado, cancelado*: depois que o horário passou há mais de 1 hora.
  - Sem exame em aberto e sem remarcação pendente, a **conversa se encerra sozinha**. Se um atendente está falando com o paciente (`em_atendimento`), ela **não** é encerrada: ganha o aviso "Exame concluído e conferido no Klingo. Pode encerrar a conversa.".
  - *faltou*: fecha o exame, mas a conversa fica aberta (a remarcação está pendente).
- **Portal do paciente em tempo real**: `jornada-tempo-real.sql` (**já aplicado**) avisa os portais abertos quando o status de um exame ou a etapa da visita muda; a tela se atualiza sem esperar os 15 s.
- **Fila identifica sozinha** (`fila_identificar_todos`, aba Fila): "Paciente já cadastrado" (telefone ou e-mail **e** nome batem), "Talvez já cadastrado: confira o nome" (mesmo telefone, nome diferente: família), "Paciente novo"; quantas conversas da pessoa existem no chat (e se há atendimento em andamento); **exame pendente** (marcado pelo chat, horário já passou, ninguém registrou como foi); e os exames de hoje no Klingo com o status.
- Limites: o paciente não recebe mensagem automática de "exame concluído" (falta canal, itens C6/D2); marcação feita direto no Klingo, sem chat, só aparece na Jornada.
