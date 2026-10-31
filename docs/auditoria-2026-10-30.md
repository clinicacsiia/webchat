# Auditoria para produção — 30/10/2026

Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial

Escopo pedido: auditar o que já funciona, rodar os testes necessários para ir a produção e atualizar os documentos. Nada foi mesclado na `main` e nada foi alterado no banco, no n8n ou no GitHub Pages de produção por esta auditoria (só leituras e testes; o único efeito no banco foram dois segredos no Vault, criados antes, ver 4.3).

**Resposta curta.** O sistema que já estava no ar (chat, painel, catálogo, conferência, aprendizado) estava saudável nas evidências que dá para obter daqui no momento da medição; as Fases 6 e 7 entraram depois e **não foram auditadas** (ver 2.6). O módulo **Fila + assinatura biométrica não está pronto para produção**: falta a tela do paciente (`fila/fila.js`), a aba da recepção, os dois workflows do n8n, o SMTP e a aplicação da migração v2 no banco. Este documento separa o que foi provado do que não foi.

## 1. Como ler as evidências

| Selo | Significa |
|---|---|
| **Provado em produção** | Consultado no projeto real (Supabase, GitHub, n8n) nesta data. |
| **Provado em teste** | Passou na bateria de `testes/` e dos testes de código. Vale para o código; não prova o ambiente real. |
| **Não provado** | Não deu para verificar daqui. Está dito o porquê e quem confere. |

Limite do ambiente: a rede desta sessão bloqueia `*.supabase.co`, o n8n e o Klingo. Tudo que é "real" veio pelos conectores (MCP). Não houve navegador contra o Supabase real nem e-mail enviado.

## 2. Sistema que já estava no ar

### 2.1 Provado em produção

| Item | Evidência |
|---|---|
| Deploy do site | Na medição: 15 de 15 publicações do Pages com sucesso, a última na `main` em `223d1d3` (PR #14). Reconferido às 16:10 UTC: 19 publicações; a #18 (merge do PR #18, 13:43 UTC) **falhou** por causa do Jekyll (`{{ }}` nos documentos do n8n) e a #19 (13:46 UTC, `.nojekyll`) corrigiu; a `main` atual, `2dc0d62`, está publicada com sucesso. |
| Crons (6 jobs ativos) | Últimas 24 h: `agenda-conferir` 2.346 de 2.346 execuções com sucesso (a cada 15 s); `agenda-ocupacao` 27 de 27; `agenda-revisar` 59 de 59; `sync-catalogo-klingo`, `catalogo-precos-convenio` e `catalogo-precos-particular` 1 de 1 cada. Zero falhas. |
| Objetos das Fases 1 a 5 | O checklist da seção 2 de `docs/passagem-fases-3-a-5.md` deu `true` em todos os itens (6 crons, `paciente_historico`, conferência da Fase 3, `historico_paciente` em `ia_contexto`, reaproveitamento em `ia_pre_agendar`), mais `ia_evento` e `preco_observado` presentes, com 148 leituras de preço gravadas. |
| Migrações | 24 registradas na medição (`webchat_schema_inicial` até `fila_biometria_revogar_gatilhos`); hoje são 27, com as 3 correções de identidade da seção 2.6. Pacientes, preços, Fase 2 e Fase 4 não aparecem com nome próprio na lista, embora os objetos existam: o histórico de migrações **não** serve como receita para recriar o banco (já avisado na passagem de bastão). |
| Edge Function | `sync-catalogo-klingo` publicada e chamada pelos crons. |
| n8n | Workflow `Triagem IA - Atendimento` (`wAbzjPqZNCztKriZ`) ativo. |
| Advisors de segurança | Sem erro (ERROR). Quatro grupos de aviso, todos explicados em 2.3. |

Atenção ao que "sucesso" quer dizer: o `pg_cron` só prova que a chamada HTTP foi disparada. Se a Edge Function responde 502, o cron continua verde. É o caso do item 2.4.1.

### 2.2 Provado em teste

| Suíte | Resultado |
|---|---|
| Edge Function (conferência e preços) | 27 de 27 |
| Navegador, páginas existentes (chat, painel deslogado, painel admin com as 6 abas, cada aba) | 4 de 4, sem exceção de JavaScript |

O teste de navegador usa Supabase simulado com as formas reais de `ia_relatorio`, `ia_precos_divergentes` e demais RPCs. Prova que o código das telas carrega e monta; não prova os dados.

### 2.3 Avisos do advisor (todos conferidos, nenhum exige correção de código)

| Aviso | Quantidade | Avaliação |
|---|---|---|
| `rls_enabled_no_policy` (INFO) | 13 tabelas | Intencional: tabelas internas (`catalogo_*`, `agenda_*`, `conversa_segredo`) com RLS ligado e nenhuma policy, ou seja, negam tudo e só são acessadas por funções `security definer`. Conferido no código: o chat e o painel não leem nenhuma delas direto (`.from()` só em `conversas`, `agentes`, `pre_agendamentos`, `pre_agendamento_itens`, `mensagens`, `contatos`, `config`, `paciente_historico`). |
| `anon_security_definer_function_executable` (WARN) | 20 funções | Intencional: são as RPCs do chat (protegidas pelo token da conversa) e da IA (protegidas por `ia_segredo`), mais as do módulo Fila. |
| `authenticated_security_definer_function_executable` (WARN) | 34 funções | Intencional: as mesmas mais as da equipe, que conferem `papel_atual()` por dentro. |
| `auth_leaked_password_protection` (WARN) | 1 | **Real e fácil de corrigir.** Ver 2.4.4. |

### 2.4 Achados no sistema existente

Do mais para o menos importante.

1. **Preços do catálogo — MÉDIO (medido como ALTO, rebaixado pela Fase 6b).** O comparador de preços (`ia_precos_divergentes`) achou 18 pares exame/operadora em que o valor do catálogo difere em 10% ou mais do `Previsto` lido do Klingo, em 104 pares comparados. Na medição, a IA usava o catálogo para falar preço ao paciente, e por isso o achado era alto. **Depois disso** a Fase 6b (aplicada às 13:41 UTC) tirou o preço da IA: conferido no banco real, `ia_catalogo` já não entrega valores (`ia_sem_preco = true`), então a IA não tem de onde citar preço. O catálogo passou a servir de referência para o alerta "Conferir valor", que só a equipe vê quando o atendente escreve um valor; com 18 divergências esses alertas podem ser falsos ou deixar de aparecer. **Ressalvas:** (a) o roteiro da Fase 6 dizia que o n8n ainda publicava o prompt antigo, que "ainda pode falar preço"; desde a Fase 7 isso só importa se `config.motor` voltar para `ia`, porque com `fluxo` (valor atual no banco real) a IA não responde o paciente; (b) as 18 divergências **não foram remedidas** depois da mudança. **Recomendação:** publicar o prompt novo no n8n (passo 1 do roteiro da Fase 6) e a recepção revisar a lista (aba Aprendizado, "Preço x Klingo") antes de confiar nos alertas.
2. **Dependência frágil do n8n — era MÉDIO; hoje só vale se voltarem para a IA.** O nó de IA do workflow depende de créditos do *n8n Gateway* e não tem nova tentativa nem workflow de erro. Na medição isso deixaria o paciente sem resposta e ninguém seria avisado. Desde a Fase 7 o banco real está com `config.motor = 'fluxo'`: o motor de regras responde sem IA e sem n8n, e o fluxo do n8n fica publicado só como plano B. **Se voltarem para `ia`:** credencial Anthropic própria, `retryOnFail` no nó e um workflow com *Error Trigger* que avise a equipe. **Risco novo no lugar dele:** os avisos à equipe por WhatsApp e e-mail ainda não existem (`docs/fase7-motor-implementado.md`, seção 6); quem pede um atendente só é visto por quem estiver com o painel aberto.
3. **502 nas execuções de `agenda-ocupacao` — BAIXO, esperado.** São a proteção da Edge Function contra relatório de agenda vazio (ela se recusa a apagar a ocupação quando o Klingo devolve zero linhas). Acontecem fora do horário em que há agenda. **Recomendação:** começar o cron na hora em que a agenda abre, ou aceitar como ruído. Não corrompe dado.
4. **Proteção contra senha vazada desligada — BAIXO.** Supabase > Authentication > Passwords > ligar "Prevent use of leaked passwords". Não dá para ligar por MCP.
5. **Segredo `ia_segredo` digitado nos nós HTTP do n8n — BAIXO/MÉDIO.** Já estava registrado na passagem de bastão. **Recomendação:** mover para credencial *Header Auth* do n8n, o mesmo padrão adotado para a Fila.
6. **Índices — INFO.** Chaves estrangeiras sem índice e índices nunca usados aparecem no advisor de performance. Com o volume atual não pesa; revisar quando a base crescer.

### 2.5 Não provado no sistema existente

- **Marcação real no Klingo** (Fase 3). A conferência foi provada em teste e no banco, mas nenhum paciente real passou por ela. É a pendência nº 1 da `docs/passagem-fases-3-a-5.md`.
- **Configurações do painel do Supabase**: "Allow new users to sign up", "Confirm email", URL de redirecionamento. Não aparecem por MCP. Conferir à mão (`LEIAME.md`, seção "Primeiro acesso").
- **Código publicado da Edge Function x repositório.** Não foi feita a comparação byte a byte. Baixe a versão publicada (Supabase > Edge Functions) e compare com `supabase/functions/sync-catalogo-klingo/` antes de confiar que são iguais.
- **Chat e painel contra o Supabase real em navegador.** A rede da sessão bloqueia; o teste usou Supabase simulado.

### 2.6 Mudanças que entraram depois das medições acima

As medições das seções 2.1 a 2.5 foram feitas por volta das 11:00 UTC. Depois disso outras sessões mudaram o sistema em produção, em duas rodadas.

**Rodada 1 (11:27 a 11:34 UTC), PRs #16 e #17.** Três migrações no banco real: `correcao_nome_por_conversa` (11:27), `correcao_login_nome_telefone_email` (11:31) e `correcao_login_email_sem_fallback` (11:32).

| Item | Situação |
|---|---|
| O que mudou | Colunas `conversas.nome_informado` e `email_informado`; `chat_iniciar`, `ia_contexto`, `paciente_conferir`, `pre_pendencia_anterior`, gatilho do histórico, `ia_pre_agendar` e a conferência da agenda passam a usar o nome desta conversa; reaproveitar cadastro exige nome E telefone (e e-mail, se o cadastro tem); o painel mostra o nome informado. |
| Conferido depois das mudanças | As colunas e as funções novas existem no banco real; `paciente_conferir` só devolve `completo` ou `novo`; os 6 crons seguem ativos; o módulo Fila não foi tocado (21 funções, 0 atendimentos). A bateria completa de `testes/` passa sobre a `main` já mesclada: 27 + 27 + 46 + 5 + 6. |
| **Não reauditado** | Avisos do advisor de segurança e de performance; o comportamento real da IA com a regra nova de login (exige conversa de teste com o n8n e o Claude); o painel novo contra o Supabase real. |
| Atenção | A terceira migração (`correcao_login_email_sem_fallback`) está descrita só como comentário em `supabase/correcao-login-nome-telefone-email.sql` ("aplicado como patch"). O arquivo diz que já reflete o patch, mas não comparei com o banco linha a linha. Antes de recriar o banco a partir desses arquivos, confira com `pg_get_functiondef('public.paciente_conferir(uuid)'::regprocedure)`. |
| Documento corrigido | O `LEIAME.md` ainda descrevia o status "parcial" em duas frases; foi corrigido com base no banco real. |

**Rodada 2 (13:40 a 13:47 UTC), PRs #18 e #19: Fase 6 e Fase 6b.** Cinco migrações no banco real (`fase6_unidade_filho_e_ia_contexto`, `fase6_remove_chat_iniciar_antiga`, `fase6_catalogo_horarios_identidade`, `fase6_consulta_e_irmaos`, `fase6_fecha_funcoes_internas`, de 13:40 a 13:42) e a `fase6b-alerta-preco.sql`, que foi rodada no SQL Editor e por isso **não aparece** na lista de migrações.

| Item | Situação |
|---|---|
| O que mudou | Formulário do chat com unidade e "quem será atendido" (próprio ou filho), médico de preferência, consulta no calendário, vários filhos por conversa; a IA deixa de receber preços; alerta de valor só para a equipe (`alerta_preco`); `chat_iniciar` antiga removida. O chat (`index.html`) e o painel mudaram bastante. |
| Conferido depois das mudanças | Todas as 12 verificações do roteiro da Fase 6 deram `true` no banco real (unidades, tipos, irmãos, consulta, catálogo, identidade, `alerta_preco`, gatilho de preço, IA sem preço, uma só `chat_iniciar`), mais os 6 crons ativos. O módulo Fila não foi tocado (21 funções, 0 atendimentos). `pacientes` não foi alterada, e o `INSERT` da `fila_entrar` é compatível com as colunas reais. A bateria completa de `testes/` passa sobre a `main` já mesclada, inclusive o teste de navegador do chat novo: 27 + 27 + 46 + 5 + 6. |
| **Não reauditado** | Avisos do advisor (a Fase 6 fechou funções internas, não medi o efeito); o chat novo contra o Supabase real; o roteiro de 16 testes da Fase 6, que ainda não foi executado e o próprio documento dela diz que os passos 12 e 13 são os únicos sem prova em produção. |
| Pendência da época (superada pela rodada 3) | O roteiro da Fase 6 dizia que o n8n ainda publicava o prompt antigo e que o chat novo falaria com ele. A Fase 7 tirou a IA da conversa (`config.motor = 'fluxo'`), então isso só volta a valer se `motor` voltar para `ia`. Não verifiquei o n8n. |
| Publicação | O deploy do merge do PR #18 falhou (Jekyll) e o do PR #19 corrigiu; ver 2.1. |

**Rodada 3 (30/10 18:04 UTC e 31/10 02:19 a 02:43 UTC), PR #21: Fase 7, atendimento sem IA.** Oito migrações no banco real (`fase7_motor_parte1_base` até `fase7_ordem_dos_campos`) e, antes delas, `webhook_n8n_token_header` (30/10, 18:04 UTC), de outra sessão e **não revisada** por mim.

| Item | Situação |
|---|---|
| O que mudou | Um motor de regras no banco (gatilho `mensagens_motor_fluxo` chamando `fluxo_avancar`) responde o paciente na mesma chamada que grava a mensagem. Chat só de botões e listas, OCR do pedido médico no celular, foto do pedido guardada para a equipe, contador ao vivo, presença da equipe no painel, novo cron `fluxo-exames` e novo `sw.js` (cache por chave única `./`). `index.html` reescrito. |
| Conferido depois das mudanças | `config.motor = 'fluxo'` no banco real. 7 crons ativos (os 6 de sempre mais `fluxo-exames`). Fila intacta: 21 funções, 0 atendimentos, 0 registros, e `pacientes` com `perfil_biometrico_historico`. Advisor de segurança sem ERROR: 16 INFO (as 3 novas são tabelas internas sem policy), 30 avisos de `anon` e 48 de `authenticated` (as novas são as RPCs do chat, protegidas pelo token da conversa, e do painel, protegidas por `papel_atual()`) e 1 de senha vazada. `painel_anexo` só responde a admin e atendente. `chat_anexo_enviar` exige o token da conversa e aceita só JPG, PNG e WebP, até 2.000.000 caracteres em base64 e 6 fotos por conversa. A bateria completa de `testes/` passa sobre a `main` já mesclada, com o formulário novo do chat. |
| Conflito tratado | O `sw.js` novo guarda toda navegação sob a chave `./`. Aceitar só o lado da `main` serviria a página do chat no lugar de `/fila/`. A exclusão de `/fila/` foi mantida e ganhou teste próprio (`testes/sw.test.mjs`, 10 verificações); sem a regra o teste falha. |
| **Não reauditado** | O motor em si. O documento da Fase 7 relata testes em transações desfeitas e no Chromium com respostas gravadas, e diz que a ligação chat e Supabase em produção precisa ser conferida no celular; não repeti. Também não revisei: a retenção e o consentimento das fotos de pedido médico (dado de saúde, LGPD art. 11), o limite global de armazenamento das fotos (hoje só 6 por conversa e o limite de conversas por telefone), e o efeito de desligar a IA sobre a rotina da recepção. |
| Atenção | Com a IA fora, a tela depende de quem está com o painel aberto. Os avisos por WhatsApp e e-mail à equipe ainda não existem. |

## 3. Módulo novo: Fila + assinatura biométrica

### 3.1 Provado em teste

| Suíte | Resultado | O que cobre |
|---|---|---|
| `test:python` | 27 de 27 | Sete características do traço, distância *z-score*, score `1/(1+d)` com 4 casas, aprovação com score ≥ 0,30, enrolamento da primeira assinatura, perfil por média móvel (janela 20), 3 tentativas, série inválida sem lançar, execução com os *builtins* restritos do n8n. |
| `test:sql` | 46 de 46 | Instalação e idempotência; só a recepção entra na fila; token JWT HS256 assinado no banco e aceito pelo PyJWT; token adulterado, `alg: none`, truncado, expirado e de outra audiência recusados; falha fechada sem o segredo no Vault; `anon` só enxerga a própria linha e nunca `email_informado`; máquina de estados imposta por *trigger*; hash do documento do banco igual ao SHA-256 do navegador; o banco recusa resultado incoerente do Python (limiar, tipo, perfil); 3 reprovações bloqueiam e a quarta é recusada; cancelar desfaz o bloqueio; `registro_assinaturas` e `assinatura_tentativas` imutáveis (UPDATE, DELETE, TRUNCATE); broadcast sem nome nem e-mail; policy do Realtime. |
| `test:delta` | 5 de 5 | O estado v1 aplicado com o delta fica idêntico à instalação nova nas 23 funções (corpo, *definer* e privilégio de execução). O delta é idempotente. |
| `test:navegador` | 2 de 2 na medição | `fila/` sem token mostra "Link expirado ou inválido"; o token sai da barra de endereço. **Só a casca antiga.** Com a pasta `fila/` fora do repositório, esses dois casos são pulados; as páginas do chat e do painel continuam testadas. |

### 3.2 Provado em produção

- O banco real está na **v1**: 21 funções do módulo, com as assinaturas antigas (`fila_emitir_token(text, uuid)` etc.), impressão digital igual à v1 do repositório em 21 de 21.
- Tabelas do módulo existem e estão **vazias** (pacientes, atendimentos, registros, tentativas = 0).
- `config.fila_webhook_url` **não está definida**.
- Dois segredos existem no Vault (`fila_jwt_secret`, `fila_segredo`). O primeiro nunca foi lido. O segundo foi rotacionado depois de aparecer em uma conversa e não foi lido de novo.
- O advisor de segurança não aponta nada do módulo além do que é intencional (2.3).

### 3.3 O que falta, e por que não está pronto

| Peça | Estado | Quem faz |
|---|---|---|
| Migração v2 (`supabase/fila-biometria-v2-delta.sql`) | **Não aplicada.** O Supabase pede confirmação humana para `drop function` e a confirmação expirou. Sem ela, o banco ainda exige o segredo como parâmetro de função e o desenho do n8n não funciona. | Você, no SQL Editor (passo 1 de `docs/fila-biometria.md`). |
| `fila/fila.js`, `fila/index.html`, `fila/fila.css` | **Retirados do repositório.** A versão antiga usava o cliente Supabase com JWT próprio e uma URL de API (`SEU-SERVIDOR-BIOMETRIA`) que não existe mais. | Escrever do zero (Claude). |
| Aba "Fila" da recepção no painel | **Não existe.** | A construir (Claude). |
| Workflow n8n "Fila - emitir link" | **Não existe.** | Você cria a credencial; Claude monta o workflow. |
| Workflow n8n "Fila - validar assinatura" | **Não existe.** | Idem. |
| Credencial SMTP no n8n | **Não existe** (o n8n não tem nenhuma credencial). | Você. |
| `config.fila_webhook_url` | Vazia. | Você, depois que o workflow existir. |
| Teste ponta a ponta com Supabase e n8n reais | **Não feito.** | Você, com paciente de teste (`7190000xxxx`). |

### 3.4 Não provado

- **Realtime por WebSocket** (posição na fila ao vivo): só a regra de acesso e o conteúdo do broadcast foram testados, com o `realtime` simulado.
- **CORS do webhook do n8n** com a origem do GitHub Pages.
- **Entrega do e-mail** e o texto do link.
- **Desempenho do nó Python do n8n** com séries reais de 300 a 5.000 pontos.
- **Calibração do limiar 0,30** com assinaturas reais. É permissivo (aprova distância média de até 2,33 desvios). Serve como reforço, não como prova de identidade.
- **Questões de LGPD** (art. 11, dado sensível): texto de consentimento revisado, prazo de retenção, RIPD. Ver `docs/fila-biometria.md`, seção 8.

## 4. Decisões e fatos que ficaram para trás nesta sessão

### 4.1 Mudança de desenho (Fila)

O primeiro desenho assinava o JWT no n8n com o segredo do projeto Supabase e tinha uma API FastAPI para a validação. O segredo JWT do projeto não é acessível por MCP, e a API exigiria hospedagem. O desenho atual assina e valida o JWT **dentro do banco** (segredo próprio no Vault), roda o Python **no nó Python do n8n** e autentica o n8n por cabeçalho. A API FastAPI e o nó Code que assina JWT foram removidos do repositório.

### 4.2 Segredos

Uma tentativa de gravar o segredo `fila_segredo` dentro de um workflow do n8n foi **bloqueada** pelo controle de segurança do ambiente. Foi respeitado: o segredo foi rotacionado (sem ser lido) e o desenho passou a usar uma credencial *Header Auth* do n8n que **você** cria. Nenhum segredo está em arquivo do repositório nem em workflow.

### 4.3 O que esta sessão alterou em produção

- Banco: migrações `fila_biometria_v1` e `fila_biometria_revogar_gatilhos` (aditivas; tabelas vazias), dois segredos no Vault, rotação de `fila_segredo`.
- n8n: um workflow temporário criado e arquivado (`vbsk5gmM2T9LO8ry`). O workflow ativo não foi tocado.
- GitHub: a branch `ccr-37cc4eeb-fi5p2l` e o PR #15 (rascunho, **sem merge**). O Pages não muda enquanto o PR não for mesclado.

## 5. Veredito

| Área | Pronto para produção? |
|---|---|
| Chat, painel, catálogo, conferência, aprendizado | **Sim, com condições, até a Fase 5.** As Fases 6 e 7 entraram depois da medição e **não foram auditadas**; a Fase 7 já está ligada para as conversas novas (`config.motor = 'fluxo'`) e o próprio documento dela diz que a ligação chat e Supabase precisa ser conferida no celular. Ressalvas: essa conferência no celular, a falta de aviso à equipe fora do painel (2.4, item 2), a marcação real ainda não validada (2.5) e a proteção contra senha vazada desligada. |
| Fila + assinatura biométrica | **Não.** Faltam as peças de 3.3. Só o banco (v1) e o algoritmo estão prontos e testados. |

Ordem sugerida para fechar a Fila: ver `docs/fila-biometria.md`, seção 5.

## 6. Como repetir

```bash
cd testes && npm install && export CHROMIUM_PATH=/caminho/do/chromium && npm test
```

Instruções e limites em `testes/README.md`.

## 7. Rodada 4 (31/10/2026): PRs #15, #20 e #22 reunidos em um só

Os três PRs abertos foram reunidos em um único, **somente com acréscimos**: o chat, o motor de fluxo da Fase 7 e as regras de atendimento não mudam.

| Origem | O que entrou | O que ficou de fora ou mudou |
|---|---|---|
| #20 | Documentação da correção do n8n (`docs/n8n-correcao-2026-10-31.md`) e as versões corretas para o rollback | O texto sobre execuções do n8n por mensagem agora vale só para `config.motor = 'ia'` |
| #22 (Fase 8) | Leitura do pedido com IA, cartões por exame, painel de conferência, `ler-pedido` | Nada mudou no código. SQL, função e secret continuam **por ligar** |
| #15 | Banco, algoritmo, testes, auditoria e a regra de `/fila/` no `sw.js` | A pasta `fila/` (tela antiga) saiu do repositório |

**Não reauditado:** a Fase 8 (a primeira vez que a IA volta a tocar numa foto do paciente, agora só para sugerir opções) e a ligação real do chat com o banco novo.

**Pontos a decidir antes de ligar a Fase 8** (nenhum foi alterado no código; ver `docs/fase8-leitura-do-pedido.md`, seção 5):

1. Teto de gasto da API: a função é pública e o limite atual é por conversa (6 fotos), não global.
2. LGPD: a foto do pedido (dado de saúde) passa a ir para um provedor de IA e as leituras ficam guardadas. Falta o aviso de privacidade e o prazo de retenção, que já estavam pendentes para as fotos.
3. Modelo: o padrão é `claude-opus-5-5`. Comparar com um modelo menor (`OCR_MODELO`) usando a view `ocr_treino` quando houver fotos conferidas.
4. A chamada à API não foi testada com chave real; acompanhar as primeiras fotos.
