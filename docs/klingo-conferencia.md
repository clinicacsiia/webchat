# Conferência Klingo × webchat (13/11/2026)

Versão 1.1 — 13/11/2026 (tarde) / Mudança: filho(a) não gera mais aviso de dado faltando (só conflito de nome ou nascimento da criança); cartões de aviso com mais opções de resolver e consultar. Versão 1.0 — 13/11/2026 / Mudança: Implementação inicial. Pedido do dono: explicar por que os números dos Indicadores não batem com o Klingo, conferir marcação por marcação e mandar para a aba **Avisos** o que a equipe precisa resolver.

## Para que serve
O dono desconfiava dos números porque "tem gente se perdendo" e faltam informações. Esta conferência lê o relatório **#14554** do Klingo (todas as marcações, pela data em que foram marcadas) e responde, na aba **Indicadores > seção 3**:

1. **Quantas marcações o Klingo tem** e **por onde chegaram**: WhatsApp, Telefone, Recepção e **sem origem** (em branco no Klingo).
2. **Por que o cartão "Marcações novas" mostra menos**: total do Klingo, menos o que ainda não está no banco (exame marcado para depois de 30 dias), menos as remarcadas. Conferido na produção em 13/11/2026 (09 a 12/11): 1.523 → 1.309, igual ao cartão.
3. **Quantas têm conversa no webchat** (ligadas pelo pedido do chat ou por celular + nome) e o que aconteceu com o exame delas (atendido, faltou, por vir, cancelado/remarcado).
4. **O funil de quem procurou o chat**: procuraram, atendidas pela equipe, pedido pronto, geraram agendamento, ligadas a uma marcação do Klingo, e as **agendadas no chat sem marcação no Klingo** (quem pode ter se perdido), com o nome para abrir a conversa.
5. **Cadastro incompleto no Klingo**: sem CPF, sem e-mail, sem celular.
6. **Conflitos e dados faltando**, em tabela marcação por marcação, mais a lista "Conferir uma a uma" das marcações que vieram do webchat.

## Regras (caso de filho)
- **Pedido próprio:** nome, nascimento, CPF, celular e e-mail do chat são comparados com o Klingo. Diferente = **conflito**.
- **Pedido de filho(a):** o chat guarda a criança (nome, nascimento) e os **contatos do responsável** (CPF, celular, e-mail). Só nome e nascimento da criança são comparados. CPF, celular e e-mail diferentes ficam como "responsável diferente, esperado" e **não são conflito**.
- **Dado faltando no Klingo** (o chat tem e o Klingo está vazio): celular, e-mail e CPF, **só em pedido próprio**. Em pedido de filho(a) **não há aviso nem lista de dado faltando** (decisão do dono em 13/11/2026: os contatos do chat são do responsável). Os campos vazios continuam contados em "Cadastro incompleto no Klingo".
- Medido em 06 a 12/11/2026: 96 de 1.990 marcações ligadas ao chat (94 de filho); 7 com conflito (5 filho, só nascimento). Na primeira versão saíram 32 avisos de e-mail do responsável faltando em filho: foram retirados e a equipe já tinha resolvido os 4 de conflito.

## Avisos
Dois tipos novos em `paciente_aviso`: `klingo_conflito` e `klingo_dado_faltando` (só pedido próprio), um por conversa e tipo, na aba **Avisos**. Cada cartão mostra **o que o chat registrou** (nome e nascimento, para comparar com a ficha do Klingo; vem da chave `ficha` de `paciente_avisos`) e tem as opções **Corrigi no Klingo** e **Está certo, manter** (as duas fecham o aviso), **Ver conversa**, **Chamar no WhatsApp** e **Ver na Conferência** (abre a lista da seção 3). Eles se atualizam sozinhos, **fecham sozinhos quando o Klingo é corrigido** e, se a equipe marcar "Conferido", **não reabrem** enquanto os dados forem os mesmos. Só entram marcações abertas (não canceladas) dos últimos 30 dias e conversas que não são de teste. Não há notificação push: o aviso só aparece na aba.

## Privacidade
- A tabela `klingo_conferencia` **não guarda CPF, e-mail, telefone nem nascimento**: só origem, status, datas, ligação com a conversa e **quais campos** divergem ou faltam.
- A Edge Function `klingo-conferir` lê o relatório na memória e manda ao banco apenas **marcas SHA-256** (dado + `config.ia_segredo`, a mesma conta do `fone_chave` da Jornada) e o nascimento como data. O banco compara com o chat e descarta. O nome já existia em `jornada_paciente.nome`.
- Nenhuma resposta nem log leva dado de paciente.

## Como funciona e como operar
- **Rotina:** `klingo-conferir` (pg_cron), de hora em hora das 06h23 às 20h23 de Brasília, relê os últimos 4 dias de marcação (`klingo_conferencia_agendar(4)`).
- **Liga/desliga:** `config.klingo_conferir_ativo` (`sim`/`nao`). Desligado, a rotina não chama nada e nada se apaga.
- **Ler outro período** (histórico até 31 dias): `select net.http_post(url := '.../functions/v1/klingo-conferir', headers := ..., body := '{"de":"AAAA-MM-DD","ate":"AAAA-MM-DD"}')`, como no fim de `supabase/klingo-conferencia.sql`.
- **Limite conhecido:** marcação mais velha que 4 dias não é relida. Se for cancelada depois, o status dela aqui fica desatualizado até uma leitura de histórico.
- **Relatório #14554:** colunas conferidas em 13/11/2026 (col0 Id, col1 marcado em, col2 exame, col3 origem, col7 procedimento, col8 operadora, col9 unidade, col10 nome, col11 status, col12 CPF, col13 telefone, col14 e-mail, col15 nascimento, col16 celular). Não tem prontuário, "Atendido S/N" nem confirmação: **não substitui** o #14359 da Jornada.

## Arquivos
- Banco: `supabase/klingo-conferencia.sql` (fluxograma, versão, rollback). Migrações aplicadas: `klingo_conferencia_parte1` a `parte7`.
- Função: `supabase/functions/klingo-conferir/` (`index.ts`, `mapa.ts`, `mapa.test.ts`).
- Tela: `painel/index.html` (`blocoConferencia`, cartões em `renderAvisosPaciente`), `painel/sw.js` v23.
- Testes: `npm run test:conferencia-sql` (19), `npm run test:edge` (inclui `klingo-conferir`, 8), `npm run test:indicadores` (28, 9 deles da conferência).

## Pendências
1. **Apagar a função `public.klingo_conferir_agendar(p_dias integer)`**: sobrou com o nome antigo porque o Supabase pediu confirmação do apagamento e ficou sem resposta. Ela não é usada (a rotina chama `klingo_conferencia_agendar`). A outra função de mesmo nome, `klingo_conferir_agendar(p_conversa uuid)`, é do autoatendimento e **não deve ser apagada**. Para apagar: `drop function public.klingo_conferir_agendar(integer);`
2. **Apagar a Edge Function temporária `klingo-comparar-14554`** (conferência manual feita em 13/11/2026; hoje só devolve "desativada"): https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions
3. O retrato da produção estava sem `chat_saude` e a tabela da "saúde da API" (migração `saude_api_parte1`, de outra sessão): `npm run test:retrato` acusa isso desde antes desta mudança.
4. Decisão do dono: "atendido" vale mesmo quando a marcação está cancelada no Klingo? (14 casos em 09 a 12/11.)
