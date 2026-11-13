# Ciclo de melhoria do chat com o Claude (13/11/2026)

**Decisão do dono:** o chat **não aprende sozinho**. Quem analisa as conversas e atualiza o código é o Claude, a pedido do dono, conforme os dados crescem. Por isso os textos para o paciente dizem que **a equipe melhora o espaço ouvindo como as pessoas o usam** (e não que o chat "aprende").

## Quando rodar (lembrete na pendência 2.11 de `docs/pendencias-do-dono.md`)
- Toda **semana** enquanto a base tem menos de 2 meses; depois, todo **mês**.
- Sempre que mudar um texto, a ordem das opções ou um passo: rodar de novo uma semana depois e comparar.

## O que pedir ao Claude (cole isto numa sessão)
> Rode o ciclo de melhoria do chat (`docs/ciclo-de-melhoria-com-claude.md`): compare esta semana com a anterior, diga o que melhorou ou piorou, proponha mudanças de texto e de ordem das opções, e deixe tudo em arquivos novos para eu aprovar. Não aplique nada na produção sem eu mandar.

## O que o Claude mede (só contagens, nunca texto de paciente)
1. Conversas, mensagens, horários de pico e dias.
2. **Funil por passo** (quantas conversas viram cada pergunta) e % **sem resposta** por pergunta.
3. **Pedidos de atendente** ("Quero falar com um atendente") e em que passo acontecem.
4. **Posição média do botão clicado** em motivo, plano, assunto e médico; % de cliques entre os 5 primeiros.
5. Encerramentos (agendado, não respondido, só informação) e pedidos em rascunho.
6. Frases que se repetem 6 vezes ou mais (para achar o que a equipe digita à mão).
7. Tempo de resposta da equipe (mediana e percentil 90).

As consultas usadas estão no histórico desta sessão e em `docs/analise-conversas-2026-11-13.md` e `docs/revisao-textos-e-ordenacao-2026-11-13.md`; o Claude pode refazê-las.

## O que o Claude atualiza (sempre em arquivo novo, com teste e rollback)
- Textos (`fluxo_texto`, `config`) e telas (`index.html`, trocando `VERSAO_APP` e `VERSAO` do `sw.js`).
- Ordem das opções (motivo, plano, assunto). Médico só com muito mais dados.
- Respostas prontas para a equipe, quando uma frase passar de ~20 repetições.

## Regras que não mudam
- Na produção, ler só estrutura, contagens, tempos e erros. **Nunca** nome, telefone, CPF ou texto de conversa (regra do `CLAUDE.md`).
- Toda mudança de banco segue o `CLAUDE.md`: arquivo novo em `supabase/`, teste no clone, aplicar em partes, medir, refazer o retrato, `npm run test:retrato`.
- Se um dia as conversas forem usadas para treinar ou ajustar um modelo, antes: anonimizar, escrever na política de privacidade e passar por revisão jurídica.
- Guardar o resultado de cada rodada em `docs/` com a data, para comparar com a próxima.
