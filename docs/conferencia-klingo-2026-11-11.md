# Conferência com o Klingo: por que quase tudo virava alerta (11/11/2026)

Dados reais (só contagens): 31 pré-agendamentos "agendado" estavam como **sumiu do Klingo**; 27 deles tinham sido reconhecidos direto do Klingo (`klingo-reconhecer`).

## Causa 1: alerta falso de "sumiu" (`sync-catalogo-klingo/conferencia.ts`)
O reconhecimento grava o horário com a **unidade em nome curto** (ex.: "DESENVOAR") e, em geral, **sem médico** (o relatório #13825 não traz médico). A conferência seguinte (relatório #7) exigia médico e unidade **idênticos**, então nunca achava a marcação e, na 2ª rodada, marcava "sumiu".
Correção: médico vazio não restringe; unidade vale se igual ou contida no outro nome. Os falsos "sumiu" voltam a "confirmado" sozinhos na próxima revisão lenta (10 min) depois de publicar a função.

## Causa 2: agendou no Klingo e depois chamou no chat, e o chat não viu (`klingo-reconhecer/casar.ts`)
A regra ignorava toda marcação **feita antes da conversa começar** (menos 1 h). Quem agenda primeiro no Klingo e só depois chama no chat nunca era reconhecido.
Correção: quando o prontuário já foi conferido (CPF + nascimento), a marcação feita antes da conversa vale, desde que o exame ainda não tenha passado. Só pelo nome, a regra antiga continua.

## Ainda não resolvido
- "Ao vivo" de verdade depende do que o Klingo permite: ele só deixa ler por relatório, então a leitura é a cada 30 s (reconhecer e Jornada) e a conferência a cada 15 s. Não há aviso do Klingo para o nosso sistema.
- Paciente que chama no chat **sem** informar CPF e nascimento só é reconhecido pelo nome completo + exame, e só para marcação feita depois da conversa.
- Publicar as duas Edge Functions no Supabase (`sync-catalogo-klingo` e `klingo-reconhecer`).

## Causa 3: aviso falso de "remarcada" entre irmãs (19/11/2026)
Duas filhas da mesma mãe, mesmo celular, mesmo médico, mesmo dia: a atendente lançou uma às 07:45 e o chat lançou a outra às 08:00. A conferência reconhecia o paciente **só pelo telefone**, então achou a marcação da irmã e avisou "Marcação remarcada no Klingo", como se fosse a mesma criança.
**Correção** (`sync-catalogo-klingo/conferencia.ts`): o aviso de divergência ("remarcada" / "outro exame") agora só vale quando o **nome também confere** (ou quando o Klingo veio sem nome). Telefone igual com nome diferente não gera aviso. A **confirmação** do horário (verde) continua aceitando telefone, como antes. Testes novos em `conferencia.test.ts` (24 passam). **Falta publicar a Edge Function `sync-catalogo-klingo`** (arquivos `index.ts`, `conferencia.ts`, `precos.ts`).
Efeito colateral aceito: se a atendente digitar o nome com erro grave no Klingo, em vez de "remarcada" o chat avisa "sumiu"/"não apareceu" (também alerta).
