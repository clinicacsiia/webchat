# Convênios, regras por convênio e foto do pedido (02/11/2026)

SQL: `supabase/convenios-e-foto.sql` (aplicado no Supabase em 02/11/2026, em 5 partes). Tela: aba **Convênios** do painel (só administrador) e atalho em Configurações.

## O que mudou para a gestão
- **Desativar um convênio inteiro** (botão Desativar/Ativar, com confirmação que mostra o impacto: agendamentos dos últimos 30 dias e conversas em andamento). Convênio desativado some da lista do chat; se o paciente digitar o nome, recebe a mensagem (a do convênio ou a padrão) e escolhe outro, Particular ou o atendente. O Particular nunca é desativado.
- **Regra e mensagem por convênio**, cada um independente (ou a padrão): aviso ao escolher o convênio, mensagem de convênio desativado, e a regra **"a clínica faz só um exame por vez"** (se o pedido tem mais de um exame, o paciente é avisado e o atendente recebe uma nota).
- **Números para decidir** em cada convênio: agendamentos em 30 dias e tendência, previsão para os próximos 30 dias (reta ajustada às 4 últimas semanas completas, limitada a 2x o último mês; aparece "pouco histórico" quando há menos de 4 semanas ou 8 agendamentos), participação no total, último exame e último valor visto, quantos exames têm preço confiável, conversas do chat paradas. Uma frase de sugestão (ex.: "sem agendamentos: vale desativar", "procura caiu 30%").
- **Avisos de mudança** (selo vermelho na aba): preço de convênio ou Particular que mudou, convênio ou plano que entrou ou saiu. Mudança de 10% ou mais, ou algo que saiu, vem em vermelho. Marque "visto" para limpar. Mudanças feitas na própria tela já nascem vistas.
- **Ver preços** de cada convênio: valor no convênio, valor Particular, último valor nas marcações e o que mudou nos últimos 30 dias.

## Limites que você precisa conhecer
- O valor Particular é **deduzido das marcações** (não existe tabela oficial no que o sistema lê); ele oscila. O chat nunca informa preço: só o atendente. Relatórios D e E em `docs/klingo-relatorios-pendentes.md` resolvem isso.
- A previsão é uma tendência simples, não uma garantia. O histórico guardado ainda é curto (começou em setembro/outubro).
- Desativar vale para quem **ainda vai escolher** o convênio. Conversas que já escolheram ficam como estão e aparecem na contagem "em andamento" para o atendente conferir.

## Chat do paciente
- A pergunta do exame começa por **"Você tem o pedido médico?"**: botão da foto primeiro; sem pedido, o paciente monta por **tipo → parte do corpo (esquerdo/direito/dois lados) → exame**, o fluxo da imagem 2. A busca pelo nome ficou só como atalho pequeno.
- A **foto é uma folha separada**: só lê o exame e tenta achá-lo na lista. O que for achado vai para o "Seu pedido até agora", onde o paciente confere, acrescenta outros exames e envia **tudo de uma vez** (`chat_pedido_enviar`: foto, lista montada e texto livre).
- O paciente pode **enviar mais fotos** quando quiser (na própria folha da foto e no primeiro passo do pedido).
- A leitura por IA (`ler-pedido`) **continua sem estar publicada** (falta o segredo `ANTHROPIC_API_KEY` e a revisão LGPD, ver `docs/pendencias-e-dependencias.md`). Sem ela, vale a leitura do celular (Tesseract) e a foto sempre vai ao atendente.

## Atendentes: fotos do pedido
- Na lista: etiqueta **"Anexo: N fotos"** (amarela enquanto faltar conferir no Klingo).
- Na conversa: caixa **"Anexo"** com botão que abre todas as fotos de uma vez, botão que vai à mensagem da foto e a **pendência do Klingo**: conferir se o paciente está cadastrado, se o convênio e a carteirinha estão válidos e se o convênio cobre o exame; depois "Conferi no Klingo".
- Aparece também como "próximo passo" da conversa.

## Para voltar atrás
As tabelas novas (`convenio_config`, `convenio_evento`) podem ficar. Para restaurar o motor do chat, reaplique `supabase/fase7-motor.sql` e `supabase/correcao-convenio-quem-volta.sql`. O site volta ao anterior desfazendo o commit (o `sw.js` troca a versão do cache sozinho).

## Testes
`testes/convenios.navegador.mjs` (painel), `testes/foto-pedido.navegador.mjs` (chat) e, no banco, uma bateria rodada contra o Supabase dentro de uma transação desfeita (convênio desativado não aparece nem é aceito, aviso e regra, pedido unificado, token errado, Particular não desativa).
