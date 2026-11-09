# Lista de conversas agrupada por atendente (09/11/2026)

Só na aba **Abertas** do Atendimento (modo Lista). Aguardando, Meus, Encerradas e a busca continuam como antes.

## Como aparece

1. **Precisam de atenção** (vermelho): conversa assumida por alguém cujo paciente espera resposta há **mais de 2 horas**. Todos veem, com o aviso "Fulano assumiu e ainda não resolveu".
2. **Sem atendente**: ninguém assumiu; vale para todo mundo.
3. **Minhas conversas**.
4. Um grupo por atendente, em ordem alfabética.

Clicar no título do grupo recolhe/expande. Cada conversa aparece uma vez só (a que está em "Precisam de atenção" não repete no grupo do dono).

## Regra das 2 horas

Usa o cronômetro que já existe (`cliente_aguarda_desde`): tempo desde a última mensagem do paciente sem resposta de uma pessoa. Quando a conversa cruza as 2 h, a lista se redesenha sozinha e ela sobe. Se o atendente responder, o cronômetro zera e ela volta para o grupo dele. O limite é `LIMITE_ATENCAO` em `painel/index.html`.

**Conversas unidas (correção de 09/11/2026, `supabase/cronometro-grupo.sql`):** a resposta de uma pessoa da equipe zera o cronômetro de **todas** as conversas abertas da mesma pessoa (mesmo grupo ou mesmo contato), não só a da mensagem. Antes, o atendente respondia na conversa mais recente e o relógio da antiga continuava rodando; como a lista usa a espera mais antiga do grupo, o contador não parava e a conversa ficava em "Precisam de atenção". O mesmo arquivo conserta as conversas que já estavam com o relógio atrasado. Teste: `npm run test:cronometro-grupo`.

Obs.: o banco não guarda "quando a conversa foi assumida"; por isso a regra olha o tempo de espera do paciente, não o tempo desde a assunção.

## Teste

`cd testes && npm run test:lista-agrupada` (4 verificações em navegador, Supabase simulado).
