# Primeira consulta com a médica: só com atendente (16/11/2026)

**Regra (pedido do dono):** quem nunca foi atendido pela médica não marca sozinho pelo chat. O chat avisa, passa a conversa para a atendente e **não marca nada**. Quem já foi atendido por ela marca sozinho, como hoje. Se o Klingo não mostra o atendimento anterior, a atendente aperta **Liberar autoatendimento** na conversa.

## Como ligar (Configurações > "Primeira consulta com a médica")
- `primeira_consulta_modo` = sim/nao. **Nasce `nao`**: nada muda até o dono ligar.
- `primeira_consulta_medicas`: nome como aparece no Klingo (coluna Profissional); mais de uma, separadas por `;`. Hoje: `GEANNE CHRISTINA PINHEIRO` (neuropediatra da Desenvoar, a única "NEUROLOGIA" do catálogo).
- Desligar volta tudo ao normal na hora.

## Como decide (`primeira_consulta_ok`)
1. Só vale para **consulta** e só se a médica escolhida (ou, no "tanto faz", qualquer médica oferecida) estiver na lista. Outra médica: marca como hoje.
2. Libera se: a atendente liberou nesta conversa, ou liberou antes (`primeira_consulta_liberada`, chave = hash de CPF + nascimento), ou o paciente tem atendimento com a médica em `consulta_feita`.
3. Senão: bloqueia. Duas travas: `fluxo_proximo` (logo depois de escolher o médico, avisa cedo) e `klingo_pode_marcar` (segunda trava, motivo `primeira_consulta`).

## De onde vem o histórico
- **Relatório #14637** (criado pelo dono): Data do Atendimento, Primeira Vez, Nome, Profissional, CPF, Prontuário, Nascimento. Aceita datas passadas. Lido pela Edge Function **`sync-atendimentos-klingo`** (a cada 10 min em horário de expediente: anteontem, ontem e hoje; faixas de 14 dias; o nome do paciente nunca é lido). Grava só o **hash** de CPF + nascimento (mesma conta de `klingo_dados_conversa`), o prontuário, o profissional e o dia, em `consulta_feita`.
- Carga do passado: `select public.consulta_atendida_disparar('2026-05-01', '2026-11-01');` (até 400 dias por chamada; o resultado só tem contagens).
- **O histórico do Klingo só existe a partir de maio/2026** (antes o relatório volta vazio). Em 16/11/2026: 11.704 atendimentos, 9.542 pacientes; com a médica: 279 pacientes desde 01/09/2026. Quem foi atendido por ela antes disso aparece como "primeira vez": a atendente libera à mão.
- Reserva: o #14359 (coluna **Profissional**, col21) também alimenta `consulta_feita` pelo prontuário (`sync-jornada-klingo` v1.6). Esse relatório só devolve datas passadas se o filtro "marcado em" (periodo2, até 360 dias) for enviado junto (modo `historico`); o Klingo recusa (erro ".") períodos maiores que ~12 meses.

## Privacidade
`consulta_feita` e `primeira_consulta_liberada` têm RLS ligada, sem política, fechadas para o público. CPF nunca é guardado (só o hash com o sal do cofre). Nada de nome de paciente.

## Arquivos
`supabase/primeira-consulta-parte1..6-*.sql` (fluxograma, versão e rollback no cabeçalho), `testes/sql-primeira-consulta.test.mjs` (`npm run test:primeira-consulta`), Edge Functions `sync-atendimentos-klingo` e `sync-jornada-klingo`, painel (grupo em Configurações e botão **Liberar autoatendimento** na conversa transferida).

## Rollback
`update public.config set valor = 'nao' where chave = 'primeira_consulta_modo';` (desliga). Rotina: `select cron.unschedule('consulta-atendida-sync');`.
