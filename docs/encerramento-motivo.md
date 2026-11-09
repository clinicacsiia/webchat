# Motivo no encerramento (WC-03, 09/11/2026)

**Estado: pronto no repositório e testado. SQL aplicado no Supabase em 09/11/2026 (tudo desligado).**

## O que muda
- Ao tocar **Encerrar** no painel, a janela pede o **motivo** (lista fixa): Agendado, Apenas informações, Não respondido, Paciente desistiu, Outro motivo. Com cartão no quadro, a mesma janela pergunta também para onde o cartão vai.
- O banco guarda o motivo, quem encerrou e a origem (equipe, sistema ou inatividade) na conversa e **um registro por fechamento** em `conversa_encerramento` (reabrir e fechar de novo não apaga o histórico).
- O motivo aparece no topo da conversa e na lista de Encerradas. Conversas antigas mostram "sem motivo registrado".
- Quando o sistema encerra sozinho porque o exame foi resolvido, o motivo é **Agendado** e a origem é **sistema**.
- A regra de **exame em aberto** continua igual (a mudança dela é a tarefa WC-04).

## Chave (começa desligada)
Configurações > **Encerramento e avaliação** > "Exigir motivo ao encerrar" (`config.encerramento_exige_motivo`).
- `nao` (inicial): o motivo é opcional; o painel antigo em cache continua fechando conversas.
- `sim`: o banco recusa encerrar pelo painel sem motivo (erro `MOTIVO_OBRIGATORIO`). Sistema e motor não são barrados.

## Como colocar no ar
1. ~~Aplicar `supabase/encerramento-motivo.sql`~~ (feito em 09/11/2026).
2. Publicar o site (painel novo, `painel/sw.js` v6).
3. Usar por um dia e conferir a aba **Indicadores** e o **quadro**.
4. Ligar a chave.

Desfazer: voltar a chave para `nao` (imediato). As funções antigas estão em `cronometro-resposta.sql` (`conversa_antes_update`) e `00-base-snapshot.sql` (`conversa_status_mudou`).

## Testes
`cd testes && npm run test:encerramento-sql` (12 verificações) e `npm run test:encerramento` (5 verificações no navegador).

---

# Agendado confere a agenda (WC-04, 09/11/2026)

**Estado: pronto no repositório e testado. SQL aplicado no Supabase em 09/11/2026 (tudo desligado).** Arquivo: `supabase/encerramento-agendado.sql`. Depende do SQL do motivo acima.

## O que muda (decisão D2 aprovada; ajustada em 09/11/2026 à tarde)
- **Encerrar como Agendado nunca é recusado.** A atendente informa, o sistema aceita. (Antes recusava com "Não encontrei agendamento vigente…" e a atendente ficava sem conseguir encerrar.)
- Ao encerrar, o servidor procura um **agendamento vigente** da pessoa e guarda o resultado em `conversa_agendado_conferencia`:
  1. exame marcado pelo chat e ainda sem desfecho (`v_agendamento_aberto`); ou
  2. cartão do Klingo com exame **agendado/confirmado** ainda por vir, ligado por **prontuário confirmado** ou por **nome + telefone** (a mesma regra do fechamento automático).
- A rotina `agendado_vigiar` (a cada 5 min) **continua conferindo em segundo plano**:
  - achou → "confirmado" (se havia aviso, ele some);
  - não achou e passou o prazo (`config.agendado_conferir_prazo_min`, padrão 120 min) → **aviso** na conversa (selo da lista) e **push** à equipe: "não achei o agendamento no Klingo", "não consegui conferir (leitura do Klingo com problema)" ou "mais de um paciente possível";
  - depois de confirmado pelo Klingo: se o exame **sumir com mais de 2 h de folga** (cancelado/remarcado) ou a **data mudar**, avisa que mudou;
  - se o agendamento aparecer depois do aviso, o aviso some sozinho; para de acompanhar em 7 dias, ou depois do dia do exame.
- O push é genérico (sem nome) e só sai em horário de trabalho; o que ficou para depois sai na primeira rodada dentro do horário. O aviso na conversa aparece sempre.
- Reabrir a conversa apaga a conferência e o aviso que a rotina tinha posto.
- **Nenhuma regra de exame ou de Klingo barra o encerramento pela equipe** (decisão do dono, 09/11/2026: a escolha da atendente é prioridade). Exame marcado, em aberto ou já passado não impede nenhum motivo; a regra antiga `EXAME_EM_ABERTO` foi desligada no banco e no painel. O exame segue na Jornada e o Klingo fecha o desfecho sozinho. Única exigência que sobrou: escolher um **motivo** (`encerramento_exige_motivo`).
- No painel, a janela de encerrar sempre mostra os 5 motivos.

## Limite conhecido
A **unidade não é comparada** (o chat usa CSI/DESENVOAR e o Klingo usa CSI 1, CSI 2, CSI Pediatria). Quem protege contra cruzar pacientes é a identidade: pessoa unida, prontuário confirmado ou nome + telefone.

## Chave (começa desligada)
Configurações > Encerramento e avaliação > "Conferir a agenda ao encerrar como Agendado" (`config.encerramento_valida_agendado`). Ligue **depois** de "Exigir motivo". Desfazer: voltar para `nao` (nada é conferido) e `select cron.unschedule('agendado-vigia');`.

Testes: `npm run test:agendado-sql` (23 verificações) e `npm run test:encerramento` (8).

---

## Correção de 09/11/2026 (mesmo dia): "permission denied for table conversas"
Ao encerrar com motivo, o painel mostrou esse erro. Causa: o atendente só pode atualizar 3 colunas de `conversas` (status, agente_id, nao_lidas_agente) e a coluna nova `motivo_encerramento` não tinha permissão; além disso o gatilho não conseguia ler a chave `encerramento_exige_motivo` (o atendente não lê `config`), então a exigência de motivo estava, na prática, desligada para ele. Corrigido no banco (migração `encerramento_motivo_correcao_permissoes`) e em `supabase/encerramento-motivo.sql`. Novo teste: `sql-encerramento` agora roda como o papel `authenticated`, sem ler `config`. Conferido no banco real, como atendente e como paciente, em transação desfeita.

## Ajuste de 09/11/2026 (tarde): Agendado não é mais recusado
Uma atendente não conseguia encerrar como Agendado (a paciente tinha só um exame já atendido em 04/11 e nenhum exame futuro). O dono pediu que a mensagem saísse. Aplicado no banco (migrações `agendado_conferencia_parte1`, `parte2`, `parte4`, `parte5`) e a Edge Function `avisar-equipe` foi para a versão 1.2 (`tipo: 'agenda'`). As mensagens `AGENDADO_SEM_AGENDAMENTO`, `AGENDADO_AMBIGUO` e `AGENDADO_AGENDA_INDISPONIVEL` agora só viram o texto do aviso da conferência.

## Ajuste de 09/11/2026 (noite): a escolha da atendente é prioridade
O dono pediu que o atendente humano encerre sem cair em nenhuma regra por dados do Klingo. Além do Agendado, saiu o bloqueio `EXAME_EM_ABERTO` (banco: `conversa_exame_aberto_trg` só devolve a linha; painel: sem a trava antes da janela e sem a restrição de motivo; `painel/sw.js` v12). A conferência de Agendado continua em segundo plano, só avisando. Para voltar a barrar exame em aberto: definição antiga em `supabase/pessoa-unica.sql`.
