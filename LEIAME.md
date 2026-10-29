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
