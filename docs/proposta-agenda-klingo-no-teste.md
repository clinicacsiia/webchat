# Proposta: horários reais do Klingo na pré-marcação do TesteWebchat (25/11/2026)

**Situação:** a tela "Qual horário você prefere?" do teste usa a grade fixa das médicas (`agenda-real.js`), que não desconta horário ocupado. Pedido: mostrar os horários livres do Klingo, em produção, **só leitura**. Se não carregar, a tela continua como está hoje.

**Relatórios do Klingo:** nenhum relatório novo ou editado é necessário (a agenda vem da API `GET /agenda/horarios`, não de relatório).

## Por que não usar a `chat-agenda-api` como está
- Exige uma **conversa real** (id + token), CPF, nascimento e plano de um paciente. O teste tem só dados fictícios.
- Ela **grava no banco** (`klingo_consulta`, `klingo_oferta`). Chamar de um teste criaria conversas e registros falsos na produção.
- A `klingo-agenda-api` já faz leitura sem paciente, mas exige o segredo `x-sync-key`, que **não pode ficar numa página pública**.

## O que propomos: uma função nova, só de leitura (`agenda-previa`)
Edge Function pública, sem paciente, sem gravar no banco, sem reservar nada no Klingo.

| | |
|---|---|
| Entrada | consulta (id do catálogo), médica (opcional), período (14 dias, "mais 14" opcional). **Nenhum dado pessoal.** |
| O que faz | Traduz a consulta para a especialidade liberada (`klingo_especialidade.liberada_api`), chama `GET /agenda/horarios` com plano **Particular de referência** (igual ao que a tela já faz quando o plano é desconhecido) e devolve só `data, hora, unidade, profissional`. |
| O que nunca faz | Gravar no banco, reservar/marcar no Klingo, receber CPF/nome/telefone, devolver dado de paciente. |
| Proteções | Cota global de chamadas já existente (`cotaGlobal`); limite por origem; cache de 60 s por consulta/médica (muitos testes = 1 chamada ao Klingo); só aceita consultas liberadas; CORS só de `clinicacsiia.github.io`; **interruptor** em `config` (`agenda_previa_ligada`) para desligar sem publicar nada; tempo máximo de 6 s. |
| Resposta | `{ok, estado, dias:[{data, horarios:[...]}]}` ou `{ok:false, estado:"indisponivel"|"sem_horarios"|"desligado"}`. |

## Mudança na tela do teste
1. A página libera **só essa função** (hoje só `chat_config` passa; o resto segue bloqueado, inclusive RPC, login e push).
2. Em "Qual horário você prefere?": busca os horários reais (já existe o estado "Buscando os horários…").
3. **Carregou:** mostra dias e horários livres reais; a pessoa escolhe o desejado (como já acontece com a grade) e ainda pode dizer só o período.
4. **Não carregou** (erro, lentidão >6 s, desligado, sem horário): mostra **exatamente a tela atual** (grade/período e dias), com um aviso curto: "Não conseguimos ver a agenda agora; diga o melhor período."
5. Etiqueta pequena indicando a origem: "Agenda do Klingo" ou "Grade de referência".
6. A reserva provisória e a confirmação continuam **simuladas** no teste; nada é reservado no Klingo. A equipe confere o horário de novo ao confirmar.

## Riscos e como ficam cobertos
- **Limite de chamadas do Klingo:** cache + cota global; o teste não pode esgotar a cota do chat real. Se a cota estiver apertada, a função responde "indisponivel" e a tela usa a grade.
- **Página pública chamando produção:** a função não aceita nem devolve dado pessoal; mesmo com abuso, só lê horários que já são públicos no chat.
- **Regras por idade/sexo/plano:** como não há paciente, o resultado é de referência. A tela já avisa que a equipe confere convênio e plano.
- **Horário "livre" que já foi ocupado:** normal em pré-marcação; por isso a confirmação refaz a consulta.

## Passos (cada um com aprovação do dono antes de ir à produção)
1. Escrever a função e os testes (com Klingo simulado, no clone) e a mudança de tela, em arquivos novos.
2. Colocar a chave `agenda_previa_ligada` (começa **desligada**).
3. **Publicar a função em produção** (ação externa: precisa do OK do dono) e ligar.
4. Medir: chamadas, tempo, erros, uso da cota. Conferir no Klingo se algum horário foi criado (esperado: nenhum).
5. Atualizar `supabase/producao/` (retrato), `npm run test:retrato`, versão do teste e `LEIAME.md`.

## Decisões que preciso do dono
1. Pode publicar a função nova em produção (leitura apenas)?
2. A pré-marcação só **mostra** os horários, sem reservar no Klingo? (recomendado)
3. Plano de referência: Particular para todos, como hoje?
