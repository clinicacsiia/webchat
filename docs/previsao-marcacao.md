# Webchat de Previsão de marcação (17/11/2026)

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
