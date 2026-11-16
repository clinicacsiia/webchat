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
**Publicada em 16/11/2026:** `chat-agenda-api` v25 (é onde o erro acontecia; teste de fumaça: 400 "Pedido inválido" para pedido vazio). As outras quatro cópias (`klingo-executar`, `klingo-identificar`, `disponibilidade-vigia`, `klingo-sincronizar`) já estão corrigidas no repositório e **ainda não foram publicadas**: o efeito prático seria só uma mensagem melhor quando o Klingo recusar a marcação ou a vigia por convênio suspenso.

## 9. Etapa 1 feita (16/11/2026): ver horários dentro da conversa
- **Botão "Ver horários"** no topo da conversa aberta (admin e atendente). Abre uma janela com os horários livres da API, por dia; a atendente marca os que quer oferecer e **"Inserir na resposta"** coloca o texto na caixa (ela revisa e envia; nada é enviado nem reservado sozinho).
- **Função `painel-horarios`** (Edge Function, `verify_jwt` ligado; só leitura): confere o papel pelo login, usa o pedido da conversa (consulta ou exame, convênio, CPF e nascimento já informados) e a mesma cota da API do chat. Não grava nada.
- **Mensagens claras** em vez de código: convênio inativo/suspenso, sem médico credenciado, idade/sexo, dados que faltam (diz quais), pedido com vários exames, limite do Klingo.
- **Sem vaga:** explica o caminho combinado: ver os próximos 14 dias (até 4 janelas), oferecer outro médico/unidade e, **se o paciente não aceitar nenhuma opção, oferecer a Disponibilidade futura**. O botão que já cadastra na Disponibilidade futura a partir daqui fica para a Etapa 2.
- Tela: `sw.js` v36. Teste novo `npm run test:horarios` (5 casos). Sem mudança de banco.

## 10. Etapa 2 feita (16/11/2026): ofertas com ação e área de avisos enxuta
**O que a atendente vê agora (sempre visível, abaixo do aviso do topo):**
- **Há vaga e ninguém ofereceu:** cartão "N horários livres · próximo: dia, hora, médico" com **Oferecer** (abre a escolha de horários) e **Dispensar**.
- **Ofereceu:** cartão "Horários oferecidos" com **Aceitou** / **Recusou** / **Cobrar resposta** (coloca o atalho `DEMORA-DE-RESPONDER-HORARIO-OFERTADO` na caixa, sem enviar).
- **Sem vaga:** **não oferece horário**. Cartão "Sem vaga agora" com **Oferecer Disponibilidade futura** (coloca o atalho `LISTA-DE-ESPERA` na caixa e registra a oferta), **Ver outros dias** e **Dispensar**.
- **Recusou os horários:** só sobra a Disponibilidade futura. Se oferecida e o paciente aceitar, **Aceitou: cadastrar** grava o pedido (aviso pelo chat e pela equipe) e coloca `ACEITOU-LISTA-DE-ESPERA` na caixa. Se recusar também, **nenhum cartão volta**.
- Os cartões só aparecem na conversa **assumida por quem está olhando**; exame em aberto, remarcar e valor fora da referência saíram de dentro do "detalhes e avisos" e ficaram na mesma faixa, com os mesmos botões e **sem os textos explicativos**. A área "detalhes e avisos" ficou só com o que é consulta (conversas unidas, histórico, triagem, fotos, pré-agendamento).
- A faixa nunca passa de ~28% da altura da tela (rola por dentro), para não espremer as mensagens.

**Regra "recusou uma vez, não oferece mais":** guardada no banco (`painel_oferta`), vale para a pessoa inteira (todas as conversas unidas) e é conferida pelo servidor (`painel_oferta_registrar` devolve `bloqueado`), não só pela tela. "Dispensar" tem o mesmo efeito. A consulta de vagas nem é feita depois de uma oferta ou recusa.

**Banco** (`supabase/painel-ofertas.sql`, aplicada em 3 partes em 16/11/2026; retrato v1.24): tabela `painel_oferta` (fechada ao público) e `painel_oferta_registrar`, `painel_ofertas`, `painel_disponibilidade_registrar` (admin e atendente). Teste: `npm run test:painel-ofertas` (10). Tela: `npm run test:ofertas` (9), `sw.js` v37.
**Achado:** o campo de origem dos eventos de disponibilidade corta em 40 letras; `painel_disponibilidade_cancelar` (já existente) grava `equipe:<id>` (43) e perde o fim do id. Não mexi nela; a nova grava `equipe` e o atendente no detalhe.
**Ainda não feito:** o cadastro grava com período padrão (a partir de amanhã por 60 dias, qualquer turno). Escolher dias/turno pela tela fica para depois.

## 11. Etapa 3 feita em parte (16/11/2026): ver e cancelar marcações pelo painel
- **Botão "Marcações"** no topo da conversa (admin e atendente): consulta o Klingo (ao vivo, só as próximas) e mostra dia, hora, exame, unidade e profissional. **Cancelar** pede confirmação com data, hora e exame e avisa que **o paciente não é avisado por aqui** (a atendente avisa).
- **Como funciona por baixo:** reaproveita as operações do chat (`klingo_operacao` `ler_vouchers` e `cancelar`, origem `equipe`) e a mesma Edge Function `klingo-executar`, que abre a sessão do paciente, confere a identidade e só cancela marcação ATIVA dele. As chaves `klingo_api_consultar` e `klingo_api_cancelar` da conversa valem (hoje `sim`).
- **Travas:** só admin/atendente; CPF e nascimento já informados; só cancela o que apareceu numa consulta feita há menos de 10 min; uma só operação por marcação; se a tentativa anterior ficou "incerta", **bloqueia nova tentativa até conferir no Klingo**; se o paciente está no passo "ver marcações" do chat, não mexe.
- **O paciente não recebe mensagem nem é transferido** por este caminho: `klingo_cancelamento_aplicar` ganhou um ramo para `detalhe.por = 'painel'` (só atualiza as marcações e deixa nota no resumo da equipe); o ramo do paciente ficou igual.
- Banco: `supabase/painel-marcacoes.sql` (aplicada em 3 partes; retrato v1.25): `painel_marcacoes_pedir`, `painel_marcacoes`, `painel_marcacao_cancelar`, `painel_marcacao_op`. Testes: `test:painel-marcacoes` (13, simulam o executor) e `test:marcacoes` (6). `sw.js` v38.
- **Não provado com o Klingo de verdade:** os testes simulam o executor. O primeiro cancelamento real deve ser feito pelo dono com um paciente de teste que ele autorize.
- **Ainda NÃO feito: remarcar pelo painel.** Hoje: cancelar aqui e escolher o novo horário em "Ver horários". Remarcar de uma vez (a API aceita `remarcacao`) pede escolher o horário novo e conferir que o antigo saiu; fica para a próxima etapa.
- **Ainda NÃO feito: marcar pelo painel** (Etapa 4) e escolher dias/turno ao cadastrar na Disponibilidade futura.
