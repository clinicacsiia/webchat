# Integração do sistema de marcação por etapas (TesteWebchat) com a produção

Versão 1.0 — 24/11/2026 / Mudança: primeira versão (pesquisa e desenho; **nada foi publicado e nenhuma mudança de banco foi aplicada**).

Este documento diz **o que precisa existir** para trocar o botão **Começar** do chat de produção pelo sistema por etapas de `painel/testedowebchat/`, e **em que ordem** fazer isso sem risco. Ele não substitui `painel/testedowebchat/LEIAME.md` (o que o teste faz) nem `docs/DOCUMENTACAO.md` (como a produção funciona).

## 1. O que a pesquisa mostrou (resumo)

O TesteWebchat é uma **tela nova com regras simuladas no navegador**. A produção é um **motor no banco** (funções `chat_*`, `fluxo_*`, `klingo_*`, `app_*`) ligado à conversa do paciente. Ao ler o motor, ficou claro que **a tela de teste não passa por regras que o chat real aplica hoje**:

| Regra da produção (já no ar) | Onde fica | Na tela de teste |
|---|---|---|
| PIN de 30 min e cadastro completo para abrir o chat | `app_pin_exigir`, `app_porta`, `/acesso/` | **não existe** |
| CPF + nascimento conferidos no Klingo (`cpf_nasc`, identidade) | `fluxo_proximo`, `klingo_identificar` | **não pede** |
| Horários só se a API do Klingo ofereceu, com validade, por conversa, sexo e nascimento do paciente | `chat-agenda-api`, `klingo_oferta`, `chat_horarios` | usa função própria sem token e sem paciente |
| Escolher horário só entre as ofertas vivas; "esse horário acabou de ficar indisponível" | `chat_horario_escolher` | só confere no navegador |
| Marcar de verdade, com trava e operação auditada | `klingo_pode_marcar`, `klingo_operacao_criar`, `klingo-executar` | simulado |
| Valor **Particular** mostrado e aceito antes de marcar | `particular_valor_*` | **não existe** |
| Retorno com menos de 30 dias e primeira consulta com a médica: só atendente | `retorno_recente_ok`, `primeira_consulta_ok` | **não existe** |
| Convênio suspenso/desativado | `convenio_ativo`, `convenio_avisar` | **não existe** |
| Plano exato do convênio (id do Klingo) | `plano_exato_*` | existe (lista real), mas sem gravar |
| Só a unidade Desenvoar marca sozinha | `unidade_marca_auto` | lista fixa no navegador |
| Médico escolhido nunca é trocado | `klingo_prof_confere` | só no navegador |
| Limite de mensagens por minuto, conversa duplicada, token da conversa | `chat_responder`, `chat_iniciar`, `chat_valida` | **não existe** |
| Equipe vê, assume e responde no painel; "Acompanhe seus pedidos" | `conversas`, `pre_agendamentos`, `app_pedidos` | só `localStorage` |

**Conclusão de engenharia:** trocar o botão ligando a tela de teste ao próprio navegador seria **abrir um caminho paralelo sem as travas**. O caminho certo é a tela nova **conduzir o motor que já existe** (mesmas funções, mesmas travas), e só criar no servidor o que o motor **ainda não tem**.

## 2. Arquitetura escolhida

1. **Troca atrás de uma chave.** Nova chave em `config`: `marcacao_etapas_modo` = `nao` (padrão: botão atual) | `piloto` (só números de telefone de uma lista) | `sim` (todos). Entra em `chat_config()` (já é pública e já carrega `entrada_webchat_modo`). **Desligar = uma linha de SQL**, sem publicar nada. O ponto único de troca é `iniciar()` em `index.html` (hoje chama `chat_iniciar`; no teste chama `CSI_MARCACAO.abrir`).
2. **A identidade vem do acesso rápido.** A tela só abre depois do PIN (portão atual do chat). Nome, telefone, e-mail, CPF e nascimento vêm do cadastro (`app_perfil` / `app_chat_dados`), então a tela **não digita** esses dados. Filho(a): igual ao chat de hoje (`p_paciente_tipo = 'filho'`).
3. **A tela vira um "condutor" do motor.** Ela guarda as respostas (pagamento, convênio, plano…) na ordem pedida pela diretoria, mas **só as envia na ordem que o motor exige**, sempre conferindo o passo atual devolvido pelo servidor (`chat_responder` recusa resposta de passo errado). Assim `fluxo_proximo` continua sendo a única fonte da ordem e das travas.
4. **Cada etapa da tela usa a função real:**

| Etapa da tela | Função real (já existe) |
|---|---|
| abrir | `chat_iniciar` (PIN no servidor, limite de 5 conversas/h, aceite LGPD) |
| consulta | `chat_consultas` → `chat_consulta_salvar` |
| médico(a) | `chat_medicos_disponiveis` / passo `medico` |
| pagamento, convênio | passo `plano` (`fluxo_aplicar`; recusa convênio inativo) |
| plano | passo `plano_exato` (valor = id do Klingo, ou `nao_sei`) |
| horário | `chat-agenda-api` (token da conversa) → `chat_horarios` → `chat_horario_escolher` |
| valor Particular | passo `valor` |
| resumo / confirmar | passo `confirmar` → `fluxo_finalizar` → `klingo_pode_marcar` → `klingo-executar` |
| acompanhar, remarcar, cancelar | `app_pedidos`, `app_pedido_acao`, `app_marcacao_cancelar` (já existem) |
| avisar equipe | `fluxo_finalizar_humano` / `fluxo_transferir` (a equipe vê no painel) |

5. **Nada de regra no navegador.** Antecedência de 24 h, prazo, limite de 2 remarcações, carteirinha obrigatória, consulta ativa: **decididas pelo servidor** (`config` + funções). Os botões de teste (⚙ Configurar, "[Teste] simular…", "Apagar dados do teste") **não vão** para a produção.
6. **As funções `teste-agenda-klingo` e `teste-planos-klingo` saem de cena.** Hoje elas já estão publicadas, abertas ao público (só a origem é conferida) e **gastam a mesma cota do Klingo do chat real**. Depois do piloto, apagá-las em https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions.

## 3. O que o motor ainda NÃO tem (precisa ser criado, com teste e rollback)

| # | Peça nova | Por quê | Observação |
|---|---|---|---|
| N1 | **Ciência da pré-marcação gravada no servidor** (hora do servidor, IP, aparelho, texto aceito) | hoje o registro é do navegador e pode ser forjado; IP não existe | tabela nova só de escrita por função; sem leitura pública |
| N2 | **Pré-marcação com prazo para completar** (24 h, configurável) | o motor manda para a equipe ou abre "previsão"; não há "completar depois" | reaproveitar `pre_agendamentos` (`rascunho`) + prazo; avisar quando vencer |
| N3 | **Médico de interesse e preferências (período/dias)** na pré-marcação | hoje só `medico_preferido` e `previsao_*` | pode caber em `conversa_fluxo.dados` sem tabela nova |
| N4 | **"Não" na pré-marcação → equipe chama no WhatsApp** | hoje não existe esse desfecho | reaproveitar `fluxo_transferir` com motivo próprio |
| N5 | **Foto da carteirinha** | o chat de hoje **removeu** o passo ("carteirinha-removida"); só a foto do pedido existe (`chat_foto_enviar`/`chat_anexo_enviar`) | decisão do dono; se mantiver, usar o envio de anexo já existente |
| N6 | **Chave `marcacao_etapas_modo` e lista do piloto** | troca reversível | entra em `chat_config()` |
| N7 | **Limite global de buscas de horário** | proteger a cota do Klingo | o `chat-agenda-api` já tem `cotaGlobal` |

## 4. As 10 falhas da revisão de segurança e como ficam resolvidas

1. Sem identificação → portão do PIN + CPF/nascimento do cadastro (item 2 e 4 acima).
2. Regras no navegador → regras no servidor (item 5).
3. Marcação simulada → `klingo_pode_marcar` + `klingo-executar` conferem o horário de novo.
4. Ciência forjável → N1.
5. Dados no aparelho → a tela só guarda a conversa (token já existente); **sem foto nem dados pessoais no `localStorage`** além do que o chat de hoje já guarda; limpar ao concluir.
6. Funções de teste esgotando a cota → `chat-agenda-api` com token e cota; funções de teste apagadas.
7. "Não" → WhatsApp sem verificação → só quem passou pelo PIN chega aqui (N4).
8. `supabase-js@2` sem versão fixa/SRI e sem CSP → fixar versão e `integrity`; copiar o CSP da `/acesso/`.
9. LGPD → atualizar `privacidade.html` (ciência com IP/aparelho, carteirinha), prazo de guarda e revisão do advogado (pendente do dono).
10. Restos de teste → remover faixa laranja, ⚙, `[Teste]`, `testeBloqueio` e "TESTE" do manifesto.

## 5. Como será testado (nada vai ao ar sem isto verde)

- **Banco (clone da produção):** novo `testes/sql-marcacao-etapas.test.mjs` — caminho completo (PIN → consulta → plano → horário → confirmar), as travas (PIN ausente, CPF inválido, convênio inativo, retorno < 30 dias, Particular sem aceitar o valor, horário que expirou, médico trocado), pré-marcação com prazo, ciência gravada, "Não" → WhatsApp, limite de conversas. Reaproveitar `banco-producao.mjs` e `sql-ponta-a-ponta.test.mjs`.
- **Navegador:** `testes/marcacao-etapas.navegador.mjs` (Playwright) com o mock de `testes/mock-chat.mjs`: ordem das telas, "Voltar/Corrigir", falha da agenda, tela sem rede.
- **Regressão obrigatória:** `npm run test:retrato` (hoje 10/10 verde), `test:ponta-a-ponta`, e os testes do chat (`test:c1`, `test:horarios`, `test:acesso-chat-sql`, `test:particular-valor`, `test:retorno-30-dias`).
- **Depois de cada migração aplicada:** medir na produção (só estrutura, contagens e erros) e **refazer o retrato** (`supabase/producao/LEIAME.md`).

## 6. Plano de publicação (passo a passo, cada passo reversível)

1. Migrações **em partes pequenas**, cada uma com `rollback` — só **depois do seu OK** (mudam a produção, mesmo sem ninguém usar).
2. Publicar a tela nova **com a chave em `nao`** (o botão de hoje continua igual). Trocar `VERSAO_APP` e as `VERSAO` dos `sw.js`.
3. Ligar `piloto` para 1–2 telefones da equipe; fazer uma marcação **real e uma pré-marcação** de ponta a ponta; conferir no painel.
4. Se algo errar: `update public.config set valor = 'nao' where chave = 'marcacao_etapas_modo';` (volta na hora).
5. Abrir para todos (`sim`) com a equipe de plantão; acompanhar erros técnicos e a fila por 24 h.
6. Apagar `teste-agenda-klingo` e `teste-planos-klingo`; refazer retrato; atualizar `DOCUMENTACAO.md`.

## 7. Decisões que só o dono pode tomar (pendências)

1. **Foto da carteirinha:** manter (volta um passo que o chat tirou) ou seguir sem foto, como o chat de hoje? (N5)
2. **Prazo de 24 h para completar a pré-marcação** e a **reserva provisória do horário**: o Klingo **não reserva** horário por 24 h. Aceitar que o horário "guardado" é só um **desejo** (a equipe confirma) ou criar uma regra operacional com a equipe? (N2)
3. **"Não, obrigado" → a equipe chama no WhatsApp:** confirma que a equipe quer receber esse aviso na fila do painel?
4. **Piloto:** quais telefones da equipe entram na lista (`piloto`)?
5. **Texto jurídico:** prazo de guarda, revisão do advogado em `privacidade.html` e `termos.html` (já pendente em `docs/pendencias-do-dono.md`).
6. **Convênios que exigem "plano do cadastro"** (Bradesco, SulAmérica, Central Nacional Unimed, Unimed Seguros, Amor Saúde): seguem o motor (plano exato ou equipe).

## 8. O que NÃO foi feito ainda (nesta versão do documento)

- Nenhuma migração escrita ou aplicada; nenhuma mudança em `index.html` de produção; nenhuma função publicada.
- O motor não foi executado de ponta a ponta com a tela nova.
- Não foi testado nenhum endpoint ao vivo.
