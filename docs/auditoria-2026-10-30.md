# Auditoria para produção — 30/10/2026

Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial

Escopo pedido: auditar o que já funciona, rodar os testes necessários para ir a produção e atualizar os documentos. Nada foi mesclado na `main` e nada foi alterado no banco, no n8n ou no GitHub Pages de produção por esta auditoria (só leituras e testes; o único efeito no banco foram dois segredos no Vault, criados antes, ver 4.3).

**Resposta curta.** O sistema que já estava no ar (chat, painel, catálogo, conferência, aprendizado) está saudável nas evidências que dá para obter daqui. O módulo **Fila + assinatura biométrica não está pronto para produção**: falta a tela do paciente (`fila/fila.js`), a aba da recepção, os dois workflows do n8n, o SMTP e a aplicação da migração v2 no banco. Este documento separa o que foi provado do que não foi.

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
| Deploy do site | GitHub Actions: 15 de 15 publicações do Pages com sucesso; a última é a `main` em `223d1d3` (PR #14). |
| Crons (6 jobs ativos) | Últimas 24 h: `agenda-conferir` 2.346 de 2.346 execuções com sucesso (a cada 15 s); `agenda-ocupacao` 27 de 27; `agenda-revisar` 59 de 59; `sync-catalogo-klingo`, `catalogo-precos-convenio` e `catalogo-precos-particular` 1 de 1 cada. Zero falhas. |
| Objetos das Fases 1 a 5 | O checklist da seção 2 de `docs/passagem-fases-3-a-5.md` deu `true` em todos os itens (6 crons, `paciente_historico`, conferência da Fase 3, `historico_paciente` em `ia_contexto`, reaproveitamento em `ia_pre_agendar`), mais `ia_evento` e `preco_observado` presentes, com 148 leituras de preço gravadas. |
| Migrações | 24 registradas (`webchat_schema_inicial` até `fila_biometria_revogar_gatilhos`). Pacientes, preços, Fase 2 e Fase 4 não aparecem com nome próprio na lista, embora os objetos existam: o histórico de migrações **não** serve como receita para recriar o banco (já avisado na passagem de bastão). |
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

1. **Risco de dado, ALTO — 18 de 104 preços divergentes.** O comparador de preços (`ia_precos_divergentes`) achou 18 pares exame/operadora em que o valor do catálogo difere em 10% ou mais do `Previsto` lido do Klingo, em 104 pares comparados. A IA usa o catálogo para falar preço ao paciente. **Recomendação:** a recepção revisar a lista (aba Aprendizado, "Preço x Klingo") antes de divulgar a IA a mais pacientes; enquanto isso, tratar como risco de informar preço errado. O sistema já diz ao paciente que o preço é previsão e que a atendente confirma.
2. **Dependência frágil do n8n — MÉDIO.** O nó de IA do workflow depende de créditos do *n8n Gateway* e não tem nova tentativa nem workflow de erro. Se os créditos acabarem ou a chamada falhar, o paciente fica sem resposta e ninguém é avisado. **Recomendação:** credencial Anthropic própria, `retryOnFail` no nó e um workflow com *Error Trigger* que avise a equipe.
3. **502 nas execuções de `agenda-ocupacao` — BAIXO, esperado.** São a proteção da Edge Function contra relatório de agenda vazio (ela se recusa a apagar a ocupação quando o Klingo devolve zero linhas). Acontecem fora do horário em que há agenda. **Recomendação:** começar o cron na hora em que a agenda abre, ou aceitar como ruído. Não corrompe dado.
4. **Proteção contra senha vazada desligada — BAIXO.** Supabase > Authentication > Passwords > ligar "Prevent use of leaked passwords". Não dá para ligar por MCP.
5. **Segredo `ia_segredo` digitado nos nós HTTP do n8n — BAIXO/MÉDIO.** Já estava registrado na passagem de bastão. **Recomendação:** mover para credencial *Header Auth* do n8n, o mesmo padrão adotado para a Fila.
6. **Índices — INFO.** Chaves estrangeiras sem índice e índices nunca usados aparecem no advisor de performance. Com o volume atual não pesa; revisar quando a base crescer.

### 2.5 Não provado no sistema existente

- **Marcação real no Klingo** (Fase 3). A conferência foi provada em teste e no banco, mas nenhum paciente real passou por ela. É a pendência nº 1 da `docs/passagem-fases-3-a-5.md`.
- **Configurações do painel do Supabase**: "Allow new users to sign up", "Confirm email", URL de redirecionamento. Não aparecem por MCP. Conferir à mão (`LEIAME.md`, seção "Primeiro acesso").
- **Código publicado da Edge Function x repositório.** Não foi feita a comparação byte a byte. Baixe a versão publicada (Supabase > Edge Functions) e compare com `supabase/functions/sync-catalogo-klingo/` antes de confiar que são iguais.
- **Chat e painel contra o Supabase real em navegador.** A rede da sessão bloqueia; o teste usou Supabase simulado.

## 3. Módulo novo: Fila + assinatura biométrica

### 3.1 Provado em teste

| Suíte | Resultado | O que cobre |
|---|---|---|
| `test:python` | 27 de 27 | Sete características do traço, distância *z-score*, score `1/(1+d)` com 4 casas, aprovação com score ≥ 0,30, enrolamento da primeira assinatura, perfil por média móvel (janela 20), 3 tentativas, série inválida sem lançar, execução com os *builtins* restritos do n8n. |
| `test:sql` | 46 de 46 | Instalação e idempotência; só a recepção entra na fila; token JWT HS256 assinado no banco e aceito pelo PyJWT; token adulterado, `alg: none`, truncado, expirado e de outra audiência recusados; falha fechada sem o segredo no Vault; `anon` só enxerga a própria linha e nunca `email_informado`; máquina de estados imposta por *trigger*; hash do documento do banco igual ao SHA-256 do navegador; o banco recusa resultado incoerente do Python (limiar, tipo, perfil); 3 reprovações bloqueiam e a quarta é recusada; cancelar desfaz o bloqueio; `registro_assinaturas` e `assinatura_tentativas` imutáveis (UPDATE, DELETE, TRUNCATE); broadcast sem nome nem e-mail; policy do Realtime. |
| `test:delta` | 5 de 5 | O estado v1 aplicado com o delta fica idêntico à instalação nova nas 23 funções (corpo, *definer* e privilégio de execução). O delta é idempotente. |
| `test:navegador` | 2 de 2 | `fila/` sem token mostra "Link expirado ou inválido"; o token sai da barra de endereço. **Só a casca antiga.** |

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
| `fila/fila.js`, `fila/index.html`, `fila/fila.css` | **Versão antiga, incompatível.** Usa o cliente Supabase com JWT próprio e uma URL de API (`SEU-SERVIDOR-BIOMETRIA`) que não existe mais. Não publicar. | A construir (Claude). |
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
| Chat, painel, catálogo, conferência, aprendizado | **Sim**, com as ressalvas de 2.4 (principalmente os preços divergentes e o nó de IA sem repetição) e de 2.5 (marcação real ainda não validada). |
| Fila + assinatura biométrica | **Não.** Faltam as peças de 3.3. Só o banco (v1) e o algoritmo estão prontos e testados. |

Ordem sugerida para fechar a Fila: ver `docs/fila-biometria.md`, seção 5.

## 6. Como repetir

```bash
cd testes && npm install && export CHROMIUM_PATH=/caminho/do/chromium && npm test
```

Instruções e limites em `testes/README.md`.
