# Webchat de Previsão de marcação (17/11/2026)

Versão 1.3 — 23/11/2026 / Mudança: **pedido de previsão reabre a conversa encerrada** (`supabase/previsao-reabre-conversa.sql`; ver a seção "Conversa encerrada: o pedido reabre" no fim).
Versão 1.2 — 18/11/2026 / Mudança: **a lista do painel mostra só quem abriu a página** (`supabase/previsao-marcacao-so-quem-abriu.sql`; `painel_pmarc_lista` e `painel_pmarc_resumo`). O registro a partir do Klingo continua por trás.
Versão 1.1 — 17/11/2026 / Mudança: **tela "Pedir uma previsão"** (escolher o exame ou a consulta, turno / a partir de / até / até o dia, ou não escolher e ver a disponibilidade; funções `pmarc_catalogo`, `pmarc_disponibilidade`, `pmarc_pedido`).
Versão 1.0 — 17/11/2026 / Mudança: primeira versão. Segundo webchat, separado do chat de marcação: registra TODA pessoa com marcação aberta no Klingo, mostra a ela a PREVISÃO e abre uma conversa que a equipe responde no painel.

## O que o dono pediu
- Um HTML separado (`previsao/index.html`), com funções novas.
- Puxar o relatório **#14359** e outro (**#14554**) para saber quais exames e consultas estão marcados.
- **Registrar todo mundo o mais rápido possível** (pré-cadastro) e deixar a conversa disponível para a atendente responder.
- Se a pessoa responder **"não sei"** ou **"seguimos"**: **não bloquear, não barrar** pela confirmação de que é uma previsão; **anotar o que houver** e **avisar que a previsão será vista e confirmada pelo webchat, WhatsApp e telefone**.

## Como funciona
```
Klingo #14359 (por data do exame) ─┐
Klingo #14554 (CPF/e-mail/nasc.) ──┤→ Edge Function pmarc-cadastrar (a cada 10 min) → pmarc_pessoa (pré-cadastro, uma linha por pessoa)
                                   │                                                        │ chave = a MESMA da Jornada (prontuário ou "n:"+hash)
Jornada (jornada_exame, 30 s) ─────┴→ as marcações abertas de cada pessoa são lidas dali, na hora, por pmarc_itens
                                                                                            │
 Equipe (painel > "Previsão de marcação"): copia o link / abre o WhatsApp com o texto pronto ┘
 Paciente (previsao/index.html?c=CÓDIGO) → vê a previsão → responde (3 botões ou texto) → deixa dados → conversa com a equipe
 Conversa (conversas/mensagens normais, robô DESLIGADO) → aparece na lista de atendimento do painel como qualquer outra
```
- **Registro:** `pmarc_lote` (nome, celular e telefone do #14359, só marcação *Aberta*) e `pmarc_enriquecer_lote` (e-mail, nascimento e "tem CPF" do #14554, achado pelo id da marcação). **O CPF do Klingo não é guardado**, só se existe. O que o paciente digitar fica em `informado`.
- **Rotina:** `pmarc-cadastrar` (pg_cron, 10 min) → `pmarc_vigiar()` → Edge Function. Modos: `rapido` (#14359 de hoje a +7 dias e #14554 dos últimos 3 dias), `completo` (#14359 de hoje a +1 ano, de hora em hora) e `enriquecer` (#14554 de uma faixa `{de, ate}` de até 31 dias, para completar o passado).
- **Nunca barra:** `pmarc_responder` aceita tudo (e-mail, CPF, celular ou nascimento fora do padrão são anotados com marca "conferir"). `pmarc_classificar` entende "não sei", "seguimos", "pode seguir", "talvez" (= não sei), "sim/certo/ok" e "não/errado/diferente". Sem celular a resposta é guardada e a página só pede o celular.
- **Aviso em toda tela:** o texto vem de `config` (`previsao_marcacao_aviso`, `previsao_marcacao_final`): "…PREVISÃO… vista e confirmada pela nossa equipe, pelo webchat, pelo WhatsApp e por telefone".
- **Conversa:** `pmarc_conversa_garantir` cria o contato (origem `previsao`) e a conversa com `ia_ativa = false` (o motor do chat não responde). Só nasce quando a pessoa responde/escreve ou a atendente clica **Iniciar conversa**. O pré-cadastro sozinho **não** vira contato (o marketing exporta contatos).
- **Sem o link:** celular + nascimento (8 erros por hora por celular travam e oferecem "falar com a equipe"); quem não acha entra assim mesmo (`pmarc_novo`, "chegou sozinho(a)").

## Quem aparece na lista do painel (18/11/2026)
A janela **Atendimento > Previsão de marcação** mostra **só** quem: abriu a página ou o link de previsão (`primeiro_acesso_em`), chegou sozinho(a) pelo botão (`origem = espontaneo`) ou já tem conversa. Quem foi apenas registrado a partir do Klingo e nunca abriu **não aparece** (eram 2.906 de 2.912 em 18/11/2026; a lista passou de 2.912 para 6). **Nada foi apagado**: a leitura do Klingo continua registrando, porque a Jornada, o link pessoal e o botão **Escolher e ver a disponibilidade** dependem desse cadastro. O resumo do topo conta só quem aparece. Voltar atrás: `supabase/previsao-marcacao-so-quem-abriu-rollback.sql` (só `create or replace`). Para apagar de vez o pré-cadastro do Klingo seria outra decisão (não feita).

## Arquivos
| Arquivo | O quê |
|---|---|
| `supabase/previsao-marcacao-parte1-tabelas.sql` … `parte4-carga.sql` | Banco (aplicado em 17/11/2026 como `pmarc_parte1_tabelas`, `parte2a_ajudantes`, `parte2b_publicas`, `parte3_painel`, `parte4_carga`) |
| `supabase/previsao-marcacao-rollback.sql` | Apaga tudo (rodar no editor SQL: tem `drop`) |
| `supabase/functions/pmarc-cadastrar/` | Edge Function (`verify_jwt=false`, só responde com `x-sync-key`) + `mapa.test.ts` |
| `previsao/index.html` | Página do paciente (sem robô, sem PIN, sem CPF obrigatório) |
| `painel/index.html` (`abrirPrevMarc`) | Botão **Previsão de marcação** no Painel de atendimento (painel `sw.js` v59) |
| `testes/sql-previsao-marcacao.test.mjs` (26 casos), `previsao-marcacao.navegador.mjs` (13), `previsao-marcacao-painel.navegador.mjs` (9) | Provas no clone da produção e em navegador |

Os nomes começam com `pmarc_` porque `previsao_vigiar`, `previsao_responder` e `painel_previsao_lista` **já existem** na produção (motor da disponibilidade futura): o teste no clone pegou a colisão antes de aplicar.

## Entrada do paciente: Começar e/ou Previsão (Configurações)
Em **Configurações > Entrada do paciente (Continuar ou Previsão)** há duas chaves (`entrada_webchat_modo`, `entrada_previsao_modo`; `supabase/entrada-previsao.sql`):
| Começar (webchat) | Previsão | O que o paciente vê na primeira tela do chat |
|---|---|---|
| ligado | desligada | como sempre (padrão de hoje) |
| ligado | ligada | botão **Começar** e botão **Previsão de marcação** |
| **desligado** | ligada | **some o Começar** (e o formulário); só o botão Previsão, que leva a `previsao/` |
| desligado | desligada | não vale: o painel recusa salvar e, se vier assim do banco, o webchat volta sozinho |
O chat lê as chaves por `chat_config()` ao abrir; sem rede ou sem a chave, abre só o webchat. Conversa já aberta no aparelho continua abrindo direto. Teste: `npm run test:entrada-previsao` (7 casos) e um caso no teste do painel. O botão do formulário continua com o texto "Começar" (o nome atual no chat).

## Pedir uma previsão: escolher o exame e o horário, ou só ver a disponibilidade (17/11/2026)
A página só mostrava as marcações que já existiam. Agora, em **três lugares** (primeira tela sem link, tela da previsão e conversa) há o botão **Escolher e ver a disponibilidade**:
1. **O que você quer?** Lista do que a clínica **fez nos últimos 30 dias** (marcação com status atendido na Jornada, casada pelo nome) mais as **consultas por especialidade que têm agenda** (a Jornada só guarda "CONSULTA MEDICA", sem a especialidade). Abas Tudo / Consultas / Exames / Outros e busca pelo nome; adicionais e pacotes (contraste, sedação, acrescentar…) ficam de fora. Em 17/11/2026 eram 216 itens (23 consultas, 176 exames, 17 outros), 214 com agenda. "Não achei o que procuro" aceita texto livre.
2. **Quando você prefere?** Turno (manhã, tarde, noite ou sem preferência), "a partir das", "até as", "até o dia" e unidade. **Nada é obrigatório**: dá para tocar direto em "Ver a disponibilidade".
3. **Disponibilidade prevista:** até 10 dias com até 8 horários cada. A pessoa pode tocar num horário (opcional) e **Pedir esta previsão para a equipe**. Quem não tem link deixa só o celular. O pedido vira mensagem na conversa com a equipe (robô desligado), com o horário que a pessoa viu, marcado "previsão, não reservado".
- **De onde vêm os horários:** a conta antiga de previsão do banco (`agenda_horarios`): grade do Klingo (`catalogo_agenda`, relatório #13984) menos a ocupação lida dos relatórios #7 e #47 (`agenda_ocupacao`), com 2 h de antecedência. **Não chama a API do Klingo** (ela exige CPF, nascimento e convênio) e **não reserva nada**. Pode divergir da agenda real; por isso o aviso em toda tela e a confirmação da equipe.
- **Planos (cuidado do dono, 17/11/2026):** a lista é a mesma para qualquer plano e **não mostra preço nem cobertura**. A página avisa que cobertura, autorização e valor dependem do plano e que a equipe confirma; o campo **plano/convênio** é opcional e vai para a equipe como "conferir". A disponibilidade **não filtra por convênio** (mostra todos os profissionais da grade) e avisa que alguns profissionais não atendem todos os planos. Item sem agenda: sem botão de horários, "Pedir para a equipe".
- **Segurança:** `pmarc_catalogo` e `pmarc_disponibilidade` não trazem dado de paciente; a disponibilidade tem limite global de 120 consultas por minuto. `pmarc_pedido` usa o código do link e aceita no máximo 10 pedidos por hora por pessoa. Nada barra a pessoa por conteúdo.
- **Arquivos:** `supabase/previsao-marcacao-parte5-escolha.sql` (rollback: `parte5-rollback.sql`), `previsao/index.html` (versão 2026.11.17-2), testes `npm run test:previsao-escolha` (17 casos) e `test:previsao-escolha-pagina` (13 casos); página versão 2026.11.17-3. Não precisa trocar `sw.js` (a página `previsao/` não passa pelo cache do chat).
- Nenhum relatório do Klingo novo ou editado.

## Ligar e desligar
- Chave **`previsao_marcacao_modo`** (`sim`/`nao`). `nao`: a leitura do Klingo não grava, as 6 funções do paciente respondem "desligado" e o painel avisa.
- Rollback total: `supabase/previsao-marcacao-rollback.sql`.

## Segurança e privacidade
- `pmarc_pessoa`, `pmarc_tentativa` e `pmarc_estado`: RLS ligada, **sem permissão de tabela** para anon e logado. O público só executa 6 funções (`pmarc_abrir`, `_identificar`, `_novo`, `_responder`, `_mensagens`, `_enviar`); as internas são só do `service_role`; as `painel_pmarc_*` conferem admin/atendente.
- A credencial do paciente é o **código do link** (24 letras e números) ou celular + nascimento. Quem tem o link vê só as marcações daquela pessoa (nome do exame, dia, unidade).
- Nada de paciente vai para log ou resposta da Edge Function (só contagens).
- **Jurídico (junto com `pendencias-do-dono.md` 2.5):** `privacidade.html` precisa citar o pré-cadastro (nome, celular, e-mail, nascimento de quem tem marcação, vindos do Klingo), o link pessoal e o prazo de guarda.

## Relatórios do Klingo (regra do CLAUDE.md)
Nenhum relatório novo ou editado é necessário. #14359 dá nome, prontuário, celular, telefone, primeira vez e status; #14554 dá e-mail, nascimento e CPF (só "tem CPF"). Se alguém mexer nas colunas do #14359, a leitura acha pelo **título** e **para dizendo qual faltou** (`pmarc_estado.erro`). #14554 é lido pela ordem fixa de `klingo-conferir`.

## O que a equipe faz
1. Abrir **Atendimento > Previsão de marcação**: ver quem foi registrado, o que respondeu e quem não abriu o link.
2. **Copiar link** ou **WhatsApp com o link** (o texto já avisa que é previsão); o envio fica marcado.
3. Quem responde (inclusive "não sei") gera uma conversa na lista normal de atendimento: responder lá. A resposta chega sozinha na página do paciente (a cada 6 s).
4. A previsão **só vira confirmação** depois que a equipe confirma (webchat, WhatsApp ou telefone).

## Achado importante (17/11/2026): o #14359 sem o filtro "marcado em" devolve só o dia de hoje
Medido na primeira leitura: sem o 2º filtro de período do #14359 (**"marcado em", `periodo2`**) o Klingo devolveu **49 linhas** para o ano inteiro (só as marcações feitas hoje; o número crescia ao longo do dia). Com `periodo2` largo (últimos 360 dias até hoje) devolveu **3.158 linhas** (2.388 pessoas). A `pmarc-cadastrar` v1.2 já envia o filtro.
**A `sync-jornada-klingo` (Jornada, a cada 30 s) lê o mesmo relatório SEM `periodo2` no modo rápido/completo** (o último resumo dela mostrava `linhas_klingo: 30` para 7 dias, quando o banco tem ~1.400 marcações nesses dias). Se for isso, a Jornada não está vendo cancelamento, confirmação nem atendimento de marcações feitas em dias anteriores. **Não alterei a Jornada** (função em produção, fora do pedido); a correção é igual à daqui: enviar `:periodo2=l`, `:periodo2-from` (hoje − 360) e `:periodo2-to` (hoje) nas leituras `rapido` e `completo`. Confirmar com você antes de mexer.

## Limites conhecidos
- O envio do link é manual (botão do painel); nenhuma mensagem sai sozinha para o paciente.
- Quem não tem celular em nenhum dos dois relatórios só é alcançado por telefone ou pelo próprio link; a página pede o celular na primeira mensagem.
- O #14554 só enriquece quem já existe no #14359; o passado se completa com o modo `enriquecer` (`select public.pmarc_disparar('enriquecer', '{"de":"2026-10-01","ate":"2026-10-31"}');`).

## Conversa aberta pela atendente não vai para a conta de paciente dela (19/11/2026)
O gatilho `conversas_conta` grava na conversa o login de quem a criou. Quando a atendente (que também tem conta de paciente, com o mesmo login) tocava em **Iniciar conversa**, a conversa da paciente ficava na conta pessoal dela e, ao criar o acesso rápido, aparecia no app dela com o nome da paciente. Agora `pmarc_conversa_garantir` solta a conversa da conta quando quem abriu é a atendente. A conversa que o paciente abre pelo próprio chat continua na conta dele. Arquivo: `supabase/previsao-conversa-sem-conta-da-atendente.sql`; teste: `npm run test:previsao-sem-conta-atendente`.

## Conversa encerrada: o pedido reabre e o paciente vê só a conversa atual (23/11/2026)
**O defeito:** quem já tinha uma conversa na Previsão que a equipe **encerrou** (com a despedida "Meu Tesouro") e voltava a pedir uma previsão tinha o pedido gravado **dentro da conversa encerrada**. O painel só lista conversas abertas, então a equipe **não via o pedido**; e a página mostrava o histórico velho (a despedida) misturado com o pedido novo. Só o botão de escrever mensagem (`pmarc_enviar`) reabria a conversa; o **pedido** (`pmarc_pedido`) e a **resposta** (`pmarc_responder`) não.
**A correção (só banco; a página não mudou):**
- Função nova `pmarc_conversa_reabrir`: se a conversa está encerrada, põe em **aguardando** (entra na fila do painel), sem atendente, **robô continua desligado**, o resumo da triagem volta, e marca em `pmarc_pessoa.informado.msg_desde` onde a conversa atual começa. Também apaga `final_em`, para o aviso "a previsão será vista e confirmada pela equipe…" ser dito de novo.
- `pmarc_pedido`, `pmarc_responder` e `pmarc_enviar` usam essa mesma função (antes só o `pmarc_enviar` tinha a regra, escrita dentro dele).
- `pmarc_mensagens` devolve ao paciente só as mensagens a partir de `msg_desde`. **Nada é apagado:** a equipe vê o histórico inteiro na conversa do painel.
**Caso real:** em 23/11/2026 havia 1 conversa de Previsão nessa situação (pedido de 08h59, conversa encerrada em 19/11); foi reaberta à mão com a função nova e o pedido apareceu na fila. Medido antes: das 9 conversas da Previsão, 8 estavam encerradas e só 1 tinha mensagem do paciente depois de encerrar.
**Arquivos:** `supabase/previsao-reabre-conversa.sql` (rollback: `previsao-reabre-conversa-rollback.sql`, no editor SQL por causa do `drop`), teste `npm run test:previsao-reabre-conversa` (10 casos, incluindo reproduzir o defeito com as funções da produção).
