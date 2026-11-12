# Alinhamento do chat com a API do Klingo (estudo de 12/11/2026)

Só estudo: nenhuma mudança de código além do que já está na branch. Testado no clone da produção (voltar durante a marcação).

## Ordem atual das perguntas (fluxo_proximo)
identidade > atalho (repetir último exame) > motivo > exame/consulta > médico > **cpf_nasc** > plano > horário > "dados continuam os mesmos?" > nome/sexo/nascimento > celular/e-mail > confirmar > marcando.
Não se pergunta mais: nome da mãe, RG, endereço, carteirinha.

## Problemas encontrados (ordem de gravidade)
1. **Voltar durante "marcando" (confirmado no clone).** `chat_voltar` aceita o passo `marcando`: a conversa volta para "confirmar" com a operação ainda `pendente`. A chave de idempotência inclui o horário (`marcar:pedido:voucher:chave_do_horario`), então escolher outro horário cria uma 2ª operação e o Klingo pode receber duas reservas. Correção: bloquear voltar em `marcando`/`pos_menu` e recusar `klingo_operacao_criar` se já existe operação pendente, em andamento ou com sucesso para o pedido (exceto cancelar/remarcar).
2. **Paciente conhecido pula as perguntas.** `v_ja` (identidade conferida) pula "dados_ident/dados_contato", e o `cpf_nasc` já vem preenchido. Para comparar o que a pessoa digita com o Klingo, na rota da API é preciso redigitar tudo, sem preenchimento prévio.
3. **A comparação só olha CPF + nascimento.** `klingo_identidade` guarda hash, id e situação (sem dado pessoal). Nome, celular, e-mail e sexo nunca são comparados com o cadastro do Klingo.
4. **Mais de um exame vai sempre para a equipe.** `klingo_pode_marcar` exige 1 procedimento e 1 horário. O chat já monta vários exames e `agenda_grupos` junta os que cabem no mesmo horário. A API tem `lista` (procedimentos associados no mesmo horário), nunca testada.
5. **Convênio inativo só aparece no fim.** Hoje o paciente percorre tudo e a falha vira nota para a equipe. A API recusa o plano já na consulta de horários.
6. **Chat e Klingo discordam sobre convênios.** O chat marca como inativos ASSEFAZ, GEAP, PF Saúde e SELECT. No Klingo, ASSEFAZ e PF Saúde não existem na lista, mas GEAP (plano 21) e SELECT (plano 32) existem e estão ativos.
7. **Depois de marcar, a conversa fica aberta** (menu "ver/remarcar/cancelar"). Para virar "Agendado pela API, encerrada" é preciso decidir como o paciente volta (nova conversa ligada à anterior).

## Regra de divergência proposta (a confirmar)
Redigitar nome completo, CPF, nascimento, celular, e-mail e sexo. Comparar com o Klingo no servidor (sem guardar o valor, só o nome do campo).
- 0 divergentes: segue sozinho.
- 1 divergente: equipe valida, corrige ou orienta atualizar na clínica.
- 2 ou mais: não segue; o chat orienta ir à CSI e a equipe é avisada.
Campo vazio no Klingo não é divergência (vira "atualizar cadastro"). Não revelar qual campo errou. Limitar tentativas.

## Decisões do dono (12/11/2026) e estado
| Decisão | Estado |
|---|---|
| Perguntar o nome da mãe | Feito (parte 11): quando a API está ligada, o passo de identificação pede a mãe. |
| Voltar só onde não gera problema | Feito (parte 11): não volta durante nem depois da marcação; um pedido tem uma só operação. |
| Divergência por campo (0 segue, 1 equipe valida, 2+ vai à CSI) | Feito (parte 11 + executor). |
| Convênio: o Klingo manda, o chat é cópia; inativo aparece ao escolher o convênio | Feito (parte 12): rotina diária `convenio_seguir_klingo`. |
| Paciente conhecido confirma só o CPF; "Não sou eu" ou conferência com mais de 90 dias = tudo de novo | Feito (parte 13). |
| Link do Minha vez no cartão do agendamento | Feito (chat 2026.11.12-15). |
| Vários exames: um horário por grupo, em sequência; se falhar, mantém o que marcou e a equipe resolve o resto | Projetado, não implementado (ver abaixo). |
| Laudo automático e segunda via em qualquer conversa | Projetado, não implementado (ver abaixo). |
| Quadros | Proposta abaixo; nada alterado. |

### Vários exames (desenho)
Hoje a API só entra quando há 1 procedimento e 1 horário: `chat-agenda-api` (`pedidoDaApi`), `chat_horarios`, `chat_horario_escolher`, `klingo_pode_marcar` (`varios_procedimentos`, `horario_nao_unico`) e o executor assumem isso. Para marcar um grupo por vez é preciso: (1) ofertas da API por grupo (um pedido de horários por procedimento do grupo); (2) `chat_horarios`/`chat_horario_escolher` guardarem a chave do Klingo de cada grupo; (3) a operação levar a lista de grupos; (4) o executor marcar um por vez (pausa entre chamadas, por causa do limite de requisições), parar no primeiro erro e devolver "parcial"; (5) o `concluir` marcar como agendado o que foi marcado e passar o resto à equipe; (6) cancelar/remarcar de mais de uma marcação ficar com a equipe.

### Laudo automático e segunda via (desenho)
Rota: `GET /resultado/{id_marcacao}` (HTML + PDF, `pronto`). O id da marcação é o voucher que o chat guardou. Fluxo: uma rotina consulta, com cota, as marcações de exame já realizadas; quando `pronto`, o chat manda um aviso (e push) com o botão "Ver meu laudo". O botão chama uma função que confere a conversa (token), o dono do voucher e a identidade (CPF, nascimento e mãe contra o Klingo) e entrega o PDF sem guardá-lo. Segunda via: o mesmo botão, pedido em qualquer conversa, por CPF + nascimento + mãe. Não foi testado com laudo real (decisão do dono: ajustar se der problema).

### Quadros (proposta)
Dois eixos separados: quem conduz a conversa (filtros da lista de Atendimento) e a etapa do paciente (Jornada, que fica como está).
1. **Com a API**: a automação conduz (inclui "Consulta API": conversa reaberta depois de agendada, marcada com etiqueta).
2. **Agendado pela API**: pedido com origem `chat_api`; conversa encerrada ou só no menu pós-marcação.
3. **Esperando atendente**: transferida e sem dono.
4. **Com atendente**: assumida por uma pessoa.
