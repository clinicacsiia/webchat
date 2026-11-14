# 05 — Pendências (o que NÃO está pronto) e dependências do suporte do Klingo

Versão 2.0 — 14/11/2026 / Mudança: atualizado depois das decisões do dono de 14/11/2026 (pós-agendamento implementado, `klingo-agendamento` preservada, público geral). Nada aqui está marcado como concluído sem implementação **e** teste; "testado" sempre significa **com o Klingo simulado**.

## A. Pendências externas (dependem de resposta ou liberação do suporte do Klingo)

Texto-base do e-mail: `docs/klingo-api-externa/roteiro-reuniao-suporte.md`.

| # | Funcionalidade | Já investigado (documentação e código) | Falta confirmar com o Klingo |
|---|---|---|---|
| E1 | **Webhook** | `klingo-webhook` pronta e **desligada** (comparação do token em tempo constante; evento repetido é ignorado por hash; cancelamento/remarcação avisados agora também atualizam a lista de marcações do chat; testado no banco). **Autenticação lida no código, sem teste automático** (a função usa `Deno.serve` direto). | Cadastrar `https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/klingo-webhook` com o `X-APP-TOKEN`; se o evento traz **id, hora ou assinatura** (hoje não traz: dois cancelamentos iguais da mesma marcação em sequência parecem repetidos; as rotinas de conferência continuam ligadas para isso). |
| E2 | **Resultado de exame** | A documentação (`GUIA-COMPLETO.md` 2.6) lista `GET /resultado/{id_marcacao}` (devolve `pronto` e `status`; o laudo vem como arquivo, **não existe link nem senha**). Sem laudo a API responde **403 em HTML** (provado). Implementado: **só conferir se o laudo está liberado** (nunca o conteúdo), atrás da chave `klingo_api_resultado` (padrão `nao`). | (a) Se o formato de `pronto` para laudo liberado é o esperado (**nunca testado com laudo liberado real**). (b) Como entregar o acesso ao paciente (link/senha) sem expor o laudo no chat; hoje a equipe envia. (c) Validação do responsável quando o exame é de menor. |
| E3 | **Remarcação atômica** | Provado (13/11): `POST /agenda/horario` com `remarcacao` devolve o voucher novo e **cancela o antigo sozinho**. A nova versão **confere o antigo depois** (ativo = duplicidade, cancelado = ok, incerto = equipe). | Garantia do lado deles quando a marcação nova falha depois do aceite, e se existe janela com duas marcações ativas. |
| E4 | **Conciliação de operação incerta** | O executor reconcilia por `GET /vouchers` (campo `id_externo`, provado que fica gravado no voucher). | Confirmar que `id_externo` volta **sempre** em `/vouchers`. |
| E5 | **Limite de chamadas** | Cota global do banco (10 fichas, 1/s) e tratamento de 429. | Limite real por minuto, para dimensionar o motor de vagas. |
| E6 | **Catálogo da API** | Só 3 especialidades liberadas (neurologia, pediatria, radiologia). | Liberar as demais e o plano da ASSEFAZ; agenda de teste. |
| E7 | **Preço Particular, convênio inativado, hora real do atendimento** | `docs/pendencias-do-dono.md` 2.3. | Respostas do suporte. |
| E8 | **"Ver minhas marcações" inclui o que foi marcado no balcão?** | `GET /vouchers` lista as marcações **ativas do paciente** (documentação e testes de 13/11, feitos com marcações criadas pela API). | Confirmar que marcações criadas pela recepção aparecem na mesma lista. Se não aparecerem, o chat mostra só o que o Klingo devolve e **não afirma** que é tudo. |
| E9 | **WhatsApp** | Procurei integração de mensagens reaproveitável no projeto: **não existe** (o n8n foi removido; o "Chamar no WhatsApp" é um link manual da equipe). Nada é simulado. | Escolher o provedor oficial (API do WhatsApp Business), validar base legal e modelos de mensagem. Enquanto isso o aviso de vaga é só no chat, e a equipe vê no painel (Disponibilidade futura) os avisos pendentes e as solicitações que "precisam de pessoa". |

Relatórios do Klingo a criar/editar para esta tarefa: **nenhum** (regra do `CLAUDE.md`).

## B. Pendências do projeto

### Bloqueantes (antes de publicar)

| # | Item | Por quê |
|---|---|---|
| B1 | **Sua autorização** para aplicar as migrações e publicar as Edge Functions e a tela, na ordem de `06-plano-de-publicacao.md` | Nada foi publicado. A publicação tem uma janela em que o público fica sem marcação automática (ver o aviso no plano). |
| B2 | **Validação com o Klingo real** (paciente e agenda de teste): marcar, cancelar, remarcar, ver marcações, conferir o voucher antigo | **Todos os testes usam Klingo simulado.** O motor de marcação nunca criou uma operação real (0 em `klingo_operacao`). |
| B3 | **Decidir o histórico do telefone na `main`** | Ver `08-limpeza-do-telefone-no-github.md`: limpei a minha branch; o mesmo número já estava na `main` desde 10/11. |
| B4 | **Aplicar o SQL de segurança e publicar a `klingo-agendamento` v1.1** (ou deixar como está, sabendo do risco do §5 de `07-auditoria-klingo-agendamento.md`) | A função **continua como estava** na produção. |

### Importantes

| # | Item |
|---|---|
| I1 | Tela para o administrador chamar `klingo_promover` (hoje só SQL). O painel já edita cada chave (e a trilha `config_auditoria` registra), mas sem a justificativa obrigatória. |
| I2 | Estados em colunas próprias ("dependente de equipe" no pedido, "conciliada" na operação): continuam combinações de campos (ver `02-arquitetura-e-estados.md`). |
| I3 | **Segundo fator** (SMS/e-mail) para ações que escrevem, no chat e na `klingo-agendamento` (`07`, §5). |
| I4 | Rate limit **por IP nas funções do chat** (`chat-agenda-api` é limitada por token e cota global; a `klingo-agendamento` já tem limite por IP). |
| I5 | Mais de um exame na solicitação futura e na marcação automática: segue para a equipe com mensagem clara. |
| I6 | Remarcar **marcação feita no balcão** pelo chat (hoje vai para a equipe porque não sabemos serviço e convênio): exigiria mapear o procedimento do voucher no catálogo e perguntar o convênio. |
| I7 | Reescrever o teste legado `sql-klingo-auto.test.mjs` (aposentado: 21 de 73 verificações assumem o fluxo de 12/11). O comportamento dele (marcação, divergência, voltar) está coberto pelos testes novos de pipeline e continua na produção. |
| I8 | Comparar linha a linha as demais Edge Functions publicadas × repositório (só `chat-agenda-api` e `klingo-agendamento` foram comparadas). |
| I9 | `privacidade.html`: citar solicitação de disponibilidade, consulta de marcações, finalidade, base legal, retenção (`config_auditoria` 1 ano; `klingo_consulta` 30 dias; `klingo_marcacao` 7 dias; `klingo_agendamento_evento` 30 dias; solicitações encerradas: definir) e opt-out. Revisão jurídica. |
| I10 | Notificação por WhatsApp/SMS/e-mail (item E9). |
| I11 | A `chat-agenda-ao-vivo` (leitura de ocupação por relatório) **não é mais chamada pelo chat**; fica publicada sem uso. Pode ser apagada depois da publicação. |
| I12 | (resolvido em 14/11: o texto do painel sobre o interruptor geral foi reescrito). |

### Melhorias futuras

* Painel de saúde do motor de vagas (taxa de oportunidade → aceite → conversão).
* Indicador "tem solicitação futura ativa" no cartão do pedido.
* Regressão visual automatizada; acessibilidade dos formulários novos revisada com leitor de tela.
* Reconhecer marcação cancelada **pelo balcão** durante uma conversa aberta (hoje só ao consultar de novo ou pelo webhook, quando existir).

## C. Limitações conhecidas desta entrega

1. **Tudo que "vem do Klingo" nos testes é simulado.** O que fica sem prova real: formato de `GET /vouchers` para marcações do balcão (E8), laudo liberado (E2), remarcação com falha parcial (E3), resposta perdida em cada rota.
2. `previsao_ativa` devolve sempre `false`: o assistente antigo da "lista de espera" deixa de existir; a tabela `pedido_previsao` e suas funções ficam sem uso (0 linhas).
3. Janela de datas: a API devolve ≤ 15 dias por consulta; a tela soma até 3 janelas (≈ 45 dias) sob demanda. A lista de médicos mostra "Sem horário disponível nos próximos 15 dias" (a janela consultada).
4. Gêmeos com o mesmo responsável, nascimento e nome se confundem na chave da solicitação futura.
5. A reescrita do histórico limpou **só a minha branch**; o GitHub ainda guarda commits antigos por SHA e há cópias fora do meu alcance (`08`).
6. `pytest` foi instalado **só no ambiente de teste desta sessão** (`pip install pytest`); nenhum arquivo de dependência do projeto foi alterado. Quem rodar os testes em outra máquina precisa do mesmo `pip install pytest`.
