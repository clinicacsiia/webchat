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

## O que muda (decisão D2 aprovada)
- Ao encerrar como **Agendado**, o servidor procura um **agendamento vigente** da pessoa:
  1. exame marcado pelo chat e ainda sem desfecho (`v_agendamento_aberto`); ou
  2. cartão do Klingo com exame **agendado/confirmado** ainda por vir, ligado por **prontuário confirmado** ou por **nome + telefone** (a mesma regra do fechamento automático).
- Se não acha, a conversa **fica aberta** e a mensagem diz o motivo: **sem agendamento**, **mais de um paciente possível** ou **leitura do Klingo atrasada** (mais de 15 min ou com erro). Apenas informações continua possível.
- Exame **ainda futuro** deixa de bloquear o encerramento, **só** com o motivo Agendado. Exame que já passou e os outros motivos continuam bloqueados (`EXAME_EM_ABERTO`). O exame segue na Jornada e o Klingo fecha o desfecho sozinho.
- No painel, com exame futuro a janela mostra só "Agendado" e explica.

## Limite conhecido
A **unidade não é comparada** (o chat usa CSI/DESENVOAR e o Klingo usa CSI 1, CSI 2, CSI Pediatria). Quem protege contra cruzar pacientes é a identidade: pessoa unida, prontuário confirmado ou nome + telefone.

## Chave (começa desligada)
Configurações > Encerramento e avaliação > "Conferir a agenda ao encerrar como Agendado" (`config.encerramento_valida_agendado`). Ligue **depois** de "Exigir motivo". Desfazer: voltar para `nao`.

Testes: `npm run test:agendado-sql` (14 verificações) e `npm run test:encerramento` (8).
