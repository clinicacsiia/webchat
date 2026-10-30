# Passagem de bastão — o que está feito, o que falta e como retomar em outra conta

Atualizado em 2026-10-30 (auditoria para produção). Leia este arquivo inteiro antes de mexer em qualquer coisa.

**Auditoria de 30/10/2026:** evidências, achados e o que não foi provado estão em `docs/auditoria-2026-10-30.md`. Os testes repetíveis estão em `testes/` (`cd testes && npm install && npm test`; instruções em `testes/README.md`). Resultado: 27 + 27 + 46 + 5 + 6 verificações verdes; o sistema das Fases 1 a 5 está saudável em produção; o módulo **Fila + assinatura biométrica não está pronto** (ver linha "Fila" abaixo).

## 1. Resumo em uma tela

| Fase | O que é | Situação |
|---|---|---|
| 0 | Verificação no Klingo (relatórios, token) | Concluída |
| 1 | Memória do catálogo (histórico de mudanças, preços) | Concluída e no ar |
| 2 | Pedido pelo mapa do corpo, calendário, reservas de horário | Concluída e no ar |
| 3 | Conferência automática da marcação no Klingo | **~80%**: construída, testada no banco e em testes de código; **falta validar com uma marcação real** e 2 pendências pequenas (ver 4) |
| 4 | Paciente que volta (histórico, atalhos, retomar pedido) | **Construída e no ar** (banco, Edge Function, n8n). Painel e chat novos estão na `main` (PR #12, `336f527`; Pages publicado com sucesso). Falta validar com um paciente real |
| 5 | Aprendizado com as correções dos atendentes | **Construída e no ar** (banco, Edge Function v14, aba Aprendizado no painel). Falta juntar dados reais: o registro começa no dia em que o SQL rodou |
| Fila | Fila virtual em tempo real + assinatura biométrica dinâmica (`docs/fila-biometria.md`) | **Em construção, fora do ar para o público.** Banco na v1 (tabelas vazias), migração v2 escrita e testada mas **não aplicada**, algoritmo Python pronto (27 testes). Faltam: aplicar a v2, credenciais do n8n (Header Auth e SMTP), os dois workflows, `fila/fila.js` novo, aba da recepção, `config.fila_webhook_url`. PR #15 aberto como rascunho, **sem merge** |

**Situação do código:** o PR #12 (Fases 3 e 4) foi mergeado na `main` (commit `336f527`) e o deploy do GitHub Pages terminou com sucesso. Banco, Edge Function v10 e n8n já estavam no ar (a Fase 5 trouxe a Edge Function v14). O que falta é conferir o painel e o chat novos no navegador (item 4 da lista de pendências).

## 2. Para retomar em outra conta (checklist)

Nada disto está no repositório; é preciso refazer nas conexões da conta nova:
1. **GitHub**: acesso ao repositório `clinicacsiia/webchat` (trabalhar em uma branch nova a partir da `main` e abrir PR para ela).
2. **Supabase** (conector): projeto `webchat-atendimento`, id `nrvuynjwcgwpjdptkiay` (sa-east-1). É o MESMO projeto: não crie outro. A conta nova precisa de acesso a ele.
3. **n8n** (conector): instância `clinicacsi.app.n8n.cloud`, workflow `wAbzjPqZNCztKriZ` "Triagem IA - Atendimento" (versão ativa `7bcf2009-34ff-4085-a17f-a931ff68188f`). Falta escolher/confirmar a credencial Anthropic no nó "Triagem com Claude" se a conta mudar.
4. **Gmail** (opcional): o e-mail ao suporte do Klingo está só como rascunho (`docs/fase-0-email-suporte-klingo.md` tem o texto).
5. **Segredos (não estão no repositório, e não devem estar):**
   - `KLINGO_APP_TOKEN`: secret da Edge Function `sync-catalogo-klingo` (Supabase > Edge Functions > Secrets).
   - `config.ia_segredo`: valor na tabela `config`; o mesmo valor está digitado nos nós HTTP do n8n (`p_segredo`) e no cron. Para trocar, mude nos dois lados.
   - A chave "publishable" do Supabase está no `index.html` e no `painel/index.html` (é pública por desenho).
6. **Conferir que tudo está no lugar** (rode no SQL do projeto, deve dar `true` em todas):
```sql
select
  (select count(*) = 6 from cron.job where jobname in ('sync-catalogo-klingo','catalogo-precos-convenio','catalogo-precos-particular','agenda-ocupacao','agenda-conferir','agenda-revisar')) as crons,
  to_regclass('public.paciente_historico') is not null as historico,
  exists (select 1 from pg_proc where proname = 'agenda_conferencia_aplicar') as fase3,
  position('historico_paciente' in pg_get_functiondef('public.ia_contexto(text,uuid)'::regprocedure)) > 0 as ctx,
  position('pre_reaproveitar' in pg_get_functiondef('public.ia_pre_agendar(text,uuid,jsonb,boolean)'::regprocedure)) > 0 as reaproveitar;
```
7. **Edge Function**: versão 14 de `sync-catalogo-klingo` (arquivos `index.ts`, `conferencia.ts` e `precos.ts` da pasta `supabase/functions/sync-catalogo-klingo/`). Testes locais: `cd testes && npm run test:edge` (27 devem passar: 17 da conferência e 10 dos preços). A comparação do código publicado com o do repositório **não foi feita** (ver auditoria, 2.5).
8. **Se algum dia precisar recriar o banco do zero**: `supabase/00-base-snapshot.sql` tem as tabelas e funções base (chat, painel, login) e os demais `supabase/*.sql` vêm depois, mas os arquivos antigos contêm *correções por substituição* aplicadas na mão e não são uma receita completa. O caminho seguro é `supabase db dump --schema public` do projeto atual. Não rode `00-base-snapshot.sql` no projeto atual.

Ordem dos arquivos SQL (referência do que foi aplicado, nesta ordem): `00-base-snapshot` (referência) → `pre-agendamentos` → `catalogo-klingo` → `catalogo-historico` → `catalogo-historico-parte2` → `catalogo-precos` → `pacientes` → `fase2-pedido-e-agenda` → `fase3-conferencia-automatica` → `fase4-paciente-que-volta`.

## 3. O que cada fase faz hoje

### Onde está cada peça
- **Repo** `clinicacsiia/webchat`: `index.html` (chat do paciente), `painel/index.html` (painel), `supabase/*.sql`, `supabase/functions/sync-catalogo-klingo/`, `n8n/novo-atendimento.json` (workflow antigo, só referência), `docs/`, `LEIAME.md` (publicação e papéis).
- **Crons (UTC)**: `sync-catalogo-klingo` 0 6; `catalogo-precos-convenio` 10 6; `catalogo-precos-particular` 25 6; `agenda-ocupacao` a cada 10 min das 8h à 1h; **`agenda-conferir` a cada 15 s** (só chama o Klingo se houver pedido esperando; cobre as primeiras 6 h de cada pedido); **`agenda-revisar` a cada 10 min** (todos os pedidos esperando e os já confirmados).
- **Edge Function** `sync-catalogo-klingo` (header `x-sync-key` = `config.ia_segredo`): modos `{}` catálogo, `{"inspecionar":id}`, `{"precos":"convenio"|"particular"}`, `{"agenda":"ocupacao"}`, `{"agenda":"conferir"}` (+ `"lento":true`).
- **Klingo**: relatórios via `https://api-externa.klingo.app/api/info/relatorio?id=…`, header `X-APP-TOKEN`. #13981 procedimentos, #13984 agenda, #12301 planos, #13983 preços convênio, #13825 marcações (Particular), #7 agendas marcadas, #47 bloqueado. Colunas do #7: Unidade, Marcacao, Data_Atendimento, Medico, Paciente, Operadora, Prontuario, Telefone, Procedimento, Previsto, Obs, Status (A Confirmar / Confirmado / Sem Resposta: não aparecem cancelados), Data_Agendamento, Usuario, Origem, Quantidade.

### Fase 3 — conferência automática (`supabase/fase3-conferencia-automatica.sql`)
- A Edge Function lê o #7 só dos dias com pedido esperando e compara **na memória** (últimos 8 dígitos do telefone; nome) com o paciente da conversa. Só o veredito por horário (ok / outro / livre) vai ao banco (`agenda_conferencia_aplicar`). Nome, telefone e prontuário do Klingo não são gravados nem logados.
- Reconhecimento: telefone (ou telefone + nome). Só pelo nome exige nome IGUAL e exame exato; nome parecido nunca confirma (homônimos).
- Tudo bateu → `status = agendado` sozinho, `conferencia_status = confirmado` (+ `conferencia_via`) e mensagem de confirmação ao paciente no chat (exames, dia/hora/unidade, preparo do cadastro; sem preço), uma vez (`confirmacao_enviada_em`).
- Só confirma quando **todos os horários que o pedido exige** (um por grupo de exame/sala, `agenda_grupos`) foram escolhidos e aparecem no Klingo.
- Alertas (`pre_agendamentos.conferencia_status`, `conversas.alerta_agenda`; aparecem na lista e no cartão do painel): `horario_tomado`, `divergente`, `nao_encontrado` (horário passou +1 h sem marcação), `sumiu` (confirmado que deixou de aparecer em 2 revisões seguidas), `remarcado`. O atendente que clica "Marcar como agendado" ou "Cancelar" limpa o alerta.
- Ordem de chegada também é conferida (qualquer hora do dia, mesma sala/unidade/exame/paciente) e nunca vira "horário tomado".
- Trocar o pedido de exames apaga o horário escolhido antes; pedido já concluído (agendado/cancelado) não pode ser trocado na mesma conversa (o paciente que volta abre conversa nova).
- Falha de um dia no Klingo deixa sem veredito só quem depende daquele dia.

### Fase 4 — paciente que volta (`supabase/fase4-paciente-que-volta.sql`)
- Cada visita abre uma **conversa nova** (`chat_iniciar`); o contato é o mesmo (telefone). O paciente conhecido é achado por `paciente_conferir` (nome/telefone/e-mail).
- `paciente_historico`: uma linha por marcação concluída (gatilho em `pre_agendamentos.status`); cancelada ou revertida só é marcada, nunca apagada.
- `ia_contexto` devolve `historico_paciente`. **Os detalhes só saem com a data de nascimento conferida** (`liberado`). Antes, a IA só sabe que existe histórico e pede a data já na primeira resposta.
- `ia_pre_agendar` aceita `reaproveitar = ultimo | pendente`: copia exames (inclusive o lado) para a conversa nova; `pendente` também copia plano e unidade. Só com data de nascimento conferida e só se a conversa ainda não tem exames.
- n8n: o prompt tem a seção "PACIENTE QUE VOLTA" (atalho em lista: repetir o último exame / continuar o pedido pela metade / outro exame; sugerir manter plano e unidade; nunca revelar antes da data de nascimento).
- Painel: "Histórico do paciente" no cartão do pré-agendamento.

## 4. Pendências (tudo o que falta, em ordem)

**Fase 3 (o que falta para 100%)**
1. **Validar com uma marcação real** (o que mais importa). Faça: abra o chat como paciente de teste (telefone `7190000xxxx`), monte o pedido, escolha o horário, deixe a atendente lançar no Klingo e veja o status virar "Agendado" em até ~15 s. Se não virar: `select net._http_response` da chamada, logs da Edge Function (Supabase > Edge Functions > Logs) e `cron.job_run_details` do job `agenda-conferir`. Se o telefone do Klingo vier em formato diferente, ajuste `fonesDaLinha` em `conferencia.ts` (há testes).
2. **Remover duas funções provisórias** sem uso: `agenda_conferir_pre_agendamentos()` e `agenda_conferencia_iniciar(boolean)`. O `drop` pede confirmação humana no Supabase e a pergunta ficou sem resposta; o comando está comentado no fim de `fase3-conferencia-automatica.sql`. Rode no SQL Editor e confirme.
3. (Opcional, negócio) E-mail ao suporte do Klingo (rascunho no Gmail): a pergunta 12 (aviso/webhook quando marcação é criada ou cancelada) dispensaria consultar o relatório a cada 15 s; também confirma que o #7 não traz cancelados.

**Fase 4**
4. No navegador (o merge na `main` já foi feito), conferir: lista com selo de alerta, faixa no cartão, "Histórico do paciente".
5. Validar com um paciente real que volta: data de nascimento → atalho "Repetir o último exame" → exames copiados → plano/unidade → calendário.

**Fase 5**
9. Rodar o SQL `supabase/fase5-aprendizado.sql` (já aplicado no projeto `nrvuynjwcgwpjdptkiay` em 30/10/2026) e conferir na aba Aprendizado, depois da primeira marcação real, se os números fazem sentido. Se o projeto for recriado, rode-o depois do `fase4`.
10. Conferir se a Edge Function está lendo preço: `select count(*), max(atualizado_em) from public.preco_observado;` deve passar de 0 e a data ser de hoje. O relatório só considera leituras das últimas 24 h, então linhas antigas (chave antiga, exame que saiu da agenda) somem sozinhas do painel; se quiser limpar a tabela, `truncate table public.preco_observado;` (pede confirmação humana no Supabase).
11. Usar o relatório: a cada semana, olhar "Exames com mais problema", "Preço x Klingo" e "Casos para melhorar o prompt"; ajustar o prompt no n8n e o catálogo, com a recepção.

**Geral**
6. `admin_redefinir_senha` existia só no banco; agora está em `00-base-snapshot.sql`.
7. Negócio: tempos por modalidade e folgas (15/60 min, 90 min, 48 h, 20 min) são estimativas; preços Particular com confiança média/baixa (validar com a recepção); pedir que as atendentes usem o painel normalmente (o "Agendado" agora é automático, o botão manual continua como reserva).
8. Segurança: o segredo `ia_segredo` está digitado nos nós HTTP do n8n (aviso do n8n "hardcoded credentials"). Ideal: mover para credencial *Header Auth* do n8n (o mesmo padrão da Fila). Advisor Supabase (conferido em 30/10/2026): as funções `security definer` chamáveis por `anon` e por `authenticated` são intencionais (token da conversa, `ia_segredo` ou `papel_atual()`), as 13 tabelas com RLS e sem policy são internas e negam tudo por desenho; **"leaked password protection" no Auth está desligada: ligue** (Supabase > Authentication > Passwords).

**Achados da auditoria de 30/10/2026 (detalhe em `docs/auditoria-2026-10-30.md`, seção 2.4)**
12. **Preços (risco de dado, alto):** 18 de 104 pares exame/operadora com valor do catálogo 10% ou mais diferente do `Previsto` do Klingo. A recepção deve revisar em Aprendizado > "Preço x Klingo" antes de divulgar mais a IA.
13. **n8n (médio):** o nó de IA depende de créditos do *n8n Gateway* e não tem repetição nem workflow de erro. Usar credencial Anthropic própria, `retryOnFail` e um *Error Trigger* que avise a equipe.
14. **`agenda-ocupacao` com 502 (baixo, esperado):** é a proteção contra relatório de agenda vazio, fora do horário de agenda. O cron fica verde mesmo assim, porque só prova que a chamada foi disparada. Ajustar o início do cron ou aceitar como ruído.
15. **Fila:** o que falta para ir ao ar está em `docs/fila-biometria.md`, seção 5.

## 5. Fase 5 — aprendizado com o que corrigem depois da IA (construída)
Arquivo: `supabase/fase5-aprendizado.sql` (aditivo, pode rodar de novo). Mostra no painel, aba **Aprendizado** (só administrador):
- **`ia_evento`** (gatilho em `pre_agendamentos`): linha do tempo de cada pedido: criado, mudança de status (quem mudou: `atendente` ou `sistema`; `automatico` quando a conferência agendou) e cada veredito da conferência (horário ocupado, divergente, não encontrado, sumiu, remarcado). Antes, o alerta sumia quando o atendente resolvia e o histórico se perdia. Guarda exames, plano, unidade e etapa, **nunca dado de paciente**. Falha de registro só vira aviso: não atrapalha o atendimento.
- **Relatório** (`ia_relatorio`): criados, % marcados sozinhos sem nenhum alerta, tempo mediano do "pronto" até agendado, alertas por tipo, em que etapa o paciente desiste, exames com mais problema, ações dos atendentes, conversas assumidas e série por semana.
- **Preços** (`preco_observado`, `ia_precos_divergentes`): a Edge Function v14, ao ler o #7 a cada 10 min (job `agenda-ocupacao`), agrega o `Previsto` por exame e operadora (só o valor mais frequente, mínimo, máximo e amostras; linhas com quantidade > 1 ou com status cancelado são ignoradas; a chave **mantém os números** do nome: "2 incidências" e "3 incidências" são exames diferentes) e o painel compara com o `catalogo_preco` (diferença de 10% ou mais). **Não corrige preço sozinho**: o preço continua sendo previsão e quem decide é a recepção.
- **Casos para o prompt** (`ia_exemplos`): alertas e cancelamentos recentes, sem dado de paciente, com botão "Copiar casos" para ajustar as instruções da IA no n8n. Ao cancelar um pré-agendamento, o painel pergunta o motivo (opcional, **de uma lista fixa**, sem texto livre; `ia_evento_motivo` só aceita o próprio atendente que cancelou, até 10 minutos depois, e o servidor só guarda os motivos da lista: qualquer outro texto vira "Outro motivo").
- Se o gatilho `ia_evento_trg` falhar (ele só emite aviso para não atrapalhar o atendimento), a aba mostra "Atenção: N pedido(s) não aparecem na linha do tempo".
- Ao cancelar, o painel abre uma janela com o motivo numa lista fixa; "Voltar" ou Esc **não cancelam**, "Cancelar pedido" cancela (com ou sem motivo).
- "Casos para o prompt" mostra o caso mais recente de cada pedido e tipo (um alerta que oscila não enche a lista). "Exames com mais problema" conta o pedido inteiro (com vários exames, todos entram).
- O relatório conta só os **pedidos criados depois que o registro começou** (`ia_coorte`), para pedidos antigos, sem histórico, não inflarem os percentuais.
- Testes: `node --experimental-strip-types --test supabase/functions/sync-catalogo-klingo/precos.test.ts` (10) e `conferencia.test.ts` (17).
- Limites conhecidos: o registro começa quando o SQL rodou (nada retroativo); o `Previsto` do #7 foi lido em produção em 30/10/2026 (285 marcações, 147 pares exame/operadora, de R$ 18 a R$ 1.800); `valorEmReais` aceita número e texto em reais; se a tela de preços vier vazia, rode `{"agenda":"ocupacao"}` à mão e veja `precos_erro` na resposta. Se o catálogo tem várias linhas para o mesmo exame e operadora, o comparador usa a mais próxima do valor do Klingo (evita alarme falso, mas pode esconder diferença da linha que a IA usa; o painel diz quantas combinações têm mais de uma linha). Só compara com linhas do catálogo de confiança alta ou média (as que a IA usa) e "Particular" só casa com a operadora exatamente "Particular". O comparador casa exame por nome normalizado (mantendo números) e operadora por nome: planos com nomes diferentes entre o #7 e o catálogo aparecem em "sem referência".
- Ainda não feito (ideias do plano original, só com dados reais): sinônimos aprendidos para a busca de exames, base de perguntas frequentes aprovadas pelo administrador, anonimização de cadastro após 2 anos sem marcação.

## 6. Regras que não podem ser quebradas
- Dados de paciente do Klingo só passam pela **memória** da Edge Function para identificar a conversa; **nunca** são gravados, devolvidos ou logados. `agenda_ocupacao` guarda só início, médico, unidade, procedimento, quantidade.
- Preço é sempre **previsão**; um atendente humano confirma preço e data. A mensagem de confirmação ao paciente não traz preço.
- Detalhes do histórico só depois da data de nascimento conferida. Ao testar `liberado`, use `coalesce(..., false)`: um NULL já virou "verdadeiro" uma vez.
- Lado D/E: na frente o L do desenho é o Direito, nas costas é o Esquerdo; bilateral com lado único é recusado.
- Horários: reserva provisória + advisory lock por dia; folga 15 min (mesma unidade) / 60 min (outra unidade) entre exames do mesmo paciente; antecedência de 120 min. Fuso: `America/Bahia`.
- Dicas do Supabase MCP: `execute_sql` e `apply_migration` pedem confirmação humana se o texto tiver `delete from` ou `drop`; testar em `DO $$ … raise exception … $$` (reverte tudo); alterar função existente via `pg_get_functiondef` + `replace`; um `NULL` em `if not x` não entra no `then`.
- Dados de teste: telefones `7190000xxxx`; os testes das fases 3 e 4 rodaram em transação revertida (não ficou nada no banco).
