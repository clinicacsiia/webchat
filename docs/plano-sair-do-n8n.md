# Plano: sair do n8n e trazer o que ele fazia para dentro do programa

Data: 03/11/2026. Decisão do dono: o n8n deixa de existir no projeto.

## 1. Feito em 03/11/2026 (fase 0, sem risco)

| O quê | Resultado |
|---|---|
| `config.n8n_webhook_url` e `config.n8n_webhook_token` | esvaziados (as funções do banco já tratam vazio como "desligado") |
| Fluxo `Triagem IA - Atendimento` (`wAbzjPqZNCztKriZ`) | despublicado e arquivado no n8n (recuperável pelo n8n enquanto a conta existir) |
| Chat, painel, motor `fluxo` | não foram tocados; o motor não passava pelo n8n |

Atenção: o segredo `ia_segredo` ficou escrito nos nós do fluxo arquivado. Ele **não pode ser trocado de qualquer jeito**, porque `fluxo_pre` o lê da tabela `config` para chamar `ia_pre_agendar`. Para trocar: atualizar `config.ia_segredo` e conferir antes se algum cron ou Edge Function o usa (`grep ia_segredo` no `cron.job` e em `supabase/functions`). Fazer na fase 1.

## 2. O que o n8n fazia, e para onde vai

| # | Função no n8n | Situação hoje | Destino no programa |
|---|---|---|---|
| 1 | Triagem por IA a cada mensagem | Substituída pelo motor `fluxo` (Fase 7). Nada a portar | Remover (fase 1) |
| 2 | Aviso à equipe quando há transferência | **Nunca foi montado** (nó vazio). O banco já monta o evento `transferencia` em `fluxo_transferir` | Edge Function `avisar-equipe` (e-mail), chamada pelo próprio `fluxo_transferir` via `pg_net` |
| 3 | Fila: "emitir link" (e-mail com o link da assinatura) | **Nunca foi montado.** `fila_avisar_n8n` só dispara se `fila_webhook_url` estiver preenchida | Edge Function `fila-emitir-link` |
| 4 | Fila: "validar assinatura" (rodar `biometria/avaliar_assinatura.py`) | **Nunca foi montado** | Edge Function `fila-validar-assinatura`, com o algoritmo em TypeScript |
| 5 | Avisos por WhatsApp ao paciente | Nunca existiu | Fora deste plano (precisa de número na API oficial) |

Resumo: dos cinco, só o primeiro existia de fato, e já foi substituído. Os itens 2 a 4 são construção nova, não migração.

## 3. Como construir cada peça

Princípio: nada novo entra em produção antes de ter teste automático. Cada Edge Function usa o mesmo padrão de `sync-catalogo-klingo`: segredo no Vault do Supabase, nunca em arquivo.

### 3.1 `fila-emitir-link` (item 3)
- Substitui `fila_avisar_n8n`. O banco chama a função por `pg_net` com o `atendimento_uuid` (como hoje), mas para a URL da própria Edge Function.
- A Edge Function usa a chave de serviço (já injetada pelo Supabase) para chamar `fila_emitir_token`. Some a necessidade do cabeçalho `x-fila-segredo` e da função `fila_n8n_autorizado` (sai na fase 2).
- Envia o e-mail por um provedor transacional (Resend ou SMTP). **Precisa de você**: escolher o provedor e criar a chave como secret `EMAIL_API_KEY` (painel, sem colar na conversa).
- O destinatário vem sempre da resposta do banco, nunca do corpo da chamada.
- Teste: Deno test com o provedor simulado, mais um teste SQL do novo gatilho.

### 3.2 `fila-validar-assinatura` (item 4)
- Porta `biometria/avaliar_assinatura.py` (sem classes nem imports exóticos, já é puro) para TypeScript.
- Teste de paridade: gerar com o Python vetores de entrada e saída (características, score, aprovado, perfil novo) e exigir resultado idêntico no TypeScript. O Python vira a "referência" e fica no repositório só para esse teste.
- O navegador passa a chamar a Edge Function, que faz `assinatura_contexto` → avalia → `assinatura_registrar`. O banco continua sendo a autoridade final (limiar 0,30, 3 tentativas, hash).
- O sandbox restrito do n8n deixa de existir; o teste `test_avaliar_assinatura.py` com builtins do n8n é substituído pelo teste de paridade.

### 3.3 `avisar-equipe` (item 2)
- `fluxo_transferir` troca o ramo do n8n por uma chamada à Edge Function, que manda um e-mail à equipe com nome, motivo, urgência e se há equipe online. Sem dado clínico no e-mail.
- Lista de destinatários em `config.equipe_emails` (editável no painel).
- Alternativa sem custo e sem provedor: notificação push do navegador (service worker). Decidir com o dono; o e-mail é o caminho mais simples.

## 4. Limpeza do que era do n8n (fases 1 e 2, ainda não feitas)

Análise feita no banco real em 03/11/2026.

### Pode sair (só o n8n usava)
- Gatilho `mensagens_avisar_n8n` e função `avisar_n8n_mensagem`.
- `ia_contexto`, `ia_responder`, `ia_responder_v2` (nenhuma outra função chama).
- `ia_catalogo` (busca por mensagem para a IA). Confirmar uma última vez que o motor não usa; nenhuma função de `public` a chama hoje.
- Ramos de n8n dentro de `fluxo_transferir` e de `chat_iniciar` (já inertes com a URL vazia). Trocar por `create or replace`.
- No painel: a seção "Integração com n8n" (`painel/index.html`, ~linha 2321) e a dica "ajustar as instruções da IA no n8n" (~linha 2673).
- Arquivos: `n8n/novo-atendimento.json`, `docs/n8n-correcao-2026-10-31.md` (virar histórico) e as seções do `LEIAME.md` sobre n8n.
- Config: `n8n_webhook_url`, `n8n_webhook_token` (e `fila_webhook_url` quando a fila for refeita).

### NÃO pode sair (o motor depende)
- `ia_pre_agendar`, `fluxo_pre` e `config.ia_segredo`.
- `ia_catalogo_carregar` (porta de carga do catálogo).
- `ia_relatorio`, `ia_exemplos`, `ia_precos_divergentes`, `ia_coorte`, `ia_evento_*` e o gatilho `ia_evento_pre` (usados pela aba de aprendizado do painel e testados).
- Coluna `conversas.motor` e a lógica do motor `fluxo`. O valor `ia` deixa de ter caminho de volta; decidir se se apaga o valor.

### Texto jurídico
`privacidade.html` (linha 66) cita o n8n como operador. Só mudar com revisão jurídica (item A8): depois da limpeza o n8n deixa de tratar dados, mas o texto mexe com LGPD.

## 5. Ordem de execução e como não quebrar produção

| Fase | O quê | Quem | Segurança |
|---|---|---|---|
| 0 | Esvaziar URL, despublicar e arquivar o fluxo | feito | motor `fluxo` não usa o n8n |
| 1 | Migração em partes pequenas (60 s por migração; `drop` pede confirmação): `create or replace` de `fluxo_transferir` e `chat_iniciar` sem o ramo n8n; depois `drop trigger` e `drop function` das funções da lista acima; trocar `ia_segredo` | Claude (você confirma os `drop`) | Antes: rodar `npm test` completo e abrir uma conversa de teste no chat, passar por uma transferência e conferir que a mensagem do motor chega. Depois: repetir |
| 2 | Painel e repositório: tirar a seção n8n, apagar o JSON e ajustar `LEIAME.md`, `testes/` e o snapshot SQL | Claude | Mesma bateria de testes, em branch, merge só com tudo verde; conferir o GitHub Pages depois |
| 3 | Construir `avisar-equipe` (exige escolher o provedor de e-mail) | Claude + você | Edge Function nova, nada existente muda |
| 4 | Construir `fila-emitir-link` e `fila-validar-assinatura`, refazer a tela `fila/` e a aba da recepção, aplicar `fila-biometria-v2-delta.sql` | Claude + você | Já exigia teste ponta a ponta com paciente de teste (D6) |
| 5 | LGPD da biometria e texto de privacidade | Terceiro | Antes de paciente real |

Reverter a fase 1 ou 2: as definições antigas estão no Git e nas migrações do Supabase (Database > Migrations). A fase 0 volta preenchendo as duas chaves em `config` e restaurando o fluxo arquivado no n8n.

## 6. Decisões que dependem de você
1. Provedor de e-mail para os avisos (Resend, SMTP do Gmail da clínica, ou outro).
2. Aviso à equipe: e-mail, push no navegador, ou os dois.
3. Aprovar os `drop function` da fase 1 (o Supabase pede confirmação humana).
