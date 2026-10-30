# Webchat de atendimento

Chat estilo WhatsApp para clientes + painel da equipe e do marketing.
Tudo em HTML/CSS/JS puro (PWA), com Supabase no servidor e n8n para automações.

```
index.html            chat do cliente        -> https://SEU-USUARIO.github.io/SEU-REPO/
painel/index.html     painel da equipe       -> https://SEU-USUARIO.github.io/SEU-REPO/painel/
n8n/novo-atendimento.json   workflow para importar no n8n
```

Banco: projeto Supabase `webchat-atendimento` (sa-east-1), já com tabelas, regras de segurança e tempo real.

## Publicar no GitHub Pages

1. Crie um repositório (ex.: `webchat`) e envie todo o conteúdo desta pasta (menos `n8n/`, se quiser).
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

## Ligar o n8n

1. No n8n: Create workflow > menu (...) > Import from file > `n8n/novo-atendimento.json`.
2. Ative o workflow e copie a URL **Production** do nó Webhook (termina em `/webhook/novo-atendimento`).
3. No painel: Configurações > Webhook do n8n > cole a URL > Salvar.
4. Troque o último nó por Telegram, E-mail ou WhatsApp. O texto pronto está no campo `texto`.

Só nascem execuções no n8n quando uma conversa nova começa (não a cada mensagem), então o plano de 1000 execuções rende.

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
- Ligação com o WhatsApp oficial (via n8n + API do WhatsApp Business)
- Resposta automática fora do horário de atendimento

## Triagem por IA (n8n + Claude)

- Workflow `Triagem IA - Atendimento` no n8n (URL Production `/webhook/novo-atendimento` salva em Configurações > Webhook do n8n).
- A cada mensagem do paciente o Supabase avisa o n8n, que lê o histórico (funções `ia_contexto` / `ia_responder`, protegidas pela chave `ia_segredo` da tabela `config`), pede ao Claude a resposta e a devolve ao chat.
- Ao ter o essencial, em urgência ou após 10 falas, a IA para (`ia_ativa = false`) e a conversa fica em Aguardando com resumo e urgência no painel.
- Desligar a IA: na tabela `config`, `ia_ativa = 'nao'`. Quando um atendente assume, a IA já para sozinha.

## Pré-agendamento pela IA (Klingo)

Quando o paciente quer consulta ou exame, a assistente segue o roteiro: pedido (especialidade/procedimento) > plano (Particular ou convênio) > preferências (unidade, profissional, período) > dados do paciente em grupos (identificação, contato, endereço, carteirinha) > leitura de volta e confirmação > passa para o atendente.

- Os dados ficam na tabela `pre_agendamentos` (uma por conversa), gravados pela função `ia_pre_agendar` via n8n. Só administrador e atendente leem (tem CPF, nome da mãe e endereço); marketing não.
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

- **Preços** (`catalogo_preco`): convênio vem do relatório #13983 pedido por operadora (03:10) e o Particular vem do valor das marcações abertas dos últimos 90 dias do #13825, só agregado, sem dado de paciente (03:25). A IA só usa preço com confiança alta ou média: tabelas CBHPM guardam coeficiente, não reais, e Particular com uma marcação só é baixa. **Todo valor é uma previsão**: a IA diz que o preço pode mudar e que o atendente avalia e confirma valor e data.
- **Demanda** (`catalogo_procedimento.demanda_90d`): marcações abertas por procedimento nos últimos 90 dias; a IA prefere o exame que a clínica realmente faz.
- **Foto de referência** (`catalogo_foto`, `referencia = true`): cópia do catálogo de 29/10/2026, antes da limpeza no Klingo. Não apagar.
- **Aba Catálogo** do painel (só administrador): o que limpar no Klingo (sem agenda vigente, duplicados, agenda de teste, sem preço, mais pedidos sem preparo) e o histórico de mudanças.
- SQL em `supabase/catalogo-historico*.sql` e `supabase/catalogo-precos.sql`. Plano completo e fases em `docs/`.
- **n8n**: o fluxo `Triagem IA - Atendimento` precisa estar **publicado** para valer (o rascunho não atende ninguém). O nó "Ler resposta da IA" lê `merged_response` ou o bloco de texto, e o nó do Claude usa `maxTokens` 4000 (com 1200 o JSON vinha cortado e caía na resposta de emergência).

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
- **Ativar**: o chat novo só aparece depois do merge deste PR (GitHub Pages). O fluxo do n8n com o prompt novo (versão "Prompt por etapas...") já está salvo, mas a versão **publicada** continua a anterior até o merge; depois do merge, publique a versão mais recente do fluxo `Triagem IA - Atendimento`.

## Fila em tempo real + assinatura biométrica

**Em construção; ainda não está no ar para o público.** O banco real está na primeira versão do módulo; a atualização (`supabase/fila-biometria-v2-delta.sql`) está escrita e testada, mas ainda não foi aplicada. A página `fila/` do repositório é uma versão antiga e **não deve ser publicada** até ser reescrita.

- Regras no banco: `supabase/fila-biometria.sql` (instalação do zero) e `supabase/fila-biometria-v2-delta.sql` (para quem já aplicou a primeira versão).
- Algoritmo da assinatura: `biometria/avaliar_assinatura.py`, executado no nó Python do n8n (sem servidor próprio).
- Fluxo, workflows do n8n, passo a passo para colocar no ar (o que é seu e o que é do Claude), riscos e LGPD: `docs/fila-biometria.md`.

## Testes e auditoria

`cd testes && npm install && npm test` repete a bateria (Edge Function, algoritmo Python, banco da Fila, atualização v1 para v2 e fumaça das páginas em navegador). Instruções e o que os testes **não** provam: `testes/README.md`. Evidências, achados e veredito de produção de 30/10/2026: `docs/auditoria-2026-10-30.md`.

## Estado do projeto e como retomar

**Aba Aprendizado (administrador)**: relatório de onde a IA erra, preço do catálogo x Klingo e casos para melhorar o prompt (Fase 5; SQL em `supabase/fase5-aprendizado.sql`).

Veja `docs/passagem-fases-3-a-5.md`: o que cada fase faz, o que falta, o checklist para continuar em outra conta e as regras que não podem ser quebradas. `supabase/00-base-snapshot.sql` é só referência do banco base (não rodar no projeto atual).

Antes de divulgar a IA a mais pacientes, leia os achados de `docs/auditoria-2026-10-30.md` (seção 2.4): preços do catálogo divergentes do Klingo, nó de IA do n8n sem repetição, proteção contra senha vazada desligada.
