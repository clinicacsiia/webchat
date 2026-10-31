# Fila em tempo real + assinatura biométrica dinâmica

Versão 2.0 — 30/10/2026 / Mudança: reescrito para o desenho atual (JWT assinado no banco, segredo do n8n por cabeçalho, Python no nó do n8n). Substitui a versão 1.0, que descrevia uma API FastAPI e um nó Code que assinava o JWT.

> **Estado: NÃO está em produção e NÃO está completo.** O banco real está na v1; a migração v2 está escrita e testada, mas não aplicada. Faltam a tela do paciente (`fila/fila.js`), a aba da recepção, os dois workflows do n8n e o SMTP. A seção 5 diz a ordem exata para fechar. Provas e lacunas: `docs/auditoria-2026-10-30.md`.

## 1. Fluxo ponta a ponta

1. **Recepção** (aba Fila do painel, *a construir*) chama a RPC `fila_entrar(nome, email, telefone)`. O banco acha ou cria o paciente, cria o `atendimentos` com `status = 'aguardando'` e, se `config.fila_webhook_url` estiver preenchida, avisa o n8n. A resposta traz `{atendimento_id, paciente_id, link_agendado}`; `link_agendado = false` significa que o envio de e-mail ainda não está configurado.
2. **n8n, workflow "Fila - emitir link"**: recebe o aviso, chama `fila_emitir_token(p_atendimento)` com o cabeçalho `x-fila-segredo` e envia o e-mail com `https://clinicacsiia.github.io/webchat/fila/?token=<jwt>`. O destinatário e o nome vêm da **resposta do banco**, nunca do corpo do aviso.
3. **Paciente** abre o link. `fila/fila.js` (*a reescrever*) tira o token da URL (`history.replaceState`), guarda em `sessionStorage`, lê o estado por `fila_estado(p_token)` e assina o broadcast privado `fila:global` / `atendimento:<id>`. Não há polling.
4. **Recepção** chama o paciente: `fila_chamar_assinatura(atendimento_id, texto)`. O banco calcula o SHA-256 do texto e passa para `assinatura_pendente`.
5. **Paciente** vê o documento, marca o consentimento e assina no Canvas (PointerEvents: x, y, tempo, pressão, traço). O navegador calcula o SHA-256 do texto exibido e envia ao n8n.
6. **n8n, workflow "Fila - validar assinatura"**: `assinatura_contexto` → nó Python (`biometria/avaliar_assinatura.py`) → `assinatura_registrar`. O banco **refaz as checagens com trava de linha** e é a autoridade final: limiar 0,30, 3 tentativas, estado, hash, e-mail do token. Na aprovação grava `registro_assinaturas` e muda o status para `em_atendimento`.
7. **Recepção** conclui com `fila_concluir`.

Máquina de estados (imposta por *trigger*, não só pela aplicação):

```
aguardando ──fila_chamar_assinatura──> assinatura_pendente ──aprovação──> em_atendimento ──fila_concluir──> concluido
     ^                                        │
     └────────fila_cancelar_assinatura────────┘   (também desfaz o bloqueio das 3 tentativas)
```

## 2. Arquivos

| Caminho | Estado | O que é |
|---|---|---|
| `supabase/fila-biometria.sql` | pronto, testado | Instalação do zero (v2): tabelas, RLS, JWT no banco, RPCs, triggers, broadcast, policy do Realtime. Idempotente. |
| `supabase/fila-biometria-v2-delta.sql` | pronto, testado | Para o banco que já recebeu a v1 (é o caso do projeto real). Troca as RPCs do n8n e cria o segredo por cabeçalho. |
| `biometria/avaliar_assinatura.py` | pronto, 27 testes | Algoritmo em Python puro. É o corpo do nó Code (Python nativo) do n8n e também um módulo testável. |
| `biometria/test_avaliar_assinatura.py` | — | Testes, inclusive com os *builtins* restritos do n8n. |
| `testes/` | pronto | Bateria completa; ver `testes/README.md`. |
| `fila/index.html`, `fila/fila.css`, `fila/fila.js` | **versão antiga, incompatível** | Usam o cliente Supabase com JWT próprio e uma API que não existe mais. **Não publicar.** A reescrever. |
| Aba "Fila" em `painel/index.html` | **não existe** | A construir. |
| `sw.js` | pronto, testado (`testes/sw.test.mjs`) | O cache do chat usa uma chave única (`./`) para toda navegação. `/fila/` está **excluído** dele; sem isso o paciente receberia a página do chat no lugar da fila e a URL com o token seria tratada como cache. Quem editar o `sw.js` precisa manter a regra e rodar `npm run test:sw`. |

## 3. Banco

### 3.1 Tabelas

- `atendimentos`: `id`, `paciente_id`, `email_informado`, `status`, `documento_texto`, `documento_hash`, `tentativas_falhas`, `bloqueado_em`, `links_enviados`, `created_at`, `atualizado_em`.
- `registro_assinaturas` (**imutável**: UPDATE, DELETE e TRUNCATE são barrados por *trigger*): `atendimento_id`, `email_confirmado_transacao` (vem do token), `hash_documento`, `consentimento_biometrico`, `tipo_validacao` (`enrolamento` ou `comparacao`), `score_similaridade`, `vetor_traco_bruto`, `caracteristicas`, `ip_origem`, `user_agent`.
- `assinatura_tentativas` (imutável): uma linha por reprovação, com o número da tentativa e o score.
- `pacientes` ganha `email_cadastro` (coluna gerada), `perfil_biometrico_historico` e `assinatura_papel_path`. Os *grants* por coluna escondem o perfil biométrico da equipe e do `anon`.

### 3.2 Quem chama o quê

| Quem | RPC | Autenticação |
|---|---|---|
| Recepção (sessão do painel) | `fila_entrar`, `fila_reenviar_link`, `fila_chamar_assinatura`, `fila_cancelar_assinatura`, `fila_concluir`, `fila_listar` | `fila_exige_staff()` / `papel_atual()` por dentro |
| Paciente (navegador, chave publicável) | `fila_estado(p_token)` | O próprio token JWT |
| n8n (chave publicável + cabeçalho) | `fila_emitir_token(p_atendimento)`, `assinatura_contexto(p_token, p_hash)`, `assinatura_registrar(p_token, p_hash, p_resultado, p_pontos, p_ip, p_user_agent)` | Cabeçalho `x-fila-segredo` conferido por `fila_n8n_autorizado()` |

O token é um JWT HS256 assinado e verificado **dentro do banco** (`fila_jwt_assinar` / `fila_jwt_validar`) com o segredo `fila_jwt_secret` do Vault. Claims: `aud = 'fila'`, `atendimento_id`, `email_informado`, `iat`, `exp` (4 h), `jti`. Funções internas (`fila_jwt_*`, `fila_segredo_*`, `fila_avisar_*`, funções de *trigger*) não são executáveis por `anon` nem `authenticated`.

### 3.3 Regras que o banco impõe, qualquer que seja o cliente

- Limiar: `aprovado` só é aceito se coerente com `score >= 0,30` (reprovada com 0,30 ou mais, ou aprovada com menos, é recusada como `resultado_invalido`).
- 3 reprovações bloqueiam o atendimento (`bloqueado_em`); a quarta chamada é recusada. Série inválida e conflito de perfil **não** contam tentativa. Cancelar o envio desfaz o bloqueio e mantém a posição na fila.
- Hash do documento: o do navegador tem de ser igual ao gravado pelo banco.
- Máximo de 10 links por atendimento; atendimento concluído não recebe link.
- Falha fechada: sem o segredo no Vault, ninguém passa.

## 4. Algoritmo (Python)

- Entrada por item do n8n: `consentimento`, `perfil`, `pontos` (`[{x, y, timestamp, pressao, traco}]`), `tentativas_falhas`.
- Série válida: 20 a 5.000 pontos, valores finitos, tempo crescente, duração de 0,3 s a 60 s, até 200 traços, coordenadas normalizadas em [0, 1] com 5% de tolerância.
- Sete características (`extract_dynamic_features`): `velocidade_media`, `jitter`, `duracao_ms`, `pressao_media`, `pressao_desvio`, `num_tracos`, `pausa_media_ms`.
- Distância: raiz da média dos quadrados dos *z-scores* contra o perfil, com piso de desvio (10% da média do próprio paciente e um piso absoluto por característica). `score = 1 / (1 + d)`, arredondado em 4 casas; **a decisão usa o score já arredondado**, igual ao banco. Aprovado se `score >= 0,30` (distância de até 2,33).
- A primeira assinatura é **enrolamento**: sem comparação, `score` nulo, `tipo_validacao = 'enrolamento'`.
- O perfil só é atualizado quando aprovado (média móvel exponencial, janela 20). Reprovação nunca "ensina" o perfil.
- O score **não** volta ao paciente (devolvê-lo permitiria ajustar a assinatura até passar).

## 5. Colocar em produção (ordem)

Quem faz cada passo está entre colchetes.

1. **[Você] Aplicar a migração v2 no SQL Editor** do projeto `nrvuynjwcgwpjdptkiay`: colar `supabase/fila-biometria-v2-delta.sql` e executar. Ele tem três `drop function`, por isso o Supabase pede confirmação humana (foi o que travou a aplicação automática). Não apaga dado; as três funções removidas só existem na v1. Conferir:
   ```sql
   select p.oid::regprocedure::text from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('fila_emitir_token','assinatura_contexto','assinatura_registrar','fila_n8n_autorizado');
   -- deve listar fila_emitir_token(uuid), assinatura_contexto(text,text),
   -- assinatura_registrar(text,text,jsonb,jsonb,text,text) e fila_n8n_autorizado();
   -- NÃO pode listar as versões com p_segredo.
   ```
2. **[Você] Criar a credencial do n8n.** *Credentials > Create > Header Auth*, nome `Fila - segredo`, *Name* `x-fila-segredo`, *Value* = o segredo. Para ler o segredo, rode **só no SQL Editor** (nunca cole em conversa, issue ou arquivo):
   ```sql
   select decrypted_secret from vault.decrypted_secrets where name = 'fila_segredo';
   ```
   Se achar que o valor vazou, troque: `select vault.update_secret((select id from vault.secrets where name = 'fila_segredo'), '<novo valor>');` e atualize a credencial.
3. **[Você] Criar a credencial SMTP** no n8n (a conta que enviará o e-mail do link).
4. **[Claude, depois dos passos 2 e 3] Montar e publicar os dois workflows** (seção 6) e testá-los.
5. **[Claude] Reescrever `fila/fila.js` e a aba "Fila" do painel**; testar no navegador com o Supabase simulado.
6. **[Você] Preencher `config.fila_webhook_url`** com a URL de produção do webhook "emitir link":
   ```sql
   update public.config set valor = 'https://clinicacsi.app.n8n.cloud/webhook/<caminho-longo-e-aleatorio>' where chave = 'fila_webhook_url';
   -- se a chave ainda não existir: insert into public.config (chave, valor) values ('fila_webhook_url', '<url>');
   ```
7. **[Você] Teste ponta a ponta com paciente de teste** (telefone `7190000xxxx`, e-mail seu): entrar na fila, receber o e-mail, abrir o link, ver a posição, a recepção chamar, assinar (enrolamento), assinar de novo com traço diferente, reprovar três vezes (deve bloquear), cancelar o envio (deve desbloquear). Conferir `registro_assinaturas` e `assinatura_tentativas` no SQL Editor.
8. **[Você] Decidir sobre o merge do PR #15** só depois do passo 7. O merge publica `fila/` no GitHub Pages.
9. **[Você, antes de usar com paciente real]** itens de LGPD da seção 8.

Reverter: as três RPCs removidas pelo delta não têm uso nem dado associado; se precisar de volta, as definições estão na migração `fila_biometria_v1` (Supabase > Database > Migrations). Para tirar o módulo do ar sem apagar nada, esvazie `config.fila_webhook_url` e não mescle o PR.

## 6. Workflows do n8n

Ambos com **Save Execution Data = off** (sucesso, erro e progresso). Sem isso o token e o traço biométrico ficam no histórico de execuções.

### 6.1 "Fila - emitir link"

| # | Nó | Configuração |
|---|---|---|
| 1 | **Webhook** | `POST`, caminho longo e aleatório, resposta imediata. É chamado pelo banco (`net.http_post`), que **não envia cabeçalho de autenticação**. Por isso o nó não confia no corpo, só no `atendimento_uuid`. |
| 2 | **HTTP Request** | `POST https://nrvuynjwcgwpjdptkiay.supabase.co/rest/v1/rpc/fila_emitir_token`; cabeçalhos `apikey` e `Authorization: Bearer` com a chave publicável do projeto (está no `index.html`; é pública por desenho) e a credencial Header Auth `Fila - segredo`; corpo `{"p_atendimento": "{{ $json.body.atendimento_uuid }}"}`. |
| 3 | **IF** | `ok = true`. Se não: fim, sem e-mail. |
| 4 | **Send Email (SMTP)** | Para: `email` da **resposta do banco**. Assunto: "Sua assinatura para o atendimento". Corpo em texto e HTML com o link `https://clinicacsiia.github.io/webchat/fila/?token={{ token }}` e a validade (`expira_em`). Sem nome de médico nem dado clínico. |
| 5 | **Error Trigger** (workflow à parte) | Avisa a equipe por e-mail se falhar. Não inclua o corpo da execução no aviso. |

Risco residual: quem conhecer a URL do webhook pode disparar o envio de um link para um atendimento que já está na fila (limitado a 10 por atendimento, e o e-mail só vai para o endereço cadastrado). O caminho longo e aleatório mitiga. Para fechar de vez, o banco teria de enviar um segredo no aviso (guardado no Vault); não foi feito.

### 6.2 "Fila - validar assinatura"

| # | Nó | Configuração |
|---|---|---|
| 1 | **Webhook** | `POST`, caminho longo e aleatório, *Allowed Origins* `https://clinicacsiia.github.io`, resposta por nó "Respond to Webhook". Corpo: `{token, hash, pontos, consentimento}`. |
| 2 | **IF** | Corpo tem `token`, `hash` (64 hex), `pontos` (lista) e `consentimento === true`. Senão: responde `{ok:false, erro:'pedido_invalido'}`. |
| 3 | **HTTP Request** | `rpc/assinatura_contexto` com `{p_token, p_hash}` e a credencial Header Auth. |
| 4 | **IF** | `ok = true`. Se não: responde o `erro` do banco (`token_invalido`, `bloqueado`, `fora_de_assinatura`, `documento_diferente`). |
| 5 | **Edit Fields** | Monta `{consentimento, pontos, perfil, tentativas_falhas}` com o corpo do webhook e a resposta do contexto. |
| 6 | **Code — Python (Native)** | Cole **todo** o conteúdo de `biometria/avaliar_assinatura.py`. Devolve `{resultado}`. |
| 7 | **IF** | `resultado.ok = true`. Se não (série inválida): responde `{ok:false, erro:'serie_invalida'}`; **não conta tentativa**. |
| 8 | **HTTP Request** | `rpc/assinatura_registrar` com `p_token`, `p_hash`, `p_resultado = resultado`, `p_pontos`, `p_ip` (primeiro valor de `x-forwarded-for`), `p_user_agent` (cabeçalho do webhook). |
| 9 | **Respond to Webhook** | Só `{ok, aprovado, tentativas_restantes, bloqueado}` ou `{ok:false, erro}`. **Nunca** o score nem o perfil. |

A resposta `conflito` do banco (outro envio mudou o perfil entre o contexto e o registro) deve ser repetida uma vez pelo front, sem contar tentativa.

## 7. Decisões de desenho (e por quê)

- **JWT no banco, não no n8n.** O segredo JWT do projeto Supabase não é acessível por MCP e entregá-lo ao n8n o espalha. O segredo `fila_jwt_secret` é só deste módulo, vive no Vault e nunca sai do banco.
- **Segredo do n8n por cabeçalho (credencial Header Auth), não em parâmetro nem dentro do workflow.** Um segredo em parâmetro aparece no corpo da requisição, nos logs e no histórico do n8n. Gravar segredo dentro de um workflow foi barrado pelo controle de segurança do ambiente e o desenho foi refeito por isso.
- **Python no nó do n8n, sem API própria.** Evita hospedar um servidor. O custo: o sandbox do n8n não aceita `import`, `class`, `type`, `getattr` nem `hasattr`, então o algoritmo foi escrito só com funções, dicts e listas, e o teste roda com esses mesmos limites.
- **O banco é a autoridade, o Python é só o cálculo.** O n8n pode ser comprometido ou errar; o banco recusa resultado incoerente com o limiar, o tipo ou o perfil.
- **Posição por RPC, não por `select count`.** Com RLS estrito o paciente só enxerga a própria linha; a função `security definer` devolve só números.
- **Aviso por broadcast privado sem dado pessoal.** `fila:global` e `atendimento:<id>` levam apenas o status. O tópico `atendimento:<id>` é protegido pelo UUID não adivinhável, não por token.
- **Contador de 3 tentativas no banco**, por atendimento (um token novo não zera), com trava de linha contra envios paralelos.
- **E-mail do lastro vem do token**, não do corpo.
- **Primeira assinatura é enrolamento.** O registro marca `enrolamento` e `score` nulo; a recepção deve conferir a identidade no balcão nesses casos.

## 8. Riscos que precisam de decisão humana

- **Limiar 0,30 é permissivo.** Aprova distância média de até 2,33 desvios: um impostor com traço parecido passa. A assinatura dinâmica é reforço, não prova de identidade; o lastro principal é o link no e-mail + o hash + o registro imutável. Recalibre com assinaturas reais antes de depender dele.
- **LGPD, art. 11 (dado biométrico é sensível).** A coluna `vetor_traco_bruto` guarda a série completa. Antes de usar com paciente real: texto de consentimento revisado pelo jurídico, prazo de retenção definido (e rotina para apagar), RIPD registrado, e definir quem da equipe pode ler `registro_assinaturas`.
- **Token no link.** O JWT vai na URL (exigido pelo desenho). Mitigações: `Referrer-Policy: no-referrer`, remoção da URL ao carregar, `sessionStorage`, expiração de 4 h, e nenhum registro do token no n8n (Save Execution Data off). Quem receber o e-mail pode abrir o link: a caixa de e-mail do paciente tem de ser dele.
- **Enrolamento aceita qualquer traço legível** de quem abriu o link. Confira a identidade no balcão.
- **Webhook "emitir link" sem autenticação** (6.1).
- **Tópico `atendimento:<id>`** protegido só pela imprevisibilidade do UUID; o conteúdo é só o status.

## 9. Pendências

| # | Item | Quem |
|---|---|---|
| 1 | Aplicar a migração v2 (passo 1) | Você |
| 2 | Credenciais Header Auth e SMTP no n8n (passos 2 e 3) | Você |
| 3 | Workflows do n8n | Claude |
| 4 | `fila/fila.js` + `index.html` + `fila.css` novos | Claude |
| 5 | Aba "Fila" no painel | Claude |
| 6 | `config.fila_webhook_url` | Você |
| 7 | Teste ponta a ponta no ambiente real | Você |
| 8 | Itens de LGPD e recalibração do limiar | Você / jurídico |
| 9 | Merge do PR #15 | Você |

Não provado até aqui (e por que): Realtime por WebSocket, CORS do webhook, entrega do e-mail, desempenho do nó Python com séries reais. A rede da sessão bloqueia o Supabase e o n8n fora dos conectores.
