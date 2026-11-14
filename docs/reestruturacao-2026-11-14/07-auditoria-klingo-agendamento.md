# 07 — Auditoria de segurança da função `klingo-agendamento`

Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Decisão do dono (14/11/2026): **a função é mantida, não é apagada nem desativada**; a segurança é corrigida preservando o uso legítimo. **Nada foi publicado:** a função em produção continua exatamente como estava (versão 2 do Supabase, código 1.0). Tudo abaixo está no repositório, testado, esperando a sua autorização.

Link da função: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions/klingo-agendamento

## 1. O que a função faz (código lido da produção, não de memória)

Recebe `POST {"acao": ...}` com CPF + data de nascimento e fala com o Klingo pela chave `KLINGO_APP_TOKEN`, que só existe no servidor. Ações sem identidade: `versao`, `horarios`, `catalogo`, `requisicao` (só leitura). Ações com identidade: `identificar`, `meus_dados`, `atualizar_contato`, `minhas_marcacoes`, `autorizacoes`, `reservar`, `soltar`, `marcar`, `remarcar`, `cancelar`, `trocar_procedimento`, `checkin`, `cancelar_checkin`, `resultado` (desligada por padrão) e `cadastrar` (paciente novo). Está publicada com `verify_jwt = false` porque a página que a usava era pública.

O arquivo publicado **não estava no repositório** (foi removido em 14/11 junto com a página). Foi restaurado a partir da produção em `supabase/functions/klingo-agendamento/` (`index.ts`, `api.ts`, `regras.ts`) e ganhou testes.

## 2. Perguntas do dono, uma por uma

| Pergunta | Resposta (comprovada) |
|---|---|
| Tem validação de acesso no servidor? | **Sim, mas só a de identidade.** Cada ação com paciente confere CPF + nascimento no Klingo **antes** do login e confere o id e o nascimento da sessão **depois** (se não bater, para). Não existe login do Supabase: a função é pública por desenho. |
| É possível chamá-la direto, sem o site? | **Sim.** Confirmado em 14/11/2026 com uma chamada sem nenhum cabeçalho de autorização e com ação inexistente: respondeu `400 acao_invalida` (lista as ações). O CORS só limita **navegadores**; `curl` ignora. Origem não é proteção. |
| CPF e nascimento bastam para operar? | **Sim.** Quem souber os dois de outra pessoa consegue ver marcações, cancelar, remarcar, marcar e atualizar contato dela. É a mesma garantia que o próprio Klingo oferece no portal. **Risco residual aceito até você decidir sobre um segundo fator** (SMS/e-mail; ver §5). |
| Há limite contra tentativas repetidas? | **Antes: só um.** 5 nascimentos errados por hora **por CPF** (olhando só cadastros existentes). Não havia limite por IP, nem de escritas, nem de pedidos por minuto; a cota global do Klingo (10 fichas, 1/s) protegia o Klingo, mas **qualquer um podia esgotá-la** e derrubar o chat. **Agora:** ver §3. |
| Dá para marcar ou cancelar agendamento de terceiros? | **Marcar para outro CPF sim** (se souber CPF + nascimento, igual a qualquer portal). **Cancelar, remarcar, trocar procedimento, check-in e resultado só valem para voucher que está entre as marcações ATIVAS da sessão do próprio paciente** (teste: `cancelar com id de outro paciente` não envia nenhum `DELETE`). Preservado e agora também testado como chamada direta. |
| O paciente está autorizado a executar a operação? | Sim para o que é dele (acima). `confirmar: true` é obrigatório nas ações que escrevem. |
| Dá para preservar o comportamento atual com proteção adicional? | **Sim, e foi feito:** mesmo contrato, mesmas respostas para quem usa normalmente. |

## 3. O que foi corrigido (versão 1.1, pronta e **não publicada**)

Arquivos: `supabase/functions/klingo-agendamento/{index.ts,regras.ts}` e `supabase/klingo-agendamento-seguranca.sql`.

| Proteção nova (no servidor) | Padrão | Chave para ajustar (`config`) |
|---|---|---|
| Pedidos por minuto, por IP (qualquer ação) | 60 | `agendamento_ip_por_minuto` |
| Escritas (marcar, cancelar, remarcar, cadastrar…) por hora, por IP | 30 | `agendamento_ip_escritas_hora` |
| Escritas por hora, por CPF (de qualquer IP) | 8 | `agendamento_cpf_escritas_hora` |
| Nascimentos errados por hora, por IP | 15 | `agendamento_ip_divergentes_hora` |
| Nascimentos errados por dia, por CPF | 10 | `agendamento_cpf_divergentes_dia` |
| Desligar sem publicar nada | `sim` | `agendamento_externo_modo`: `sim` (normal) · `leitura` (só consulta, nada escreve no Klingo) · `nao` (tudo recusado) |
| O mestre `klingo_auto = nao` também bloqueia **escrita** pela função pública | — | `klingo_auto` |

* Só hashes são guardados (`klingo_agendamento_evento`): nenhum CPF, nascimento, nome nem IP em claro; retenção de 30 dias; RLS ligada sem política (anon e usuário logado não leem nem chamam).
* **Falha segura:** se o banco não responder, a função recusa (`503 trava_indisponivel`) em vez de liberar.
* Os valores padrão **preservam o uso de hoje**; apertar é decisão sua. O limite de 30 escritas por IP existe para não travar uma recepção que usasse a página para vários pacientes na mesma rede.
* Cada chamada ganha um **registro de auditoria** (ação, resultado `ok`/`recusado`/`divergente`/`bloqueado_*`).

## 4. Compatibilidade com quem já usa a função

* **Contrato igual.** Mesmas ações, mesmos campos, mesmas respostas de sucesso. Nada mudou na forma de chamar.
* **Três respostas novas possíveis** (sempre com `ok: false` e `mensagem` em português pronta para mostrar): `429 limite_servidor` (muitas tentativas), `503 desligado` (gestão desligou) e `503 trava_indisponivel` (banco fora). O site que usa a função deve **exibir `mensagem`** nesses casos; quem já mostra `mensagem` dos erros não precisa mudar nada. **Eu não tenho o código desse site**; se ele não mostra `mensagem`, a alteração é só exibir esse campo.
* **Ordem de publicação:** primeiro `supabase/klingo-agendamento-seguranca.sql`, depois a função 1.1. Se a ordem inverter, a função recusa tudo por segurança (nunca libera) até o SQL ser aplicado. Reversão: publicar de volta a versão 2 anterior.

## 5. O que continua dependendo de você (decisão, não código)

1. **Segundo fator** para ações que escrevem (código por SMS ou e-mail): muda o contrato e o site; não foi feito. Sem ele, o risco é "quem sabe CPF + nascimento age em nome do paciente", igual ao portal do Klingo.
2. **Valores dos limites** (tabela do §3) se a rede da clínica tiver muitos pacientes atrás do mesmo IP.
3. Se o site que usa a função fica no domínio `clinicacsiia.github.io` (único permitido pelo CORS) ou noutro: se for noutro, ele já não funciona em navegador hoje; me diga o endereço para incluir.

## 6. Testes (todos com dados inventados e Klingo SIMULADO)

* `supabase/functions/klingo-agendamento/agendamento.test.ts`: **36 de 36** (29 da função original + 7 novos de chamada direta: toda ação passa pela trava antes do Klingo, trava recusando devolve 429 sem chamar o Klingo, desligamento devolve 503, banco fora não libera, ação desconhecida não gasta trava, nascimento errado marca "divergente", paciente A não cancela voucher de B). Os testes da versão 1.1 de 13/11 sobre telefone/portal/equipe foram retirados porque descrevem código **que nunca foi publicado**.
* `testes/sql-klingo-agendamento-seguranca.test.mjs`: **12 de 12** (ritmo por IP, escritas por CPF e por IP, divergências, desligamento, mestre, só hashes, idempotência da migração, permissões de anon/logado/service).
* **Não testado contra o Klingo real** (nenhuma chamada real foi feita). A única chamada à função publicada foi `acao: "inexistente"` para provar o acesso sem autorização (não toca Klingo nem grava nada).
