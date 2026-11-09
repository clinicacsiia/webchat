# Encerramento automático após 24 h sem resposta do paciente (WC-08, 09/11/2026)

**Estado: pronto no repositório e testado. SQL aplicado no Supabase em 09/11/2026 (tudo desligado).** Arquivo: `supabase/autoencerrar.sql` (depois de `encerramento-motivo.sql` e `despedida.sql`). Começa **desligado**.

## Regra (decisão D3)
- O relógio começa quando uma **pessoa da equipe** escreve numa conversa **em atendimento** e o paciente não responde. Mensagem do **assistente automático** e mensagens de sistema **não contam**. Nova mensagem da equipe **reinicia** as 24 h. Mensagem do paciente **zera**.
- 24 horas **corridas** (relógio do servidor). Prazo em `config.autoencerrar_horas` (24).
- Fecha com motivo **Não respondido**, origem **inatividade**; o paciente recebe a **despedida** (a mesma de qualquer encerramento, uma vez só).
- **Nunca** fecha: conversa com **exame em aberto** ou **remarcação pendente**; **pessoa unida** em que alguma conversa aberta ainda não venceu (ou está aguardando atendimento); conversa **antiga sem marco** (anterior a esta atualização).
- Reabrir/assumir/encerrar limpam o prazo anterior, então uma conversa reaberta não fecha logo em seguida.
- O fechamento é **uma instrução atômica** que reconfere estado e prazo; duas rotinas ao mesmo tempo não fecham duas vezes (trava) e uma resposta no meio do caminho invalida.

## Chave e rotina
- `config.autoencerrar_modo`: `desligado` (nada), `simulacao` (só conta e registra), `ligado` (encerra). Em **Configurações > Encerramento e avaliação** há o seletor e a contagem ("seriam encerradas agora").
- Rotina `autoencerrar-vigia` (pg_cron, a cada 5 minutos). O que a rotina fez fica em `autoencerramento_execucao`; as conversas que ela fechou, em `autoencerramento_fechada` (só id técnico).

## Como ligar
1. Aplicar o SQL. 2. Publicar o site. 3. Modo **Simulação** por alguns dias e olhar a contagem. 4. Modo **Ligado**.

Hoje há 34 conversas em atendimento. Como as conversas anteriores não têm marco, **só passam a contar as que receberem mensagem da equipe depois do SQL**.

## Desfazer
- Parar: modo `desligado` (imediato) ou `select cron.unschedule('autoencerrar-vigia');`.
- Fechamento indevido: `select * from autoencerramento_fechada order by fechada_em desc;` e use **Reabrir** no painel, uma a uma (nunca em massa).

## Testes
`npm run test:autoencerrar-sql` (18 verificações) e `npm run test:encerramento` (11, painel).
