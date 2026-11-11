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
