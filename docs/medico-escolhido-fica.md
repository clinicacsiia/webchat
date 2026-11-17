# O médico escolhido pelo paciente nunca é trocado

Versão 1.1 — 17/11/2026 / Mudança: ao abrir a solicitação o paciente digita os dias da semana, o turno e até que dia pode ir (parte 6 e 6b; chat 2026.11.17-2). Versão 1.0 — 17/11/2026 / Mudança: primeira versão (pedido do dono depois do caso de uma paciente que pediu uma médica e o chat marcou com outra).

## O caso
Uma paciente escolheu a Dra. Maiana no começo do pedido. A API do Klingo devolve ~15 dias por vez e a Maiana não tinha horário nessa janela. O chat mostrou os horários de todos os médicos (com um aviso pequeno no topo), a tela "Confira se está tudo certo" mostrou "Médico: Maiana" ao lado de um horário que era de outra médica, e o chat marcou sozinho com a outra. A equipe corrigiu depois (próxima data da Maiana: 07/12).

## Regra do dono
**Nunca perguntar nem mudar a médica que a pessoa escolheu.** Mostrar os horários dela. Se não houver, avisar que será aberta uma previsão (solicitação de disponibilidade futura) no chat para a atendente avaliar. **Ao abrir, o paciente digita os dias da semana, o turno e até que dia pode ir** (pedido do dono, 17/11/2026).

## Como ficou
| Onde | O que mudou |
|---|---|
| `chat_horarios` | Com médico escolhido a lista é só dele(a); sem horário vem vazia com `medico_sem_horario = true` (antes caía para todos os médicos). A lista de unidades também só olha os horários dele(a). |
| Chat (`index.html`, 2026.11.17-1) | Se o médico não aparece na janela 0, procura sozinho nas janelas 1 e 2 (até 45 dias). Sem horário: tela "… não tem horário disponível nos próximos 45 dias. Vamos abrir uma solicitação (previsão) aqui no chat para a nossa equipe avaliar…" com **Abrir a solicitação** e **Falar com a equipe**. Tocar em **Abrir a solicitação** abre o formulário de disponibilidade: "A partir de" e "Até" (datas), dias da semana, turno (manhã, tarde, noite ou qualquer), outra unidade e, se quiser, aviso no chat; **sem** a pergunta de outro profissional. Voltar leva ao aviso. O botão "Ver outros médicos" saiu. |
| `chat_medico_sem_horario_abrir(p_conversa, p_token, p_dados)` (novo) | Só abre quando a API não ofereceu nenhum horário futuro do médico e o paciente informou "até que dia" (sem isso recusa). Cria a disponibilidade futura com o que o paciente digitou (datas, dias, turno, unidade, aviso) e `profissional` = o médico escolhido, `aceita_outros_profissionais = false` sempre. Aviso automático ao paciente só se ele marcar "quero ser avisado". Responde no chat com o prazo, o turno e os dias, põe nota para a equipe ("MÉDICO ESCOLHIDO SEM HORÁRIO… Disponível: …") e segue o pedido para a equipe. |
| `chat_horario_escolher` | Recusa gravar horário de outro médico (trava no servidor, mesmo pedido direto). |
| `klingo_pode_marcar` | Não marca sozinho se o horário é de outro médico (`motivo = medico_diferente`); o pedido vai para a atendente. |
| `chat_disponibilidade_registrar` / `_alterar` | Com médico escolhido, a solicitação fica sempre só com ele(a); o formulário não mostra mais "Aceito outro profissional". |

"Tanto faz" (sem médico escolhido) continua igual: todos os horários.

## Pontos que continuam como estavam
- `chat_medico_limpar` continua no banco, mas nenhuma tela chama mais.
- Painel da equipe: o cartão "Sem vaga agora" ainda sugere "ver outros dias ou médicos". É decisão da atendente, não do chat.
- Sem o aviso marcado pelo paciente, quando a vigia achar vaga do médico aparece para a equipe (não manda mensagem sozinha ao paciente).

## Arquivos
`supabase/medico-escolhido-fica-parte1..6b.sql` (aplicados em 17/11/2026 como `medico_escolhido_fica_parte1`, `2`, `3`, `4a`, `4b`, `5`, `6`, `6b`), `supabase/medico-escolhido-fica-rollback.sql`, `testes/sql-medico-escolhido-fica.test.mjs` (12 casos), `testes/medico-escolhido.navegador.mjs` (5 casos), retrato 1.32.

## Medida na produção (só contagem, 14 dias)
146 conversas com médico escolhido; 109 já com horário escolhido; **51 com horário de outro médico**; **2 marcadas sozinhas pelo chat com outro médico**. (O nome é comparado por `klingo_prof_confere`; pode contar a mais se o nome do Klingo vier escrito diferente.)

## Ordem de publicação
O banco já está aplicado. O chat novo só vale depois de a PR ser aprovada e publicada. Com o banco novo e o chat antigo o paciente vê a lista vazia e o botão antigo "Ver outros médicos", que continua funcionando (não é erro).
