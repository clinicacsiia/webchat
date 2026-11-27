# Integração do sistema de marcação por etapas (TesteWebchat) com a produção

Versão 1.1 — 25/11/2026 / Mudança: **construído e testado no clone, tudo desligado** (parte 1 do banco, `etapas.js`/`etapas.css`, troca no `index.html` atrás da chave `marcacao_etapas_modo`; testes `test:marcacao-etapas-sql` e `test:marcacao-etapas`). **Nada foi aplicado na produção e o `index.html` só muda o comportamento quando a chave estiver em `piloto` ou `sim`.** Versão 1.0 — 24/11/2026: pesquisa e desenho.

Este documento diz **o que foi feito**, **como trocar o botão Começar** quando o dono pedir, **como voltar atrás** e **o que ficou pendente**. Não substitui `painel/testedowebchat/LEIAME.md` (o que o ambiente de teste faz) nem `docs/DOCUMENTACAO.md` (como a produção funciona).

## 1. A decisão de engenharia (e por quê)

A página de teste é uma **tela nova com regras simuladas no navegador**. A produção é um **motor no banco** (`chat_*`, `fluxo_*`, `klingo_*`, `app_*`) ligado à conversa do paciente. A tela de teste **não passava** por regras que o chat real aplica hoje:

| Regra da produção (já no ar) | Onde fica |
|---|---|
| PIN de 30 min e cadastro completo para abrir o chat | `app_pin_exigir`, `app_porta`, `/acesso/` |
| CPF + nascimento conferidos no Klingo | `fluxo_proximo`, `klingo_identificar` |
| Horários só se a API do Klingo ofereceu, com validade, por conversa | `chat-agenda-api`, `klingo_oferta`, `chat_horarios` |
| Escolher horário só entre as ofertas vivas | `chat_horario_escolher` |
| Marcar de verdade, com trava e operação auditada | `klingo_pode_marcar`, `klingo_operacao_criar`, `klingo-executar` |
| Valor **Particular** mostrado e aceito antes de marcar | `particular_valor_*` |
| Retorno com menos de 30 dias e primeira consulta com a médica: só atendente | `retorno_recente_ok`, `primeira_consulta_ok` |
| Convênio suspenso/desativado; plano exato do convênio | `convenio_ativo`, `plano_exato_*` |
| Só a unidade autorizada marca sozinha; médico escolhido nunca é trocado | `unidade_marca_auto`, `klingo_prof_confere` |
| Limite de mensagens, conversa duplicada, token da conversa | `chat_responder`, `chat_iniciar`, `chat_valida` |
| Equipe vê e assume no painel; "Acompanhe seus pedidos" | `conversas`, `pre_agendamentos`, `app_pedidos` |

**Trocar o botão ligando a tela de teste ao navegador seria abrir um caminho paralelo sem essas travas.** Por isso a tela de produção (`etapas.js`) **só desenha o que o servidor manda**: cada resposta vai por `chat_responder`, `chat_consulta_salvar` e `chat_horario_escolher`, as mesmas funções e travas do chat de hoje. **Nenhuma regra de negócio mora na tela.** O que a tela não entende vai para o chat de sempre, **na mesma conversa** ("Continuar no chat").

## 2. O que foi construído

| Peça | Arquivo | O que faz |
|---|---|---|
| Chave e piloto | `supabase/marcacao-etapas-parte1.sql` | `config.marcacao_etapas_modo` = `nao` (padrão) \| `piloto` \| `sim`; `config.marcacao_etapas_telefones` (lista do piloto, **nunca** sai pela `chat_config`); `marcacao_etapas_pode(telefone)`; `chat_config()` devolve o modo. |
| Ciência no servidor | mesmo arquivo | Tabela `marcacao_ciencia` (fechada ao público) e `marcacao_ciencia_registrar(...)`: **hora do servidor, IP que a plataforma informa, só campos permitidos do aparelho**, PIN + token da conversa, limite de 5 por hora, nota na conversa para a equipe. Apagar a conversa apaga a ciência. |
| Tela por etapas | `etapas.js`, `etapas.css` | Renderiza as perguntas do motor: escolha (com busca e "outro"), campos, consulta, calendário (via `chat-agenda-api` → `chat_horarios` → `chat_horario_escolher`), marcando, fim. Barra de progresso, Voltar (`chat_voltar`), "Falar com a equipe". |
| Troca do botão | `index.html` (`iniciar()`, `init()`, PIN) | Só abre a tela por etapas se `modo` deixar. Irmãos "juntos" **sempre** vão para o chat de sempre. Se `etapas.js` não carregar, segue no chat de sempre (mesma conversa). Recarregar a página volta à mesma pergunta. |
| Cache | `sw.js` | `etapas.js` e `etapas.css` entram no cache; `VERSAO` v82; chat `2026.11.24-1`. |
| Testes | `testes/sql-marcacao-etapas-parte1.test.mjs` (19 casos), `testes/marcacao-etapas.navegador.mjs` (11 casos, navegador de verdade falando com o **motor real** num clone do banco), `testes/retrato.test.mjs` (agora também confere as chamadas de `etapas.js`) | |

**Pré-marcação:** não é um caminho separado. Quando o paciente escolhe **"Não sei qual é o meu plano"** ou **"Nenhum desses horários serve"**, a tela mostra o aviso e o **botão vermelho** "Estou ciente"; só depois disso grava a ciência e envia a resposta ao motor, que leva o pedido para a equipe (como já faz hoje). **"Não, obrigado: quero falar com a equipe"** usa o pedido de atendente que já existe.

## 3. Como trocar o botão Começar (quando o dono pedir)

Nada abaixo foi feito. Cada passo tem a volta.

1. **Conferir a `main`** (`git fetch`, comparar com as migrações aplicadas em `supabase_migrations.schema_migrations`). O dono trabalha em várias sessões.
2. **Aplicar `supabase/marcacao-etapas-parte1.sql` em partes** pela ferramenta de migração do Supabase (ela expira em 60 s e pede confirmação em comandos que parecem destrutivos): (a) as duas linhas de `config`; (b) `chat_config()`; (c) `marcacao_etapas_pode`; (d) a tabela e o índice; (e) `marcacao_ciencia_registrar`; (f) os `revoke/grant`. Link: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/sql/new
3. **Medir na produção** (só estrutura/contagens): as 2 funções existem; `select valor from config where chave='marcacao_etapas_modo'` = `nao`; `chat_config()` traz a chave. Depois **refazer o retrato** (`supabase/producao/LEIAME.md`) e rodar `npm run test:retrato` (a linha "aguardam a migração" some).
4. **Publicar a tela** (juntar a PR do `index.html`/`etapas.*`/`sw.js` na `main`; o GitHub Pages publica em ~1 minuto). Com a chave em `nao`, **o botão de hoje continua igual**.
5. **Piloto:** `update public.config set valor = '<telefones separados por vírgula>' where chave='marcacao_etapas_telefones'; update public.config set valor='piloto' where chave='marcacao_etapas_modo';` — a equipe faz **uma marcação real e uma pré-marcação** de ponta a ponta e confere no painel (Atendimento).
6. **Todos:** `update public.config set valor='sim' where chave='marcacao_etapas_modo';` — com a equipe de plantão; acompanhar erros técnicos por 24 h.
7. **Limpeza:** apagar as funções `teste-agenda-klingo` e `teste-planos-klingo` (ver pendência 8) e refazer o retrato.

**Voltar atrás, a qualquer hora, sem publicar nada:** `update public.config set valor='nao' where chave='marcacao_etapas_modo';` — quem já está no meio de uma conversa por etapas **continua** no chat de sempre, na mesma conversa. Reversão do banco: bloco `ROLLBACK` no fim de `supabase/marcacao-etapas-parte1.sql`.

## 4. As 10 falhas da revisão de segurança: situação

| # | Falha | Situação |
|---|---|---|
| 1 | Sem identificação | **Resolvida:** o chat de produção já exige PIN e cadastro; a tela usa a mesma conversa (`chat_iniciar` com PIN no servidor) e CPF + nascimento do motor. |
| 2 | Regras só no navegador | **Resolvida:** as regras são do motor. A tela não tem configuração local. |
| 3 | Marcação simulada | **Resolvida:** marca o motor (`klingo_pode_marcar` + `klingo-executar`). |
| 4 | Ciência forjável | **Resolvida:** gravada pelo servidor (hora, IP, aparelho filtrado). |
| 5 | Dados pessoais no aparelho | **Resolvida:** a tela não guarda nada além do que o chat de hoje já guarda (`conversa` e `perfil`); sem foto de carteirinha. |
| 6 | Funções de teste esgotando a cota | **Resolvida na tela** (usa `chat-agenda-api`, com token e cota). **Pendente:** apagar as funções `teste-*` ainda publicadas (pendência 8). |
| 7 | "Não" → WhatsApp sem verificação | **Resolvida:** só quem passou pelo PIN chega aqui; o pedido de atendente é o que o chat já usa. |
| 8 | `supabase-js@2` sem versão fixa/SRI; sem CSP | **Pendente** (vale para o chat inteiro, não só para esta tela). |
| 9 | LGPD | **Pendente** (textos, prazo de guarda, advogado). |
| 10 | Restos de teste | **Resolvida:** nada de faixa laranja, ⚙ ou `[Teste]` em `etapas.js`. |

## 5. Pendências (anotadas; nada disto bloqueia o piloto)

**Decisões do dono**
1. **Ordem das perguntas.** A tela segue a ordem do motor (CPF e nascimento → consulta → médico(a) → pagamento/plano → horário → dados → conferir). A ordem do protótipo (pagamento primeiro) exige mudar `fluxo_proximo`, que é a função central do chat de hoje: só com teste no clone e atrás de uma chave por conversa. **Não foi feito.**
2. **Foto da carteirinha.** O chat de hoje **removeu** o passo ("carteirinha-removida"); a tela por etapas também não pede. Se o dono quiser a foto de volta, usar o envio de anexo que já existe (`chat_anexo_enviar`).
3. **Prazo de 24 h para completar a pré-marcação.** **Feito em 27/11/2026** (vencimento no servidor: `docs/integracao-teste-no-piloto.md`, última seção). **"Completar agora" pelo celular continua não existindo** no piloto: quem recebe os arquivos é a equipe. O Klingo **não reserva** horário; a tela diz que a pré-marcação não garante o horário.
4. **Caixa "Entendi: se o chat não conseguir marcar sozinho, o pedido só vale quando uma pessoa da equipe confirmar".** Ela continua **obrigatória** no formulário de produção (o dono a retirou só do ambiente de teste). Decidir se sai (a ciência da pré-marcação já cobre o caso).
5. **Aviso da equipe quando o paciente diz "Não, obrigado".** Hoje vira um pedido de atendente na fila (como "Falar com um atendente"). Confirmar que a equipe quer isso.
6. **Telefones do piloto.** A lista nasce **vazia**: em `piloto`, ninguém entra até o dono informar.
7. **Texto jurídico.** `privacidade.html` e `termos.html` precisam citar a ciência (data/hora, IP e aparelho), o prazo de guarda e a revisão do advogado (`docs/lgpd.md` seção 6). A tabela `marcacao_ciencia` **não tem limpeza periódica** (só apaga com a conversa); definir o prazo.

**Técnicas**
8. **Apagar `teste-agenda-klingo` e `teste-planos-klingo`** no Supabase depois do piloto: estão publicadas, abertas (só a origem é conferida) e gastam a cota do Klingo do chat real. https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions
9. **Hardening do chat inteiro:** fixar a versão do `supabase-js` no jsDelivr com `integrity` (SRI) e acrescentar CSP ao `index.html` (a `/acesso/` já tem).
10. **Teste de ponta a ponta com o Klingo de verdade** (marcação real) só acontece no piloto; o clone não fala com o Klingo.
11. **O que a tela ainda manda para o chat de sempre** (por segurança): irmãos "juntos", exames, "outro assunto", médico sem horário com solicitação de disponibilidade, resultado, remarcar/cancelar. Pode ser levado para a tela por etapas aos poucos.
12. **Revisar na prática no celular** (leitura de tela, teclado numérico dos campos CPF/data) durante o piloto.

## 5.1 Testes que já falhavam ANTES desta mudança (comparados com o commit anterior, `e57af26`)
Rodei a bateria inteira (`npm test`, que para na primeira falha) e depois **cada teste restante sozinho**. Tudo o que falhou, falhava igual no commit anterior: **nenhuma falha vem da tela por etapas**. O que é teste velho de uma tela que mudou de propósito:

| Teste | Causa (conferida) | Situação |
|---|---|---|
| `test:ponta-a-ponta` (2 casos) | Desde 23/11 (`dados-ja-salvos`) o chat **não pergunta mais** `dados_contato` quando celular e e-mail já vieram do formulário; o teste ainda esperava a pergunta. | **Corrigido** (sequência esperada atualizada). |
| `test:voltar-sql` (2 casos) | Mesma causa: voltar passa direto pelo que já está salvo (nome, sexo, celular, e-mail). | **Corrigido.** |
| `test:previsao-sem-conta-atendente` (1 caso) | O caso "ANTES" esperava reproduzir o defeito antigo, mas o retrato da produção **já traz a correção**. | **Corrigido** (agora prova que a correção está no ar). |
| `test:previsao-escolha-pagina` (6 casos) | A página de Previsão trocou turno, "a partir das", "até as" e unidade por **dia e horário preferidos** (commit `f2e5bed`, 23/11); o teste ainda usa `#apos`, `#ate`, Manhã/Tarde. | **Pendente:** reescrever os casos para o formulário novo (`#dia`, `#hora`, `#plano`) e para o texto novo do pedido à equipe. |
| `test:sentinela-navegador` (7 casos de "pedido de exames" e "lado") | Procuram um botão **"Lista"** que a tela de escolha de exames não tem mais. | **Pendente:** reescrever para a tela atual. |
| `test:pessoa` (1 caso) | Painel em janela baixa (560 px): a área das mensagens tem 79 px e o teste exige 90 px. **Pode ser um incômodo real da equipe em tela baixa**, não só do teste. | **Pendente:** decidir (ajustar a tela ou o limite). |
| `test:painel-v2` (1 caso) | Aba Indicadores: o teste espera um elemento que não aparece em 10 s. | **Pendente:** investigar. |
| `test:acesso-chat` (2 casos) | Layout da tela inicial do acesso rápido (não cabe sem rolar em 390x780; "Começar" fica depois de "Acompanhe seus pedidos" no teste). Mais uma falha **ocasional** ("Para Leo") só quando a máquina está ocupada. | **Pendente:** decidir se o layout atual é o desejado e ajustar o teste. |

## 6. O que NÃO foi feito (para não haver surpresa)

- Nenhuma migração aplicada; nenhuma função publicada; nenhuma chave de `config` criada na produção.
- Nenhum endpoint ao vivo foi chamado; o clone não fala com o Klingo.
- O PIN no navegador foi coberto no banco (`test:marcacao-etapas-sql`, `test:acesso-pin-servidor`), não num navegador com o teclado do PIN.
