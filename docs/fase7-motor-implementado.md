# Fase 7 no ar: motor de atendimento sem IA (o que foi feito, como testar e como voltar atrás)

Data: 31/10/2026. Plano e mapa do processo em `docs/plano-fase7-fluxo-sem-ia.md`. SQL em `supabase/fase7-motor.sql` (**aplicado no projeto** `webchat-atendimento` em 31/10/2026, em partes, pelo MCP).

## 1. Resumo

O paciente é respondido por um **motor de regras dentro do Supabase**, na mesma chamada que grava a mensagem. Nenhuma mensagem passa pela IA nem pelo n8n.

| Medida (testes no banco real, 31/10/2026) | Tempo |
|---|---|
| Servidor, por passo (motivo, plano, dados, confirmação) | 3 a 27 ms |
| Busca de exame pelo nome | 6 a 22 ms |
| Leitura do pedido médico (texto do OCR, várias linhas) | 37 ms |
| Calendário (cálculo de horários livres, que já existia) | 190 a 850 ms |
| Tela do chat: toque → próxima pergunta desenhada (com 150 ms simulados de rede) | 250 a 290 ms |

O tempo que cada paciente vê fica gravado em `fluxo_evento.ms_cliente`, e o do servidor em `fluxo_evento.ms`. Antes, com a IA, a mediana era 7,1 s.

## 2. Decisões da equipe (31/10/2026) e como ficaram

| Decisão | Como ficou |
|---|---|
| Tirar a escolha de unidade; perguntar só se é **adulto ou responsável** | O formulário pergunta "Para mim" ou "Para meu filho(a)". A unidade é pré-configurada: **consulta de criança vai para a Desenvoar** (pediatria) e **consulta de adulto vai para a CSI** (pelo campo `unidade_config.fluxo`). Para exame, o calendário mostra todas as unidades que fazem aquele exame. O médico de preferência saiu do formulário e virou um passo depois da consulta, mas só quando há mais de um médico para ela |
| **Só botões** | O campo de texto fica escondido enquanto o assistente atende. Ele aparece quando a pergunta pede texto ("Outro assunto"), quando a conversa vai para a equipe ou quando o paciente toca em "Meu convênio não está na lista" |
| Se não entender, **avisar que vai informar o atendente** | "Não entendi, mas vou informar isso ao atendente. Para continuar, toque numa das opções." O texto vai para as observações do resumo da equipe, e o paciente não é transferido |
| **Listas com filtro que se preenche sozinho** | Listas longas (convênios, especialidades) têm um campo "Digite para procurar" que estreita a lista a cada letra. Com um só resultado, ele fica destacado e o Enter escolhe |
| **Dados um grupo por mensagem**, fácil para idosos | São quatro grupos (identificação, contato, endereço, carteirinha), com campos grandes e máscaras. O CPF é conferido no celular e o CEP preenche rua, bairro, cidade e UF. Os campos que não são obrigatórios aparecem como "(se souber)", e endereço e carteirinha podem ser deixados para depois |
| **OCR do pedido médico, sem bloquear** | "Tirar foto do pedido médico" lê o texto no próprio celular (Tesseract, em português), procura os exames no catálogo e já marca o lado quando o pedido diz. A foto vai sempre para o atendente, mesmo quando a leitura falha. A busca pelo nome e o desenho do corpo continuam disponíveis |
| Sem horário fixo; **contador ao vivo** e aviso de equipe fora do ar | Depois de enviar, o paciente vê um cartão "Aguardando a confirmação do atendente" com um relógio (00:05:12) que conta ao vivo, e "✓ Agendamento confirmado" quando a equipe marca como agendado. "Equipe online" quer dizer que alguém está com o painel aberto (sinal a cada minuto, `agentes.visto_em`). Sem ninguém: "No momento não estamos online, mas a sua solicitação está registrada…" |
| WhatsApp e e-mail para **a mesma página**, entrando **pelo cache** | O chat guarda a conversa, o perfil e as últimas 80 mensagens no aparelho. Pelo link, a conversa e o contador aparecem na hora. "Fazer um novo pedido" mostra "Olá de novo, {nome}!" e pede só para quem é. "Sair (não sou eu)" apaga tudo do aparelho. O `sw.js` agora abre a página guardada na hora e atualiza por trás |

## 3. Peças novas

**Banco** (`supabase/fase7-motor.sql`)

- `conversas.motor` (`ia` | `fluxo`): definido quando a conversa nasce, por `config.motor` ou pela lista `config.motor_telefones_teste`. O irmão herda o motor da conversa de origem.
- `conversa_fluxo`: o passo e o que o motor já sabe de cada conversa (flags dos grupos, notas para o atendente).
- `fluxo_evento`: uma linha por mensagem tratada pelo motor (passo, se entendeu, tempo).
- `fluxo_texto`: os textos do assistente; o administrador edita sem programação.
- `conversa_anexo`: a foto do pedido e o texto lido dela.
- `fluxo_exames`: lista pronta dos exames com agenda vigente, atualizada pelo cron `fluxo-exames` às 03:40 (Brasília).
- O motor: gatilho `mensagens_motor_fluxo`, que chama `fluxo_avancar`. Funções internas: `fluxo_proximo`, `fluxo_perguntar`, `fluxo_aplicar`, `fluxo_ler_texto`, `fluxo_transferir`, `fluxo_finalizar` e `fluxo_resumo`.
- Chat: `chat_responder`, `chat_exames_buscar`, `chat_exames_salvar`, `chat_anexo_enviar` e `chat_acompanhar`. `chat_iniciar`, `chat_enviar` e `chat_listar` passam a devolver a resposta do motor na mesma chamada.
- Painel: `painel_presenca`, `painel_anexo` e `fluxo_relatorio` (passos, tempos e não entendidos; a tela vem depois).
- A IA antiga não fala em conversa do motor: `avisar_n8n_mensagem`, `ia_responder` e `ia_responder_v2` checam `motor = 'ia'`.

**O que o motor reaproveita:** gravação e conferência de identidade (`ia_pre_agendar`, `paciente_conferir`), o atalho de quem volta (`pre_reaproveitar`), o mapa do corpo, as consultas, o calendário com reservas provisórias, a conferência com o Klingo (Fase 3) e o alerta de preço só para a equipe (Fase 6b).

**Regras que valem em qualquer passo:**

- Emergência descrita → orientação do 192 e transferência com urgência alta.
- "Quero falar com um atendente" (escrito ou pelo menu) → transferência.
- Pergunta de preço ou pedido de orientação clínica → resposta fixa, e a pergunta é repetida.

**Chat** (`index.html`): componentes `escolha`, `campos`, `busca_exame` (com foto e OCR), `texto`, `acompanhar` e `nova`. O menu ganhou "Falar com um atendente" e "Sair (não sou eu)".

**Painel** (`painel/index.html`):

- Sinal de presença a cada minuto, que define se a equipe está online.
- Botão "Ver foto do pedido médico" na conversa, com o texto lido.
- Rótulo "Assistente automático" nas conversas atendidas pelo motor.

## 4. Testes feitos

1. **Banco real, em transações desfeitas no final** (nada ficou gravado). Cenários testados:
   - Adulto com exame: busca, lado, plano, calendário, dados e confirmação, até o pedido pronto.
   - Responsável com consulta de pediatria: médico, convênio digitado ("tenho bradesco saude" → Bradesco Saúde), dados com erro (o motor aponta cada campo) e correção do plano e do pedido.
   - Paciente que volta: data de nascimento, "Repetir o último exame" e "dados continuam os mesmos". A leitura final não mostra o cadastro guardado.
   - Outro assunto (remarcar) e emergência ("dor forte no peito e falta de ar" → 192 e urgência alta).
   - Pergunta de preço, texto sem sentido e resposta a uma pergunta já respondida (recusada).
   - Resultado: nenhum erro do motor (`fluxo_evento` com `passo = 'erro'` vazio).
2. **Tela do chat no Chromium (390 × 844)**:
   - O que foi testado: formulário sem unidade, só botões, filtro do plano, máscaras, CPF recusado no celular, CEP preenchendo o endereço, contador ao vivo, campo de texto aparecendo depois da transferência, reabrir pelo link já dentro da conversa e "Olá de novo" sem formulário.
   - O OCR rodou de verdade: leu "RNM DO JOELHO ESQUERDO" de uma imagem.
   - Limite: este ambiente não alcança `supabase.co`, `cdn.jsdelivr.net` nem `viacep.com.br`. Por isso as respostas do servidor nesse teste foram as que o motor real devolveu no teste 1, gravadas, e as bibliotecas vieram do npm. A ligação chat ↔ Supabase em produção precisa ser conferida no celular (seção 5).

## 5. Ligar, conferir e voltar atrás

- **Testar só com um telefone**: `update config set valor = '71900000077' where chave = 'motor_telefones_teste';` (vários telefones separados por vírgula).
- **Ligar para todos**: `update config set valor = 'fluxo' where chave = 'motor';`. Só conversas novas usam o motor; as que já estão com a IA terminam com ela.
- **Voltar para a IA**: `update config set valor = 'ia' where chave = 'motor';`. O fluxo `Triagem IA - Atendimento` do n8n continua publicado justamente para isso; despublique quando o motor estiver firme.
- **Conferir no celular** (depois do Pages publicar):
  1. Abrir o chat e fazer um pedido de exame até "Pronto".
  2. Ver no painel o resumo e a conversa em Aguardando.
  3. Abrir o link de novo: a conversa e o contador aparecem sem formulário.
  4. Marcar o pré-agendamento como agendado no painel e ver o cartão virar "Agendamento confirmado".
- **Tempos**: `select passo, entrada, round(ms) as ms_servidor, ms_cliente from fluxo_evento order by id desc limit 50;`

## 6. O que ainda falta

- **Avisos por WhatsApp e e-mail** (à equipe a cada transferência e ao paciente). O banco já manda o evento `transferencia` para o n8n, mas faltam o número na API oficial do WhatsApp, a credencial de e-mail e o código pessoal no link (`?c=`) para quem abre noutro aparelho.
- **Aba Fluxo no painel**: funil, tempos, não entendidos e edição dos textos. A função `fluxo_relatorio` já existe.
- **Revisão diária pela IA** (bastidores): ler os não entendidos e propor sinônimos e botões para o administrador aprovar.
- **Rede deste ambiente de desenvolvimento**: para os próximos testes de ponta a ponta rodarem daqui, liberar `nrvuynjwcgwpjdptkiay.supabase.co`, `cdn.jsdelivr.net` e `viacep.com.br` em Network access do ambiente.
