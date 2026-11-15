# Check-in do Klingo na tela "Minha vez" (15/11/2026)

Versão 1.0 — 15/11/2026 / Mudança: primeira versão. Banco `supabase/checkin-klingo.sql` (aplicado como `checkin_klingo_p1..p4`), leitura `sync-jornada-klingo` v10, tela `minha-vez/index.html`, testes `testes/sql-checkin-klingo.test.mjs`, `testes/minha-vez-etapas.navegador.mjs`, `supabase/functions/sync-jornada-klingo/mapa.test.ts`.

## O que a pessoa vê
Quem toca em **Cheguei** e tem exame hoje no Klingo vê o cartão **"Você está na clínica"**: a senha, e para cada exame o **número da marcação**, a hora e a etapa:

| Etapa na tela | De onde vem |
|---|---|
| **Aguardando a recepção** | marcação de hoje, sem check-in e sem atendimento aberto (`ok` 2 ou 3) |
| **Chegada registrada às HH:MM** | `Check-In - Data` (col18 do #14359) **no dia do exame**, ou o cartão da Jornada em "chegou" (`ok` 4) |
| **Em atendimento** | `Atendido = S` (o Klingo **abriu o atendimento**; o relatório não traz hora de início nem de fim do exame) (`ok` 5) |

O **número da marcação** é o "Id da Marcação" do #14359 (`m123` vira `123`). A recepção digita esse número no Klingo e acha a pessoa. Pedidos do chat (`ite:…`) não têm número e não aparecem no cartão. O lugar na fila só volta quando **não há exame de hoje** (ou com `MOSTRAR_POSICAO_COM_EXAMES = true` em `minha-vez/index.html`). "É a sua vez!" não mudou (continua o clique da recepção em Chamar).

## Como o dado chega
1. `sync-jornada-klingo` (a cada 30 s) lê o #14359 **pelo título das colunas** e manda cada linha ao banco com a chave `k` (check-in, `AAAA-MM-DD HH:MM:SS`, hora de Brasília). Formato real conferido com dias passados (1.182 de 2.009 marcações de 9 a 14/11 tinham check-in). Chave `k` ausente = leitura antiga, não mexe; `k` vazio = sem check-in (limpa, como no Klingo).
2. `jornada_klingo_lote` grava em `jornada_exame.checkin_em`. Só vale como chegada se for **no dia do exame** (41 marcações de 09/11 a 14/11 tinham check-in de data anterior ao exame).
3. `app_pedido_dados` (acesso rápido com PIN) e `paciente_jornada` (conta antiga) devolvem `voucher` e `chegada` por exame; a tela desenha.

O resumo de cada leitura (`jornada_sync_estado.klingo_resultado`) ganhou `checkin_lidos`, `checkin_invalidos` e `checkin_ignorado`. Se a coluna do check-in vier estranha (20 ou mais valores que não são data e mais de 20% do total), a leitura **não manda `k`** e o resto da Jornada segue.

## O que conferir na segunda-feira (16/11/2026), depois das primeiras chegadas
1. `select klingo_resultado from jornada_sync_estado`: `checkin_lidos` maior que 0, `checkin_invalidos` = 0, `checkin_ignorado` = false, `klingo_erro` vazio.
2. `select count(*) from jornada_exame where checkin_em is not null` cresce ao longo do dia.
3. Pedir a **primeira paciente com PIN** que toque em Cheguei e conferir na tela o cartão com o número da marcação e, depois que a recepção fizer o check-in no Klingo, "Chegada registrada às …" em até 1 minuto.
4. **Provar que o número da marcação do relatório é o mesmo do voucher da API** (hoje só há indício: o relatório vai de 2.643 a 27.234 e os vouchers de teste da API de 12/11 eram 26.638 e 26.641). Ao fazer o primeiro check-in de teste pela API, conferir que o `id` do voucher é o mesmo número que a recepção vê no Klingo.

## Fica de fora (de propósito)
**O botão Cheguei ainda NÃO registra o check-in no Klingo pela API (`POST /checkin`).** Hoje a chegada continua sendo registrada pela recepção, que acha a pessoa pelo número da marcação que a tela mostra, e a tela passa a "Chegada registrada" sozinha (leitura de 30 s). Ligar o `POST /checkin` exige:
- um teste real com uma marcação **de hoje** (o Klingo recusa check-in de outro dia) e o seu OK, porque ele mexe na agenda real e a recepção vê a chegada; o `DELETE /checkin` e a resposta do check-in expresso também nunca foram testados;
- ligar a pessoa do acesso rápido (celular + PIN + nascimento) ao cadastro do Klingo com segurança: o login na API aceita qualquer id só com a chave da clínica (risco documentado no `GUIA-COMPLETO.md`), e o prontuário do relatório não é o id da API. O caminho seguro é CPF + nascimento conferidos (como em `klingo-identificar`) e a operação passar pelo mesmo desenho das outras operações automáticas (`klingo_operacao`), com chave de desligamento (`klingo_api_*`), voucher achado por `GET /vouchers` e identidade conferida antes e depois.
Quando você quiser, isso se faz numa segunda-feira de manhã, com uma paciente de teste e a recepção avisada.
