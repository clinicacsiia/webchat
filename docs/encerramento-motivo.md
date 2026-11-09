# Motivo no encerramento (WC-03, 09/11/2026)

**Estado: pronto no repositório e testado. O SQL ainda NÃO foi aplicado no Supabase.**

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
1. Aplicar `supabase/encerramento-motivo.sql` (4 partes; cada uma roda em menos de 60 s).
2. Publicar o site (painel novo, `painel/sw.js` v6).
3. Usar por um dia e conferir a aba **Indicadores** e o **quadro**.
4. Ligar a chave.

Desfazer: voltar a chave para `nao` (imediato). As funções antigas estão em `cronometro-resposta.sql` (`conversa_antes_update`) e `00-base-snapshot.sql` (`conversa_status_mudou`).

## Testes
`cd testes && npm run test:encerramento-sql` (12 verificações) e `npm run test:encerramento` (5 verificações no navegador).
