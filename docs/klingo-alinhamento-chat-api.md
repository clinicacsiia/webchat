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
