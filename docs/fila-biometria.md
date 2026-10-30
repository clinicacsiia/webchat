> **Status (30/10/2026): documento desatualizado em parte.** O desenho mudou depois desta primeira versão e este arquivo ainda não foi reescrito.
>
> - **Valem:** `supabase/fila-biometria.sql` (token JWT assinado e verificado no banco, segredo no Vault, segredo do n8n no cabeçalho `x-fila-segredo`) e `biometria/avaliar_assinatura.py` (algoritmo em Python puro, executado no nó Python do n8n).
> - **Não valem mais:** a API FastAPI, o nó Code que assina o JWT no n8n e o JWT assinado com a chave do projeto (seções 3, 4 e 5 abaixo).
> - **Ainda pendentes:** `fila/fila.js` (ainda usa o cliente com JWT do projeto), a aba **Fila** do painel, os dois workflows do n8n, a aplicação da migração v2 no banco e o merge. Este PR segue como rascunho por isso.

# Fila em tempo real + assinatura biométrica dinâmica

Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial

## 1. Fluxo ponta a ponta

1. **Recepção** chama `fila_inserir(paciente_id)` (painel, sessão de atendente). A linha nasce em `atendimentos` com `status = 'aguardando'`. A função devolve o `atendimento_id`.
2. **Recepção** dispara o webhook do n8n `POST /fila-emitir-link` com `{nome, email_informado, paciente_id, atendimento_uuid}`.
3. **n8n** valida, assina o JWT (`n8n/fila-emitir-link.js`) e envia o e-mail com `https://clinicacsiia.github.io/webchat/fila/?token=...`. A resposta do webhook não traz o token.
4. **Paciente** abre o link. `fila/fila.js` tira o token da URL (`history.replaceState`), guarda só em `sessionStorage` e assina o Realtime com o próprio JWT.
5. **Fila**: a posição vem de `fila_minha_posicao()` (só números). Um aviso `fila_mudou` no canal privado `fila:global` (sem dado pessoal) dispara o recálculo. Não há polling.
6. **Recepção** chama o paciente e executa `fila_chamar_assinatura(atendimento_id, texto)`. O banco calcula o SHA-256 do texto e grava `status = 'assinatura_pendente'`.
7. **Paciente** vê o documento, marca o consentimento, assina no Canvas. O navegador calcula o SHA-256 do texto exibido e envia para a API Python com o JWT, os pontos e o User-Agent.
8. **API Python** (`api-biometria/app.py`) valida, compara, grava em `registro_assinaturas` ou `assinatura_tentativas`, e na aprovação muda o status para `em_atendimento`. Tudo numa única transação.
9. **Recepção** conclui com `fila_concluir(atendimento_id)`.

Máquina de estados (imposta por trigger, não só pela aplicação):

```
aguardando ──fila_chamar_assinatura──> assinatura_pendente ──API aprova──> em_atendimento ──fila_concluir──> concluido
     ^                                        │
     └────────fila_cancelar_assinatura────────┘   (também desfaz o bloqueio de 3 tentativas)
```

## 2. Arquivos

| Caminho | O que é |
|---|---|
| `supabase/fila-biometria.sql` | Tabelas, RLS, grants, triggers, funções `fila_*`, broadcast. Idempotente. |
| `fila/index.html`, `fila/fila.css`, `fila/fila.js` | Página do paciente (GitHub Pages). |
| `api-biometria/biometria.py` | Algoritmo puro: features, distância, score, EWMA e contador de tentativas. |
| `api-biometria/app.py` | API FastAPI: JWT, transação com trava de linha, gravação do lastro. |
| `api-biometria/test_biometria.py` | 22 testes (`cd api-biometria && python -m pytest -q`). |
| `n8n/fila-emitir-link.js` | Nó Code do n8n que assina o JWT. |

## 3. Workflow n8n: "Fila - emitir link de assinatura"

Um único workflow. Ele não toca na biometria: a assinatura vai direto para a API Python.

| # | Nó | Configuração |
|---|---|---|
| 1 | **Webhook** | `POST`, path `fila-emitir-link`, *Authentication*: Header Auth (header `x-fila-key`, valor só no credential). *Allowed origins*: a origem da equipe. *Response*: *Using 'Respond to Webhook' node*. |
| 2 | **HTTP Request** (checar atendimento) | `GET https://nrvuynjwcgwpjdptkiay.supabase.co/rest/v1/atendimentos?id=eq.{{atendimento_uuid}}&select=id,status`, com credential de chave de serviço. Só segue se `status = aguardando`. Se a fila já andou, responde 409. |
| 3 | **Code** | Conteúdo de `n8n/fila-emitir-link.js`. Lê `$env.FILA_JWT_SECRET`. Valida UUIDs e e-mail, assina HS256 com `role`/`aud` = `authenticated`, `sub` = `paciente_id`, `atendimento_id`, `email_informado`, `iat`, `exp` = 4 h, `jti`. |
| 4 | **Send Email** (SMTP) | Para `email_informado`. Assunto: "Sua assinatura para o atendimento". Corpo em texto e HTML com o `link`. Sem nome de médico nem dado clínico. |
| 5 | **Respond to Webhook** | JSON `{ok: true, expira_em}`. **Nunca** devolve `link` nem `token`. |
| 6 | **Error Trigger** (workflow separado) | Avisa a equipe por e-mail se a emissão falhar. Não inclua o corpo da execução no aviso. |

Configurações do workflow:
- **Save Execution Data: off**. Sem isso o token fica no histórico de execuções do n8n.
- Variável `FILA_JWT_SECRET` no ambiente do n8n (o mesmo segredo JWT do projeto Supabase). Se a instância bloquear `$env`, guarde o segredo em credential e passe-o ao nó Code por um nó anterior, sem log.
- Reenvio: o mesmo workflow emite um token novo para o mesmo `atendimento_uuid`. O token anterior continua válido até o `exp`, o que é aceitável porque o acesso à fila é o mesmo.

## 4. Supabase: confirmar antes de publicar

- **Assinatura do JWT.** O PostgREST e o Realtime aceitam tokens HS256 assinados com o segredo JWT **legado** do projeto. Se o projeto usa chaves de assinatura assimétricas, esse segredo não valida os tokens do n8n e o paciente recebe 401. Confira em *Project Settings > JWT Keys* e mantenha o modo HS256 ativo para este módulo.
- **Realtime.** Canais privados (`config.private`) exigem as policies de `realtime.messages`, já criadas por `fila-biometria.sql`.
- **Pacientes.** O `REVOKE`/`GRANT` de colunas de `pacientes` depende de nenhuma tela ler a tabela direto. Verificado nos HTML do repositório; se a equipe criar uma tela que faça `select *` em `pacientes`, ela passa a receber erro de permissão.

## 5. Publicação (ordem)

1. Rodar `supabase/fila-biometria.sql` no SQL Editor do projeto `webchat-atendimento`. Ele não apaga dado.
2. Confirmar que a `fila_minha_posicao` e as policies existem (`select proname from pg_proc where proname like 'fila_%';`).
3. Subir a API: `pip install -r api-biometria/requirements.txt`, depois `uvicorn app:app --host 0.0.0.0 --port 8000 --proxy-headers`, com as variáveis:
   - `SUPABASE_JWT_SECRET` (mesmo do n8n),
   - `DATABASE_URL` (conexão Postgres do projeto; use o pooler de transação, a aplicação já desativa prepared statements),
   - `ORIGENS_PERMITIDAS=https://clinicacsiia.github.io`,
   - `CONFIAR_X_FORWARDED_FOR=1` só se o proxy à frente for seu.
   Coloque HTTPS na frente da API.
4. Trocar `SEU-SERVIDOR-BIOMETRIA` em `fila/fila.js` pela URL pública da API.
5. Publicar a branch. GitHub Pages serve `https://clinicacsiia.github.io/webchat/fila/`.
6. Teste com um paciente de teste (telefone `7190000xxxx`): emitir link, abrir, aparecer na fila, recepção chama, assinar, reprovar três vezes (deve bloquear), e depois conferir `registro_assinaturas` e `assinatura_tentativas` pelo SQL Editor.

## 6. Decisões de desenho (e por quê)

- **Posição por RPC, não por `GET` com contagem.** Com RLS estrito, o paciente só enxerga a própria linha. Uma contagem direta sempre daria "1º". A função `SECURITY DEFINER` lê a claim e devolve só números.
- **Aviso por broadcast privado, não por `postgres_changes` na fila.** O Realtime só entrega linhas que o RLS libera. O broadcast entrega "a fila mudou" sem dado.
- **Status próprio por `postgres_changes` com `filter id=eq.<atendimento>`.** Essa linha é liberada pelo RLS ao próprio paciente.
- **Contador de 3 tentativas no banco, não no JWT.** O JWT é stateless e não pode ser revogado. A contagem é por atendimento, então um token novo não zera. A trava `for update` impede que duas requisições paralelas contem uma falha duas vezes.
- **Hash do documento calculado no banco e no navegador, comparado no servidor.** Prova que o paciente viu exatamente o texto gravado pela recepção.
- **E-mail do lastro vem do claim assinado**, não do corpo da requisição.
- **Score nunca volta ao paciente.** Devolver o score permitiria ajustar a assinatura até passar.
- **Série ruim (422) não conta como tentativa.** Só uma comparação reprovada conta.
- **Primeira assinatura é enrolamento** (sem perfil, sem comparação). Ela registra `tipo_validacao = 'enrolamento'` e `score_similaridade` nulo. A recepção deve ver esses casos.
- **API Python fala direto com o navegador**, sem passar pelo n8n. A série tem centenas de pontos e o n8n guarda o corpo de execuções.

## 7. Riscos que precisam de decisão humana

- **Limiar de 0,30.** Com `score = 1/(1+d)`, o limiar equivale a `d <= 2,33` desvios-padrão médios. É permissivo: um impostor com traço parecido passa. A assinatura dinâmica funciona aqui como reforço, não como prova de identidade. O lastro jurídico principal é o link no e-mail + o hash + o registro imutável. Recalibre o limiar com assinaturas reais antes de depender dele.
- **Dado biométrico é sensível (LGPD, art. 11).** A coluna `vetor_traco_bruto` guarda a série completa, como especificado. Antes de produção: texto de consentimento revisado pelo jurídico, prazo de retenção definido, e um RIPD (relatório de impacto) registrado.
- **Token no link.** O JWT vai na URL (exigido pelo desenho). Mitigado com `Referrer-Policy: no-referrer`, remoção da URL no carregamento, `sessionStorage` e expiração de 4 h. Quem recebe o e-mail pode abrir o link: o e-mail deve ser confidencial.
- **Pilotagem da primeira assinatura.** O enrolamento aceita qualquer traço legível da pessoa que abriu o link. Por isso o registro marca `enrolamento` e a equipe deve conferir a identidade no balcão.
- **Acesso ao banco pela API.** A API usa a conexão do dono do banco (bypassa RLS, por design). A chave fica só no ambiente do servidor. Próximo passo de endurecimento: um papel dedicado com grants mínimos.

## 8. Pendências

- Botão na tela da recepção (painel) que chama `fila_inserir`, depois o webhook do n8n, e a tela de envio do documento que chama `fila_chamar_assinatura`. Não está neste PR.
- Hospedagem da API Python (escolha da equipe).
- Recalibração do limiar com dados reais.
- Teste de integração contra o projeto Supabase real (o banco de teste usado aqui foi PGlite com stubs de `auth` e `realtime`; o comportamento do Realtime do Supabase não foi exercitado de ponta a ponta).
