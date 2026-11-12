# Roteiro para a reunião com o desenvolvedor do Klingo (12/11/2026)

O Yan (implantação do Klingo) ofereceu reunião com o desenvolvedor deles e pediu que a pessoa chegue **embasada nas dúvidas**. Este roteiro reúne o objetivo, a prova do problema (reproduzível) e as perguntas.

## Objetivo
O chat da clínica deve **marcar consulta e exame sozinho pela API externa**, para (1) **paciente novo** e (2) **paciente que já é da clínica**, sem o paciente ir à clínica e sem a recepção aprovar nada antes.

## O que já foi feito (não perguntar de novo)
- Lemos o Swagger (`swagger-1.0.0.json`) e o PDF de referência. Eles dizem "pré-cadastrar se for novo" → "logar" → reservar → marcar, **mas não explicam o login do pré-cadastro nem a reserva dele**. O PDF lista isso como não documentado (seção 6).
- A API "Telefonia/Confirmação" (`swagger-telefonia-1.0.0.json`) é só de confirmação por ligação, NPS e bloqueios; não trata de cadastro nem de marcação.
- Chave da clínica válida, leitura de agenda funcionando (horários, especialidades, exames, convênios).

> **CORREÇÃO (12/11/2026):** a prova abaixo foi feita pelo ambiente de teste do Claude, cujo proxy mexe nos cabeçalhos. O 401 "ID de cliente inválido" **era desse ambiente, não do Klingo**. De dentro do Supabase, paciente definitivo: login, reserva e marcação funcionaram. **Não mande esta prova ao Klingo; refaça o teste do pré-cadastro pela função antes de qualquer pergunta.** Perguntas 3 a 10 continuam válidas.

## Prova do problema (INVÁLIDA para a etapa 3; ver correção acima)
`$T` = a chave da clínica (`clinicacsi:…`). Use um paciente de teste inventado.

```bash
B=https://api-externa.klingo.app/api
# 1) pré-cadastro
curl -X POST $B/externo/register -H "X-APP-TOKEN: $T" -H "Content-Type: application/json" \
  -d '{"paciente":{"nome":"PACIENTE TESTE","sexo":"M","dt_nasc":"1990-01-01","mae":"MAE TESTE","docs":{"cpf":"<CPF de teste>"},"contatos":{"celular":"71999999999"}}}'
#  -> 200 {"id": N}
# 2) login com o id devolvido
curl -X POST $B/externo/login -H "X-APP-TOKEN: $T" -H "Content-Type: application/json" -d '{"id":"P<N>"}'   # abre a sessão de OUTRO paciente (id_paciente = N, já existente)
curl -X POST $B/externo/login -H "X-APP-TOKEN: $T" -H "Content-Type: application/json" -d '{"id":"<N>"}'    # abre a sessão do pré-cadastro: user.id=N, id_paciente vazio
# 3) com o access_token da sessão sem P
curl "$B/agenda/horarios?especialidade=225112&inicio=<data>&fim=<data>" -H "X-APP-TOKEN: $T" -H "Authorization: Bearer <token>"   # 200
curl -X POST $B/agenda/reservar -H "X-APP-TOKEN: $T" -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"id":"<chave do horário>","procedimento":"1096","plano":1}'                                                              # 401 "ID de cliente inválido []"
curl $B/paciente -H "Authorization: Bearer <token>"                                                                             # 401 "ID de cliente inválido []"
```
Observações: `GET /paciente/cpf` e `POST /paciente/identificar` (telefone + nascimento) **não acharam** o pré-cadastro depois de criado ("PACIENTE_NAO_IDENTIFICADO"). A equipe não encontrou onde o pré-cadastro aparece para aprovação; o Yan disse que ele "vai pra agenda".

## Perguntas (em ordem de importância)
1. **Paciente novo:** qual é o fluxo, só por API, que chega até `POST /agenda/horario` sem a recepção? Existe outro endpoint (ex.: `/externo/portal/register` + `/externo/portal/login`) que já devolva sessão com `id_paciente`? Quais campos de `paciente` são obrigatórios?
2. **Pré-cadastro:** a reserva e a marcação funcionam com sessão sem `id_paciente`? Se não, o que gera o `id_paciente` e quando?
3. **Paciente da clínica:** como achar pelo CPF? Em que formato o CPF precisa ir? `GET /paciente/cpf` só acha cadastro definitivo? E o telefone em `/paciente/identificar`?
4. **Segurança:** `POST /externo/login` com `P<id>` aceita qualquer id só com a chave da clínica. É esperado? Existe verificação extra que devemos usar?
5. **Permissão da chave:** a nossa chave pode criar agendamentos? (O PDF lista isso como pendente.)
6. **Campos de `POST /agenda/horario`:** quais são obrigatórios, e o que significa `id_externo` na agenda deles?
7. **Plano Particular:** é o `plano` 1 (operadora PARTICULAR)? Como indicar convênio e carteirinha na marcação?
8. **Conflito de horário:** que erro volta quando o horário foi tomado entre a reserva e a marcação?
9. **Homologação:** existe ambiente de teste, para não ocupar a agenda real? Limite de requisições?
10. **Marcações pela API na agenda:** aparecem no mesmo ritmo nos relatórios (#7, #14359) e como se identifica a origem?

## Para levar à reunião
Este arquivo, o PDF e os dois Swaggers (todos nesta pasta), e um paciente de teste cadastrado pela recepção para a prova ao vivo.
