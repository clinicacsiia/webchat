# n8n: IA parando de responder e demorando (correção de 31/10/2026)

Fluxo `Triagem IA - Atendimento` (`wAbzjPqZNCztKriZ`), instância `clinicacsi.app.n8n.cloud`.
Versão publicada com a correção: `1ada4ac8-6cd6-44b8-84a9-5037e2da1de3`.

## O que acontecia

| Sintoma | Causa | Desde |
|---|---|---|
| A IA respondia **uma vez** e nunca mais | O nó "Salvar pré-agendamento" lia `$json`, mas desde que a checagem anti-duplicidade entrou no meio, `$json` passou a ser o histórico rechecado (sem `conversa_id`). A chamada ia sem `p_conversa`, o Supabase respondia **404** e o nó "Enviar resposta ao chat" forçava `transferir = true`: a IA era desligada na conversa logo na primeira resposta e nada era salvo no pré-agendamento | versão `4cb7b751` (30/10, 17:58) |
| Mensagem do paciente ficava **sem resposta** | A checagem anti-duplicidade comparava a última mensagem da conversa (de qualquer autor). Se outra execução respondia no meio, a execução da mensagem mais nova achava que "chegou coisa nova" e descartava a resposta | mesma versão |
| Qualquer falha passageira **encerrava o atendimento** | Falha da IA (fora do ar, JSON cortado) ou ao salvar virava transferência para humano, e a IA não volta sozinha | antes |
| **Demora** de 6 a 14 s por mensagem | Quase todo o tempo é o Claude (≈ 10 mil tokens de entrada por mensagem, com raciocínio); o resto são 4 chamadas ao Supabase e o nó de código | — |

## O que mudou

1. **Salvar pré-agendamento** lê `conversa_id`, `pre_agendamento` e `pronto` de `$('Ler resposta da IA')`.
2. **Enviar resposta ao chat**: falha ao salvar só vira aviso no resumo ("ATENÇÃO: falha técnica ao salvar..."); não desliga mais a IA.
3. **Ainda é a última mensagem?** compara a última mensagem **do paciente** no histórico rechecado com a mensagem que disparou a execução. Se o paciente mandou outra, só a execução mais nova responde (e responde às duas de uma vez); se a IA respondeu no meio, a resposta não se perde.
4. **Ler resposta da IA**: falha técnica pede ao paciente para reenviar a mensagem e a IA continua; só transfere se falhar de novo em seguida. A triagem simples (sem pré-agendamento) transfere depois de 15 falas do paciente (antes 10).
5. **Triagem com Claude**: cache do prompt de 5 minutos (`promptCaching: 5m`), que corta custo e um pouco do tempo nas mensagens seguidas da mesma conversa.
6. **Configuração do fluxo**: limite de 120 s por execução (uma execução travada não segura a fila do n8n Cloud).

Testado em produção em 31/10 com uma conversa de teste (`71900000077`, já encerrada): a IA continuou ativa depois da primeira resposta, o pré-agendamento foi salvo (etapa e plano) e duas mensagens enviadas juntas receberam uma resposta só, cobrindo as duas.

## Ao editar o fluxo

Os nós depois de "Ainda é a última mensagem?" recebem em `$json` o **histórico rechecado**, não a resposta da IA. Leia a resposta sempre com `$('Ler resposta da IA').first().json`.

## Ainda depende de decisão

- **Quando a IA transfere** (pré-agendamento pronto, urgência, pedido de humano), ela para de responder de propósito, e ninguém é avisado: o nó "Avisar equipe" não faz nada. Se ninguém olhar o painel (à noite, por exemplo), o paciente fica sem resposta. Falta escolher o canal (Telegram, WhatsApp ou e-mail) para avisar a equipe a cada transferência, e talvez uma mensagem automática de "recebemos, um atendente responde no horário de atendimento".
- **Velocidade**: o maior ganho seria trocar o modelo por um mais rápido (Haiku), com risco de a IA seguir pior as regras longas do prompt. Testar antes com conversas de teste.
- **Cota do n8n**: cada mensagem do paciente gera uma execução (mais uma por conversa nova). Conferir se o plano do n8n Cloud aguenta o volume do mês; se a cota acabar, a IA para de responder.
- **Execuções com sucesso não ficam salvas** (`saveDataSuccessExecution: none`); só as com erro. Para investigar um caso, ligue temporariamente em Settings do fluxo.
