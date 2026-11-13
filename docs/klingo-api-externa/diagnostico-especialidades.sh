#!/usr/bin/env bash
# Diagnóstico SÓ DE LEITURA: por que a API do Klingo devolve 3 especialidades e o portal mostra 15?
# Rode no SEU computador (fora do ambiente do Claude, que é bloqueado pelo proxy). Precisa de curl e python3.
# Não usa paciente, CPF nem sessão. Imprime só contagens e códigos (nenhum nome de médico, nenhum dado pessoal).
# A chave NUNCA vai para arquivo: defina na hora.
#
#   export KLINGO_TOKEN='clinicacsi:...'
#   ./diagnostico-especialidades.sh > resultado.txt 2>&1      # depois cole o resultado.txt na conversa
set -u
B=https://api-externa.klingo.app/api
: "${KLINGO_TOKEN:?defina KLINGO_TOKEN (formato clinicacsi:xxxx)}"
IN=$(date -d '+3 days' +%F 2>/dev/null || date -v+3d +%F); FIM=$(date -d '+25 days' +%F 2>/dev/null || date -v+25d +%F)
k(){ curl -sS -m 40 -H "X-APP-TOKEN: $KLINGO_TOKEN" -H 'Accept: application/json' -w '\n%{http_code}' "$@"; }
# resume: imprime "HTTP <status>" e, se for lista, a quantidade e os pares cbos:nome (só catálogo)
resumo(){ python3 -I -c '
import sys,json
t=sys.stdin.read(); corpo,_,st=t.rpartition("\n")
print("  HTTP",st,end="")
try: d=json.loads(corpo)
except Exception: print("  (corpo não é JSON)"); sys.exit()
if isinstance(d,list):
    print("  itens:",len(d))
    if d and isinstance(d[0],dict) and "cbos" in d[0] and "nome" in d[0]:
        print("  ", ", ".join(str(x.get("cbos"))+":"+str(x.get("nome")) for x in d))
elif isinstance(d,dict):
    print("  chaves:",",".join(list(d)[:8]), "|", str(d.get("message",""))[:120])
'; }

echo "### 1) /agenda/especialidades com variações de filtro"
for q in "" "?consultas=1" "?consultas=true" "?cnes=1" "?cnes=2" "?id_plano=1" "?id_plano=4949" "?id_plano=8"; do
  echo "GET /agenda/especialidades$q"; k "$B/agenda/especialidades$q" | resumo
done

echo; echo "### 2) /agenda/consultas por CBOS (os 15 do portal)"
for c in 225151 225120 225230 225125 225155 225165 225250 225112 223710 225118 225270 225124 225127 225320 225285; do
  printf 'cbos %s ->' "$c"; k "$B/agenda/consultas?cbos=$c" | python3 -I -c '
import sys,json
t=sys.stdin.read(); corpo,_,st=t.rpartition("\n")
try: d=json.loads(corpo)
except Exception: print(" HTTP",st,"(sem JSON)"); sys.exit()
print(" HTTP",st,"| procedimentos:", [x.get("id") for x in d] if isinstance(d,list) else str(d)[:100])'
done

echo; echo "### 3) /profissionais: quantos médicos por CBOS (sem nomes)"
k "$B/profissionais" | python3 -I -c '
import sys,json,collections
t=sys.stdin.read(); corpo,_,st=t.rpartition("\n"); print("HTTP",st)
try: d=json.loads(corpo)
except Exception: print("sem JSON"); sys.exit()
c=collections.Counter(); sem=0
for p in d if isinstance(d,list) else []:
    es=p.get("especialidades") or []
    if not es: sem+=1
    for e in es: c[str(e.get("cbos") or e.get("id") or "?")+" "+str(e.get("nome") or e.get("descr") or "")]+=1
print("médicos:",len(d) if isinstance(d,list) else "?", "| sem especialidade:",sem)
for k_,v in c.most_common(): print("  ",k_,"=",v)
print("campos de uma especialidade (só nomes dos campos):", sorted((((d[0].get("especialidades") or [{}])[0]) if isinstance(d,list) and d else {}).keys()))'

echo; echo "### 4) /agenda/horarios por CBOS ($IN a $FIM, plano Particular): quantos dias de médico e quantos horários"
for c in 225151 225120 225230 225125 225155 225165 225250 225112 223710 225118 225270 225124 225127 225320 225285; do
  printf 'cbos %s ->' "$c"; k "$B/agenda/horarios?especialidade=$c&inicio=$IN&fim=$FIM&plano=1" | python3 -I -c '
import sys,json
t=sys.stdin.read(); corpo,_,st=t.rpartition("\n")
try: d=json.loads(corpo)
except Exception: print(" HTTP",st,"(sem JSON)"); sys.exit()
if isinstance(d,list):
    print(" HTTP",st,"| dias de médico:",len(d),"| horários:",sum(len(x.get("horarios") or {}) for x in d),"| procedimentos:",sorted({x.get("procedimento") for x in d}))
else: print(" HTTP",st,"|",str(d.get("message") or d)[:140])'
done
echo; echo "Fim. Pode colar tudo na conversa (só tem códigos, nomes de especialidade e contagens)."
