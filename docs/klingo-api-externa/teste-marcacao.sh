#!/usr/bin/env bash
# Teste manual da marcação pela API externa do Klingo, para rodar no SEU computador (fora do ambiente do Claude).
# Nada de segredo aqui: a chave vem da variável KLINGO_TOKEN (formato clinicacsi:xxxx).
#
#   export KLINGO_TOKEN='clinicacsi:...'
#   PACIENTE_ID=P123456 ./teste-marcacao.sh                     # só LÊ: login + GET /paciente + horários (modo ler)
#   PACIENTE_ID=P123456 MODO=marcar ./teste-marcacao.sh         # RESERVA e MARCA de verdade (use só com paciente que autorizou)
#
# Variáveis: PACIENTE_ID (com o P, paciente definitivo) · HORARIO (chave do horário, ex. 2026-11-17|63|312|2|14:20)
#            PROCEDIMENTO (padrão 1096 = consulta de neurologia) · PLANO (padrão 1 = Particular)
set -u
B=https://api-externa.klingo.app/api
: "${KLINGO_TOKEN:?defina KLINGO_TOKEN}"; : "${PACIENTE_ID:?defina PACIENTE_ID (ex.: P123456)}"
MODO=${MODO:-ler}; PROCEDIMENTO=${PROCEDIMENTO:-1096}; PLANO=${PLANO:-1}
curl_k(){ curl -sS -m 60 -H "X-APP-TOKEN: $KLINGO_TOKEN" "$@"; }

echo "== 1) login"; R=$(curl_k -X POST "$B/externo/login" -H 'Content-Type: application/json' -d "{\"id\":\"$PACIENTE_ID\"}")
TK=$(printf '%s' "$R" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -n "$TK" ] || { echo "sem access_token: $R" | head -c 300; exit 1; }
echo "ok (id_paciente e plano da sessão): $(printf '%s' "$R" | sed -n 's/.*"id_paciente":\([^,}]*\).*/\1/p') | $(printf '%s' "$R" | sed -n 's/.*"plano":{[^}]*"nome":"\([^"]*\)".*/\1/p')"

echo "== 2) GET /paciente com a sessão (deve dar 200; no ambiente do Claude dava 401 'ID de cliente inválido')"
curl_k "$B/paciente" -H "Authorization: Bearer $TK" -o /dev/null -w "HTTP %{http_code}\n"
echo "== 3) GET /vouchers"
curl_k "$B/vouchers" -H "Authorization: Bearer $TK" -o /dev/null -w "HTTP %{http_code}\n"

if [ "$MODO" = marcar ]; then
  : "${HORARIO:?defina HORARIO (chave do horário)}"
  BODY="{\"id\":\"$HORARIO\",\"procedimento\":\"$PROCEDIMENTO\",\"plano\":$PLANO,\"email\":false}"
  echo "== 4) reservar"; curl_k -X POST "$B/agenda/reservar" -H "Authorization: Bearer $TK" -H 'Content-Type: application/json' -d "$BODY" -w "\nHTTP %{http_code}\n"
  echo "== 5) marcar"; curl_k -X POST "$B/agenda/horario" -H "Authorization: Bearer $TK" -H 'Content-Type: application/json' -d "$BODY" -w "\nHTTP %{http_code}\n"
  echo "Para cancelar: curl -X DELETE $B/voucher -H \"X-APP-TOKEN: \$KLINGO_TOKEN\" -H \"Authorization: Bearer <token>\" -H 'Content-Type: application/json' -d '{\"id\":\"<id do voucher>\"}'"
fi
