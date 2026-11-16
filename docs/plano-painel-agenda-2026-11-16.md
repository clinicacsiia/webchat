# Plano: atendente marca, remarca, cancela e vê disponibilidade pelo painel (16/11/2026)

Só análise e proposta. Nada foi aplicado no banco. Fontes: `respostas_prontas` (os atalhos, texto escrito pela equipe), contagens de `conversas`, `klingo_operacao`, `klingo_consulta`, o código do painel e da Edge Function `klingo-executar`. Nenhum texto de paciente foi lido.

## 1. O que os atalhos da equipe mostram (15 atalhos)

| Grupo | Atalhos | O que a atendente está fazendo à mão |
|---|---|---|
| Abrir a conversa | INICIO-ATENDIMENTO-JÁ-SOLICITA-MARCAÇÃO, INICIO-ATENDIMENTO-PEDIU-FALAR-ATENDENTE | Se apresenta e diz que vai "verificar as disponibilidades" |
| Horário | DEMORA-DE-RESPONDER-HORARIO-OFERTADO, NAO-QUIS-HORARIO-OFERECIDO, AGENDAMENTO-CONCLUIDO | Oferece horários por mensagem, cobra resposta, confirma |
| Sem vaga | LISTA-DE-ESPERA, ACEITOU-LISTA-DE-ESPERA, NAO-QUIS-LISTA-ESPERA, LISTA-DE-ESPERA-SURGIU-UMA-VAGA | Lista de espera manual (usa `{medico}`, `{data}`, `{hora}`) |
| Barreira | NAO-ATENDEMOS-O-CONVENIO, QUANDO-MEDICO-NAO-ATENDE-O-CONVENIO, NAO-TEMOS-ESPECIALIDADE | Explica por que não dá |
| Retomada | PACIENTE-PAROU-DE-RESPONDER, QUANDO-PACIENTE-NAO-RESPONDER | Cutuca e encerra por falta de resposta |
| Dado fixo | Endereco | Informa endereço |

Leitura: **o trabalho de atendente hoje é consultar agenda, oferecer horário, esperar, cobrar e, se não há vaga, anotar lista de espera.** Não existe nenhum atalho de cancelar nem de remarcar: isso quase não chega pelo chat (ver 2) ou é feito direto no Klingo.

## 2. Números da produção (29/10 a 16/11/2026, sem teste)

- 396 conversas no total, 49 de teste (sobram 347 reais). 28 abertas agora. Quase todas passam por um humano (370 de 396, contando teste).
- Encerradas por motivo: **não respondido 145**, agendado 90, só informações 37, sem motivo 36, outro 8, nova conversa 4, desistiu 4.
- Ou seja, **a maior perda é paciente que some depois da oferta de horário (145 contra 90 agendados)**. É onde a ajuda do sistema rende mais.
- Operações no Klingo pelo chat: marcar 4 ok/1 falha, cancelar 3/1, remarcar 1/1, ver marcações 3/1. **Todas com origem `chat`; nenhuma `equipe`.**
- Consultas de horário (`klingo_consulta`): 19 com horários, **9 com erro da API**, 3 sem tradução de plano, 3 dados incompletos, 3 sem horários. Quase metade das consultas não devolve horário e a atendente precisa entender por quê.
- Análise de 13/11 (`analise-conversas-2026-11-13.md`): 98% são consulta pediátrica (Desenvoar); "cancelar/remarcar" foi só 19 mensagens em 14 conversas; pico 10h.

## 3. O que já existe (não precisa criar)

- `klingo-executar` já faz **marcar, cancelar, remarcar e ver marcações**, com as travas certas (só mexe em voucher ativo do próprio paciente, identidade conferida, sessão do paciente). A tabela `klingo_operacao` já aceita `origem = 'equipe'`.
- `chat-agenda-api` guarda cada consulta de horário (`klingo_consulta`, `klingo_oferta`).
- O painel tem "Disponibilidade futura" (paciente que pediu aviso), "Exame em aberto" e "Remarcar" (só acompanham e perguntam ao paciente pelo chat; **não executam no Klingo**).
- O que falta é só a **tela do atendente** e uma **função do painel** que crie a operação com `origem = 'equipe'`, exigindo atendente logado.

## 4. Proposta (ordem de valor)

**Etapa 1: Ver disponibilidade na conversa (leitura, sem risco).**
Botão "Ver horários" no painel da conversa: usa o que a conversa já sabe (especialidade/exame, convênio, unidade) e mostra os horários reais da API, com o motivo claro quando não há (erro, sem tradução de plano, sem vaga). Um clique em "Enviar opções ao paciente" gera a mensagem com os horários (substitui os atalhos de oferta). Atende o item "verificar disponibilidade".

**Etapa 2: Sugestões do sistema ("o site se oferece para ajudar").**
Faixa no topo da conversa, só para a equipe, com uma sugestão por vez e um botão:
- paciente pediu horário e há vaga real → "Há 3 horários para Pediatria; enviar?"
- ofereceu e o paciente sumiu há X h → "Cobrar resposta" (já preenche o atalho DEMORA-DE-RESPONDER)
- sem vaga → "Entrar na disponibilidade futura" (substitui os 4 atalhos de lista de espera)
- convênio sem tradução/médico não atende → mostra o atalho certo
- surgiu vaga para quem espera → "Avisar" (preenche LISTA-DE-ESPERA-SURGIU-UMA-VAGA)
Cada sugestão é regra simples e explicável. Nada é enviado sem a atendente tocar.

**Etapa 3: Cancelar e remarcar pelo painel.**
Na conversa e no cartão da Jornada: "Ver marcações do paciente" (operação `ler_vouchers`), depois "Cancelar" ou "Remarcar" (escolhe novo horário real da Etapa 1). Pede confirmação com data e exame por extenso, grava quem fez (`origem = equipe` + atendente) e mostra o resultado. Reaproveita `klingo-executar`, então herda as travas.

**Etapa 4: Marcar pelo painel** (depois de provar as anteriores).

## 5. Decisões que dependem do dono

1. **Quem pode cancelar/remarcar no Klingo pelo painel?** Sugestão: atendente e admin, com registro de quem fez e confirmação.
2. **Mensagens dos atalhos:** a Etapa 2 reaproveita os 15 atalhos. Confirma que posso usar os mesmos textos, com as variáveis (`{nome}`, `{medico}`, `{data}`, `{hora}`)?
3. **Erro da API em 9 de 34 consultas:** vale investigar antes da Etapa 1, senão a atendente verá muita tela de erro.

## 6. Regras do projeto

- Banco: arquivo novo em `supabase/` (fluxograma, versão, rollback) → testar no clone → aplicar em partes → refazer o retrato → `npm run test:retrato`.
- Tela: trocar `VERSAO` nos `sw.js`.
- **Relatórios do Klingo:** nenhuma etapa acima depende de relatório novo (usa só a API de agenda e vouchers). A única pendência de relatório que existe é a da **hora real de atendimento** (`klingo-relatorios-pendentes.md`), que não bloqueia este plano.

## 7. Decisões do dono (16/11/2026)
- Os 15 atalhos podem ser usados nas sugestões (com `{nome}`, `{medico}`, `{data}`, `{hora}`).
- **Sem vaga:** primeiro oferecer outro horário/médico; se o paciente não aceitar nem outro horário, **oferecer o cadastro na Disponibilidade futura** (regra da Etapa 2).
- Investigar e resolver os erros da API (abaixo).

## 8. Erros da API de horários: o que era (16/11/2026)
`klingo_consulta` tem 37 consultas (todas em modo `sim`, 14 e 15/11). Das 9 "erro_api":
| Causa | Qtd | O que é |
|---|---|---|
| 403 "Operadora GEAP com atendimento suspenso" (plano 21) | 5 | **Regra do convênio**, não falha da API. Não era reconhecida e virava "indisponível" para o paciente e entrava na conta de erros que faz o sistema recuar |
| 403 sem mensagem gravada (plano 1, 14/11 17:49 a 17:50) | 3 | Registrados antes de a mensagem ser guardada; a mesma regra de idade (procedimento só até 17 anos) já tratada na v2.1 de 14/11 |
| 403 "só para idade até 17 anos" | 1 | Regra do procedimento; já tratada como regra de negócio desde 14/11 |
Os demais "não-ok" não são erro: `dados_incompletos` 3 e `sem_traducao_plano` 3 são o chat ainda sem CPF/convênio; `api_sem_horarios` 3 é o exame 1659 realmente sem vaga. **Nenhuma falha técnica real (timeout, 5xx, HTML, limite) apareceu.**

**Correção:** `classificar()` passa a tratar "Operadora … suspenso" como `plano_inativo` (o resto do sistema já trata isso como regra de negócio: mensagem de convênio ao paciente, aviso à equipe, fora da conta de erros). Aplicada nas 5 cópias idênticas de `klingo-api.ts`, com teste (`klingo-auto.test.ts`). Testes das Edge Functions: 272 de 272.
**Falta publicar** as Edge Functions que usam essa cópia: `chat-agenda-api`, `klingo-identificar`, `klingo-executar`, `disponibilidade-vigia` e `klingo-sincronizar`. Até publicar, o comportamento na produção não muda.
