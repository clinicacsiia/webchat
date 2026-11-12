# Webchat de atendimento

Chat estilo WhatsApp para clientes + painel da equipe e do marketing.
Tudo em HTML/CSS/JS puro (PWA), com Supabase no servidor (banco, Edge Functions e avisos por Web Push). O n8n deixou de ser usado em 03/11/2026 (`docs/plano-sair-do-n8n.md`).

```
index.html            chat do cliente        -> https://SEU-USUARIO.github.io/SEU-REPO/
sentinela.js          monitor do chat: ajuda quem trava e gera o código de rastreio (CSI-...)
painel/index.html     painel da equipe       -> https://SEU-USUARIO.github.io/SEU-REPO/painel/
```

## Comece por aqui (estado em 12/11/2026)

| Quero… | Abra |
|---|---|
| Entender o sistema inteiro (pastas, banco, rotinas, testes) | [`docs/DOCUMENTACAO.md`](docs/DOCUMENTACAO.md) |
| Saber o que depende do dono | [`docs/pendencias-do-dono.md`](docs/pendencias-do-dono.md) |
| Ver o que foi auditado, corrigido e medido | [`docs/auditoria-2026-11-11.md`](docs/auditoria-2026-11-11.md) |
| Entender o autoatendimento com a API do Klingo (CPF obrigatório, horários reais, marcação automática, cancelar e remarcar) | [`docs/klingo-autoatendimento.md`](docs/klingo-autoatendimento.md) |
| Ler uma função do banco como ela está de verdade | [`supabase/producao/funcoes/`](supabase/producao/LEIAME.md) |
| Rodar os testes | `cd testes && npm install && npm test` ([`testes/README.md`](testes/README.md)) |

**O texto abaixo é histórico**: cada parágrafo conta uma mudança na data em que foi feita, e alguns "ainda não aplicado" já foram aplicados depois. Para o estado atual, valem os documentos da tabela acima.

Fase 9 (31/10/2026): correções do teste da paciente, Sentinela e mensagens empáticas. Veja `docs/fase9-sentinela.md`. SQL aplicado no Supabase em 31/10/2026.

Convênios e foto do pedido (02/11/2026): aba **Convênios** do painel (ligar/desligar convênio, mensagem e regra por convênio, avisos de preço, previsão), chat com a foto primeiro e depois tipo/parte/lado, fotos separadas para o atendente com pendência do Klingo. Veja `docs/convenios-e-foto.md`; SQL `supabase/convenios-e-foto.sql` aplicado no Supabase em 02/11/2026.

Convênio de quem volta (31/10/2026): o chat deixa de copiar o convênio da vez anterior e pergunta ("É assim também agora?"); corrigir o plano tira a carteirinha antiga. Veja `docs/lembrete-mudar-escolhas-e-convenio.md`, seção 0. SQL `supabase/correcao-convenio-quem-volta.sql` aplicado no Supabase em 31/10/2026.
Outro assunto resolvido pelo chat (31/10/2026): cancelar e remarcar listam os exames marcados e seguem sozinhos; resultado de exame mostra a orientação cadastrada. Veja `docs/assuntos-resolvidos.md`. SQL `supabase/assuntos-resolvidos.sql` aplicado no Supabase em 31/10/2026.

Meus dados (31/10/2026): quem tem conta pode ver o que a clínica guarda, baixar uma cópia e apagar a conta (só o login; cadastro e pedidos continuam com a clínica). Veja `docs/login-paciente-passo-a-passo.md`. SQL `supabase/meus-dados.sql` aplicado no Supabase em 31/10/2026; falta o jurídico revisar o texto antes de abrir o login ao público.

Login do paciente (31/10/2026): o instalador `supabase/aplicar-login-paciente.sql` está aplicado no Supabase e o login está **ligado só para teste** (`config.login_paciente = sim`; `cadastro_equipe_sem_convite = nao`, ligados em 31/10/2026). Para o passo a passo, siga `docs/login-paciente-passo-a-passo.md`.

**PENDENTE (decidido em 31/10/2026):**
1. ~~E-mail de autenticação do Supabase não enviava~~ **Resolvido em 31/10/2026:** SMTP do Gmail (senha de app) configurado em Authentication > SMTP Settings; confirmação de conta testada e funcionando. Falta só trocar o texto dos modelos "Confirm signup" e "Reset password" por algo genérico da clínica.
2. **Novo desenho de cadastro, sem tela de login separada:** o paciente informa nome, telefone e e-mail; o sistema compara com a tabela `pacientes` e liga a conta ao cadastro existente; o paciente escolhe a senha e confirma com a data de nascimento. Ainda não implementado.

Fila de chegada e portal "Minha vez" (01/11/2026): o paciente permite os avisos, entra com a conta, toca em Cheguei e acompanha a posição; é avisado quando faltam 2 pessoas e na vez dele; a aba Fila do painel avisa a equipe. SQL `supabase/fila-chegada.sql` aplicado no Supabase em 01/11/2026 (falta só ligar o push com o site fechado). Veja `docs/fila-chegada.md`.

Quadro das conversas (01/11/2026): o Atendimento ganhou o alternador Lista | Quadro, com cartões por conversa, filtros, mover e responsável. Veja `docs/quadro-nas-conversas.md`.

Aba Jornada (01/11/2026): onde está cada paciente, ao vivo, com o Klingo lido a cada minuto no expediente e aviso quando alguém demora (prazo da etapa ou horário que passou). Veja `docs/jornada-monitoramento.md`.

Uma pessoa, uma conversa (01/11/2026): conversas da mesma pessoa (nome + 2 informações) aparecem unidas no Atendimento e na Jornada; exame marcado fica em aberto até a equipe, o paciente (pelo chat) ou o Klingo fechar; falta vira remarcação que o paciente faz sozinho pelo chat. **Pronto e testado, mas o SQL ainda NÃO foi aplicado no Supabase.** Veja `docs/pessoa-unica.md`, seção "Como ligar".

Próximo passo na conversa (01/11/2026): no alto de cada conversa, uma faixa mostra a única decisão que falta (assumir, conferir valor, fechar exame, remarcar, marcar no Klingo ou responder), com um botão que leva até ela. Os avisos de apoio ficam numa área que rola e se encolhe conforme a altura da tela, para as mensagens sempre terem espaço. Só mudou a tela (`painel/index.html`); não há SQL novo.

Atualização do WebChat (09/11/2026): motivo no encerramento, Agendado conferindo a agenda, despedida configurável, encerramento automático após 24 h sem resposta do paciente, avaliação voluntária e topo da conversa mais baixo. **No ar desde 09/11/2026 (PR #104): SQL aplicado, site publicado e todas as chaves ligadas.** Pendências em `docs/atualizacao-webchat.md`, com chaves em Configurações > "Encerramento e avaliação". Controle de etapas e links: `docs/atualizacao-webchat.md`. Detalhes: `docs/encerramento-motivo.md` (WC-03 e WC-04), `docs/despedida.md` (WC-05 e WC-06), `docs/autoencerramento.md` (WC-08), `docs/avaliacao.md` (WC-09 e WC-10), `docs/cabecalho-painel.md` (WC-07) e `docs/wc01-diagnostico.md` (por que só 2 pedidos viram "agendado").

Lista completa do que falta, com a ordem de dependência: `docs/pendencias-e-dependencias.md` (conferida no banco real em 01/11/2026).

Banco: projeto Supabase `webchat-atendimento` (sa-east-1), já com tabelas, regras de segurança e tempo real.

## Publicar no GitHub Pages

1. Crie um repositório (ex.: `webchat`) e envie todo o conteúdo desta pasta .
2. No repositório: Settings > Pages > Source: `Deploy from a branch` > `main` / `(root)`.
3. Abra `https://SEU-USUARIO.github.io/webchat/painel/` e **crie a sua conta primeiro**.
   A primeira conta criada vira administradora. As demais entram "aguardando liberação" e você libera em Equipe.

## Primeiro acesso: e-mail de confirmação

O Supabase exige confirmar o e-mail de quem cria conta. Para a equipe entrar sem isso:
Supabase > Authentication > Providers > Email > desligue "Confirm email".
Depois que a equipe estiver cadastrada, desligue também "Allow new users to sign up" (Authentication > Sign In / Providers),
assim ninguém de fora consegue nem criar conta pendente.

### Link do e-mail de confirmação dando erro 404

O link do e-mail leva ao endereço configurado no Supabase, não ao painel. Em Supabase > Authentication > URL Configuration:

- **Site URL**: `https://SEU-USUARIO.github.io/SEU-REPO/painel/`
- **Redirect URLs**: adicione `https://SEU-USUARIO.github.io/SEU-REPO/painel/**`

O painel já pede esse endereço ao cadastrar (`emailRedirectTo`), mas o Supabase só o aceita se estiver na lista de Redirect URLs.

### E-mail em português

Supabase > Authentication > Email Templates > "Confirm signup": cole o conteúdo de `supabase-emails/confirmar-cadastro.html` e troque o assunto para "Confirme seu e-mail - Painel de atendimento". Faça o mesmo para "Invite user" e "Reset password" se usar.

## Avisos e integrações (sem n8n)

Desde 03/11/2026 nada passa pelo n8n. O que ele deveria fazer agora é feito por Edge Functions do Supabase (`supabase/functions/`), todas chamadas pelo próprio banco com o segredo do Vault (`fila_aviso_segredo`):

| Função | Para quê | Liga com |
|---|---|---|
| `avisar-equipe` | Web Push à equipe (painel fechado) quando uma conversa passa para uma pessoa; sem nome nem dado de saúde | `config.equipe_push_url` |
| `fila-emitir-link` | E-mail com o link da assinatura da fila (precisa dos segredos `EMAIL_API_KEY` e `EMAIL_REMETENTE`) | `config.fila_link_url` |
| `fila-validar-assinatura` | Valida a assinatura (algoritmo em TypeScript, igual ao Python de referência); pública, quem prova é o token | chamada pela tela da fila |

Vazio na configuração = desligado. Como se liga cada uma: `docs/plano-sair-do-n8n.md`.

## Como cada pessoa usa

| Papel | Vê | Faz |
|---|---|---|
| Administrador | Tudo | Atende, gerencia equipe, edita configurações, exclui contatos |
| Atendente | Atendimento e Contatos | Assume, responde, transfere e encerra conversas; edita tags e observações |
| Marketing | Contatos | Busca, filtra, edita tags e exporta CSV. Não lê as conversas |

Dica: coloque `?origem=instagram` no link do chat (ex.: na bio) para ver de onde veio cada contato.

## Segurança e privacidade (LGPD)

- A chave que está nos HTML é a chave **publicável** do Supabase. Ela é feita para ficar no navegador; a proteção real está nas regras de acesso (RLS) do banco.
- O cliente só acessa a própria conversa, por um token secreto guardado no navegador dele. Quem perde o token perde o acesso àquela conversa.
- O formulário exige aceite do cliente antes de guardar nome e telefone; a data do aceite fica no contato.
- Limites embutidos: 5 conversas por hora por telefone e 20 mensagens por minuto por conversa.
- Telefones aceitos: Brasil (DDD + número). Para clientes de fora, o formulário precisa ser ajustado.

## O que ainda não tem (próximos passos naturais)

- Envio de arquivos e imagens no chat
- Respostas rápidas prontas para a equipe
- Ligação com o WhatsApp oficial (API do WhatsApp Business; precisa de uma Edge Function nova)
- Resposta automática fora do horário de atendimento

## Triagem por IA (encerrada em 03/11/2026)

- A IA (n8n + Claude) deixou de atender o paciente: quem responde é o motor de regras do banco (Fase 7, `docs/fase7-motor-implementado.md`). O fluxo do n8n foi apagado e as funções `ia_contexto`, `ia_responder`, `ia_responder_v2` e `ia_catalogo` saíram do banco (`supabase/saida-n8n.sql`). Continuam `ia_pre_agendar` e `config.ia_segredo`, que o motor usa.
- Texto histórico, mantido por referência (descreve o que existia antes):
- Ao ter o essencial, em urgência ou após 10 falas, a IA para (`ia_ativa = false`) e a conversa fica em Aguardando com resumo e urgência no painel.
- Desligar a IA: na tabela `config`, `ia_ativa = 'nao'`. Quando um atendente assume, a IA já para sozinha.

## Pré-agendamento pela IA (Klingo)

Quando o paciente quer consulta ou exame, a assistente segue o roteiro: pedido (especialidade/procedimento) > plano (Particular ou convênio) > preferências (unidade, profissional, período) > dados do paciente em grupos (identificação, contato, endereço, carteirinha) > leitura de volta e confirmação > passa para o atendente.

- Os dados ficam na tabela `pre_agendamentos` (uma por conversa), gravados pela função `ia_pre_agendar` (chamada pelo motor `fluxo_pre`). Só administrador e atendente leem (tem CPF, nome da mãe e endereço); marketing não.
- No painel, a conversa mostra o cartão **Pré-agendamento** com o pedido, os dados do paciente, **Copiar dados**, **Marcar como agendado** e **Cancelar**.
- A IA **não marca nem promete horário**: o atendente ocupa o horário no Klingo, valida a autorização do convênio, informa valor e preparo e confirma com o paciente.
- O treinamento (prompt) está no nó "Triagem com Claude" do workflow `Triagem IA - Atendimento`. O SQL está em `supabase/pre-agendamentos.sql`.

### O que ainda depende da Klingo

A API de marcação (`/externo/register`, `/externo/login`, `/agenda/horarios`, `/agenda/horario`) ainda **não está ligada**: faltam `baseUrl`, login e senha de integração (o `X-APP-TOKEN` que já existe no projeto Indicadores é da API de relatórios, e só lê). Quando chegarem, o próximo passo é a IA consultar horários livres e criar o cadastro do paciente no Klingo sozinha, mantendo a marcação com o humano. Pendências para perguntar ao suporte (suporte@klingo.com.br): pré-agendamento/lista de espera na API, busca de paciente por CPF (evita cadastro duplicado), endpoints de valor e preparo, campos obrigatórios do cadastro e ambiente de testes.

### Catálogo do Klingo para a IA

A IA consulta, a cada mensagem do paciente, um catálogo copiado de relatórios de cadastro do Klingo (sem dado de paciente): procedimentos e preparo (#13981), agenda por profissional (#13984) e operadoras/planos (#12301). As tabelas são `catalogo_*` e a busca é a função `ia_catalogo`, que entende siglas e erros comuns (RM = ressonância, TC = tomografia, US/USG = ultrassonografia, RX = radiografia).

- Atualização: a Edge Function `sync-catalogo-klingo` (publicada no projeto webchat-atendimento) busca os três relatórios todo dia às 03:00 (Brasília, via pg_cron) e **compara** com o que já existe (`catalogo_sincronizar`): o que entra, sai ou muda fica em `catalogo_mudanca`, o que sumiu do Klingo vira `ativo = false` (não é apagado) e um relatório que venha com menos da metade das linhas é recusado. Ela usa o secret `KLINGO_APP_TOKEN` do Supabase (o token nunca vai para o repositório) e só aceita chamadas com o header `x-sync-key` igual ao segredo da IA. Para atualizar na hora: `curl -X POST <URL da função> -H "x-sync-key: <segredo>"`. Cada relatório é independente: se um falhar, o catálogo anterior dele continua valendo.
- Carga manual em lotes: função `ia_catalogo_carregar` (mesmo segredo).
- A agenda do catálogo é a grade semanal cadastrada, não horário livre: o atendente confirma data e hora.

### Preços, demanda e lista de limpeza (Fase 1)

- **Preços** (`catalogo_preco`): convênio vem do relatório #13983 pedido por operadora (03:10) e o Particular vem do valor das marcações abertas dos últimos 90 dias do #13825, só agregado, sem dado de paciente (03:25). A IA só usa preço com confiança alta ou média: tabelas CBHPM guardam coeficiente, não reais, e Particular com uma marcação só é baixa. **A IA não informa preço ao paciente** (desde a Fase 6b ela nem recebe o valor): quem informa é o atendente. O catálogo serve para vigiar o valor que o atendente escreve no chat: se estiver 10% ou mais fora da referência, aparece um alerta **só para a equipe** (ver `docs/fase6-unidade-e-medico.md`).
- **Demanda** (`catalogo_procedimento.demanda_90d`): marcações abertas por procedimento nos últimos 90 dias; a IA prefere o exame que a clínica realmente faz.
- **Foto de referência** (`catalogo_foto`, `referencia = true`): cópia do catálogo de 29/10/2026, antes da limpeza no Klingo. Não apagar.
- **Aba Catálogo** do painel (só administrador): o que limpar no Klingo (sem agenda vigente, duplicados, agenda de teste, sem preço, mais pedidos sem preparo) e o histórico de mudanças.
- SQL em `supabase/catalogo-historico*.sql` e `supabase/catalogo-precos.sql`. Plano completo e fases em `docs/`.
- **n8n**: removido em 03/11/2026. As correções de 31/10/2026 do fluxo antigo ficam só como histórico em `docs/n8n-correcao-2026-10-31.md`.

### Paciente que volta (conferência de identidade)

- Ao abrir o chat o paciente informa nome, telefone e e-mail. `paciente_conferir` compara isso com `pacientes` (nome aproximado, telefone sem DDI/nono dígito, e-mail): **nome e telefone batem (e o e-mail, se o cadastro tem) = completo** (reaproveita o cadastro), **qualquer outra combinação = novo**. O antigo "parcial" (2 de 3 campos) foi removido; ver a regra do "login" logo abaixo.
- Antes de reaproveitar qualquer dado do cadastro a IA pede a **data de nascimento**; se não bater, segue como paciente novo e o cadastro novo fica marcado `revisar` quando o CPF se repete. A IA nunca revela o que está guardado.
- `pacientes.validado` fica `true` quando a identidade é conferida num novo atendimento ou quando a atendente marca o pré-agendamento como agendado. O cartão do painel mostra a situação (`pre_agendamentos.identidade`).
- SQL em `supabase/pacientes.sql`.
- **Nome + telefone + e-mail são o "login"** (`supabase/correcao-login-nome-telefone-email.sql`, aplicado em 30/10/2026): só reaproveita cadastro, histórico ou pedido pela metade quem bate nome E telefone e, se o cadastro tem e-mail, o e-mail também. Qualquer outra combinação (mesmo telefone com outro nome, mesmo nome com outro e-mail, e-mail em branco) é paciente novo e não vê nada do outro; o "parcial" deixou de existir. A data de nascimento continua sendo o segundo fator antes de a IA usar qualquer dado.
- **Nome por conversa** (correção): `contatos` é único por telefone e o nome nunca era atualizado, então quem usava o telefone de outra pessoa era chamado pelo nome dela e herdava o cadastro dela. Agora `conversas.nome_informado`/`email_informado` guardam o que foi digitado em cada conversa, e IA, conferência de identidade e painel usam isso. SQL em `supabase/correcao-nome-por-conversa.sql`: já aplicado no projeto em 30/10/2026 (o painel lê as colunas novas). Mesmo telefone com nome diferente é paciente novo (o "parcial" não existe mais; conferido no banco em 30/10/2026: `paciente_conferir` só devolve `completo` ou `novo`). A IA continua pedindo a data de nascimento antes de reaproveitar qualquer dado.

### Fase 2: pedido por mapa do corpo, listas e calendário de horários

- **Chat do paciente** (`index.html`): a mensagem da IA pode trazer um componente: **lista** (caixas ou uma escolha, com "Outro"), **mapa do corpo** e **calendário**. O texto da pergunta sempre vai junto, então quem não vê o componente consegue responder digitando.
- **Mapa do corpo**: tipo de exame (ressonância, tomografia, ultrassom, raio-X; mamografia e densitometria por lista), vista de frente e de costas, várias partes e **vários exames** no mesmo pedido. De frente, o lado direito do paciente fica à esquerda do desenho (letra **D** nas bordas e legenda); de costas, o contrário. O lado fica no item do pedido (D, E ou ambos): "ambos" vira o exame bilateral ou 2 unidades do unilateral, e exame bilateral com um lado só é recusado pelo servidor. Partes sem exame cadastrado ficam tracejadas.
- **Calendário** (`chat_horarios`): só horários livres, de 20 ou 30 em 30 min, em "sala de cinema" (ocupados em cinza). Usa a grade de cada profissional, a duração reservada por modalidade (`agenda_regra_duracao`: RM 30 min, TC e US 20 min, RX 10 min; ajustável), exige blocos seguidos, exige a sala certa da modalidade (`agenda_modalidade_local`), respeita antecedência de 2 h e não deixa o mesmo paciente em dois lugares ao mesmo tempo. O que já está marcado vem do relatório #7 do Klingo (sem dado de paciente) a cada 10 minutos (cron `agenda-ocupacao`). Na hora de gravar, o servidor confere de novo se o horário ainda está livre.
- **Etapas** (`pre_agendamentos.etapa`): pedido, plano, preferências, data e hora, dados, confirmação, pronto. O contexto que a IA recebe encolhe nas etapas finais.
- SQL em `supabase/fase2-pedido-e-agenda.sql`.
- **Ativar**: o chat novo só aparece depois do merge (GitHub Pages).

### Unidade e médico de preferência no início do chat (Fase 6)

O formulário pergunta primeiro a unidade (Desenvoar = atendimento pediátrico; CSI = exames e consultas; CSI RM/TC = ressonância e tomografia; "Ainda não sei") e **quem será atendido** (o próprio ou um filho(a), com o responsável falando pelo filho; uma conversa por criança e "Agendar para outro filho(a)" no menu). O médico de preferência vem depois do e-mail. A IA já nasce no caminho certo e o calendário filtra por unidade e médico. Passo a passo, texto do n8n e limites em `docs/fase6-unidade-e-medico.md`; SQL em `supabase/fase6-unidade-e-medico.sql` e `supabase/fase6b-alerta-preco.sql` (**aplicados no projeto em 30/10/2026**). Falta só o n8n (ver `docs/fase6-roteiro-de-teste-e-producao.md`).

### Atendimento sem IA: motor de regras no Supabase (Fase 7)

Quem responde o paciente é um motor de regras no banco, na mesma chamada que grava a mensagem. No servidor, cada passo leva de 3 a 27 ms; antes, a IA levava 7 s na mediana.

- O formulário pergunta só se o atendimento é para o próprio paciente ou para um filho(a). A unidade sai da escolha: consulta de criança vai para a Desenvoar e de adulto para a CSI.
- O chat é só de botões e listas com filtro. Os dados do cadastro são pedidos um grupo por mensagem.
- O paciente pode tirar foto do pedido médico: o celular lê o texto (OCR) e a foto vai para o atendente.
- Depois de enviar, o paciente vê um contador ao vivo até a confirmação.
- Quem volta pelo link do WhatsApp ou do e-mail entra direto, pelo cache do aparelho.

A IA não fala com o paciente. Liga e desliga em `config.motor` (`fluxo` | `ia`).

- Detalhes, testes e como voltar atrás: `docs/fase7-motor-implementado.md`.
- Plano e mapa do processo: `docs/plano-fase7-fluxo-sem-ia.md`.
- SQL: `supabase/fase7-motor.sql`, aplicado em 31/10/2026.

### Leitura do pedido médico: letra de médico e dúvida explicada (Fase 8)

A foto do pedido é lida de dois jeitos ao mesmo tempo:

- **No celular** (Tesseract 7, com a sombra e a foto torta corrigidas): lê o texto impresso em 2 a 3 segundos.
- **No servidor**, pela IA de visão (Edge Function `ler-pedido`): lê a letra do médico.

O paciente vê um cartão por exame, com o recorte da linha da foto. Quando a leitura não tem certeza, ele é avisado e escolhe com caixas grandes ("Qual destes está no seu pedido?"), ou deixa para o atendente conferir pela foto. O que o paciente decidiu nunca é desfeito por uma leitura que chega depois.

As fotos e as leituras ficam guardadas. No painel, "Conferir a leitura (ensina o sistema)" grava a escrita do médico e o exame certo, e da próxima vez a mesma escrita já vem certa.

- Detalhes, pesquisa, custos e testes: `docs/fase8-leitura-do-pedido.md`.
- SQL: `supabase/fase8-leitura-pedido.sql` (aplicado no Supabase em 31/10/2026).
- Função: `supabase/functions/ler-pedido` (**ainda não publicada**). Publicar sem JWT e criar o secret `ANTHROPIC_API_KEY`. Sem a chave, o chat usa só a leitura do celular.
- **Para depois**: mudar escolhas ao vivo e o convênio de quem volta, em `docs/lembrete-mudar-escolhas-e-convenio.md`. O convênio de quem volta já é perguntado (ver acima).

## Fila em tempo real + assinatura biométrica

**Em construção; ainda não está no ar para o público.** O banco real está na primeira versão do módulo; a atualização (`supabase/fila-biometria-v2-delta.sql`) está escrita e testada, mas ainda não foi aplicada. A tela do paciente (`fila/`) ainda não existe no repositório: a versão antiga, incompatível, foi retirada para não ser publicada no GitHub Pages (continua no histórico do git, na branch `ccr-37cc4eeb-fi5p2l`).

- Regras no banco: `supabase/fila-biometria.sql` (instalação do zero) e `supabase/fila-biometria-v2-delta.sql` (para quem já aplicou a primeira versão).
- Algoritmo da assinatura: `supabase/functions/fila-validar-assinatura/avaliacao.ts` (Edge Function, sem servidor próprio). `biometria/avaliar_assinatura.py` é a referência em Python; `biometria/gerar_vetores.py` congela o que ele devolve e o teste exige o mesmo resultado do TypeScript.
- Fluxo, Edge Functions, passo a passo para colocar no ar (o que é seu e o que é do Claude), riscos e LGPD: `docs/fila-biometria.md`.

## Testes e auditoria

`cd testes && npm install && npm test` repete a bateria (Edge Function, algoritmo Python, banco da Fila, atualização v1 para v2 e fumaça das páginas em navegador). Instruções e o que os testes **não** provam: `testes/README.md`. Evidências, achados e veredito de produção de 30/10/2026: `docs/auditoria-2026-10-30.md`.

## Estado do projeto e como retomar

**Aba Aprendizado (administrador)**: relatório de onde a IA erra, preço do catálogo x Klingo e casos para melhorar o prompt (Fase 5; SQL em `supabase/fase5-aprendizado.sql`).

Veja `docs/passagem-fases-3-a-5.md`: o que cada fase faz, o que falta, o checklist para continuar em outra conta e as regras que não podem ser quebradas. `supabase/00-base-snapshot.sql` é só referência do banco base (não rodar no projeto atual).

Antes de divulgar a IA a mais pacientes, leia os achados de `docs/auditoria-2026-10-30.md` (seções 2.4 e 2.6): as Fases 6 e 7 entraram depois da auditoria e não foram auditadas; falta aviso à equipe fora do painel; preços do catálogo divergentes do Klingo (agora só referência para o alerta da equipe); e proteção contra senha vazada desligada.
