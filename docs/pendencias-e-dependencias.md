# Pendências e dependências (01/11/2026)

Lista única do que falta, na ordem em que as coisas dependem umas das outras. Reúne o `LEIAME.md`, os documentos em `docs/`, os resumos das sessões anteriores e uma conferência feita no banco real em 01/11/2026.

Legenda de quem faz: **[Claude]** faz aqui no webchat (código, SQL, n8n, Edge Function pelos conectores); **[Você]** só você consegue (painéis do Supabase/n8n, decisões, chaves, testes com pessoas); **[Terceiro]** jurídico ou Klingo.

## 1. Validação do que já foi feito

| Verificação | Resultado |
|---|---|
| Branch de trabalho x `origin/main` | Idênticos (`08f2b49`, PR #35). Nada fica sem mesclar. |
| Testes automáticos (`npm test` em `testes/`) | **Todos passam**: Edge, Python, SQL (Fila, delta, fase 9, convênio, assuntos, contas, proteção, login, meus dados), service worker, Sentinela, nomes de exame, e os navegadores (4 + 4 + 7 + 19 + 23 verificações). |
| Para rodar neste ambiente | `pip install pytest` e `CHROMIUM_PATH=/opt/pw-browsers/chromium` (o Playwright do `npm install` pede outra versão do navegador). |
| Banco real (`webchat-atendimento`) | `login_paciente = sim`, `cadastro_equipe_sem_convite = nao`, `motor = fluxo`; funções `conta_paciente_meus_dados`, `conta_paciente_excluir` e `conta_paciente_vincular` existem; 1 conta de paciente e 2 cadastros; 7 rotinas agendadas (catálogo, preços, agenda, fluxo de exames). |
| Limite da validação | Testes rodam em banco e navegador **simulados**. Nada disso substitui o teste real do passo 3. |

### Divergências achadas (precisam de decisão)

1. **Módulo "Jornada" está no banco, mas não no repositório.** Há 9 migrações `jornada_01` a `jornada_09` (01/11, 04:19 a 04:33 UTC), tabelas `jornada_*`, `vinculo_solicitacoes`, a Edge Function `sync-jornada-klingo` (v3), o cron `fluxo-exames` e chaves `jornada_*` em `config`. Não há SQL, código nem documento dele aqui. Sem isso o banco não é reproduzível e o trabalho se perde se o projeto for refeito. Parece ser a sessão paralela de hoje; não consegui ler o histórico dela.
2. **`ler-pedido` não está publicada** (o Supabase só lista `sync-catalogo-klingo` e `sync-jornada-klingo`). O chat funciona só com a leitura do celular.
3. **Avisos do Supabase (segurança):** proteção contra senha vazada desligada; funções com `SECURITY DEFINER` executáveis por `anon` e `authenticated` (conferir se são só as que precisam ser públicas); uma tabela com RLS ligado e sem política (informativo).

## 2. Lista de dependências, em ordem

Cada item só começa quando os listados em "Depende de" estiverem prontos.

### Trilha A: abrir o login ao público

| # | Item | Quem | Depende de |
|---|---|---|---|
| A1 | Trocar o texto dos modelos "Confirm signup" e "Reset password" por algo genérico da clínica (Supabase > Authentication > Email Templates; base em `supabase-emails/confirmar-cadastro.html`) | Você | nada |
| A2 | Conferir Site URL e Redirect URLs do Supabase para o endereço do chat e do painel (evita link do e-mail dando 404) | Você | nada |
| A3 | **Teste real ponta a ponta com conta de verdade**: criar conta, confirmar e-mail, entrar, ver Meus dados, baixar a cópia, apagar a conta. A exclusão apaga de `auth.users` e só foi testada em banco simulado | Você (Claude confere o banco depois) | A1, A2 |
| A4 | **Novo desenho de cadastro, sem tela de login separada**: nome, telefone e e-mail; comparar com `pacientes`; ligar a conta ao cadastro existente; paciente escolhe a senha e confirma com a data de nascimento | Claude | decisão sua sobre o desenho final |
| A5 | Vincular à conta um cadastro antigo (recepção valida a identidade e faz o vínculo; a tabela `vinculo_solicitacoes` já existe no banco) | Claude | A4 |
| A6 | Filhos ligados ao responsável (dependentes na conta). Hoje o cadastro da criança é digitado a cada vez | Claude | A4 |
| A7 | Limite de tentativas e bloqueio por conta (hoje valem só os limites do Supabase Auth por IP) | Claude | A4 |
| A8 | Revisão jurídica: texto da tela "Meus dados", lista do que continua guardado, aviso de privacidade, prazo de retenção (inclui foto do pedido, dado de saúde enviado a provedor de IA) | Terceiro | nada (começa já) |
| A9 | **Decidir abrir o login ao público** | Você | A3, A4, A8 |

### Trilha B: leitura do pedido médico (Fase 8)

| # | Item | Quem | Depende de |
|---|---|---|---|
| B1 | Criar o secret `ANTHROPIC_API_KEY` no Supabase (painel; não cole a chave na conversa) | Você | nada |
| B2 | Publicar `supabase/functions/ler-pedido` sem JWT e testar com uma foto de pedido | Claude | B1 |
| B3 | Aviso de privacidade e retenção das fotos antes de divulgar | Terceiro | A8 |

### Trilha C: segurança e limpeza antes de divulgar

| # | Item | Quem | Depende de |
|---|---|---|---|
| C1 | Ligar proteção contra senha vazada (Authentication > Passwords). Pode exigir plano Pro; o projeto está no Free | Você | nada |
| C2 | Revisar os avisos de `SECURITY DEFINER` e fechar o que não precisa ser público | Claude | nada |
| C3 | Limpar os contatos de teste (telefones `7190000xxxx`; há 2 hoje) | Claude, com sua confirmação | todos os testes feitos |
| C4 | Executar o roteiro de 16 testes da Fase 6 (`docs/fase6-roteiro-de-teste-e-producao.md`), que nunca foi executado | Você | nada |
| C5 | Confirmar a publicação do GitHub Pages depois de cada merge e testar no celular | Você | merge |
| C6 | Aviso à equipe fora do painel (WhatsApp ou e-mail) quando chegar conversa nova; hoje depende de alguém com o painel aberto | Claude (n8n) | credencial SMTP do n8n (D2) |

### Trilha D: Fila em tempo real + assinatura biométrica (detalhe em `docs/fila-biometria.md`)

| # | Item | Quem | Depende de |
|---|---|---|---|
| D1 | Aplicar `supabase/fila-biometria-v2-delta.sql` no SQL Editor (tem `drop function`, exige confirmação humana) | Você | nada |
| D2 | Criar no n8n a credencial Header Auth `Fila - segredo` e a credencial SMTP | Você | D1 |
| D3 | Montar e publicar os dois workflows do n8n ("emitir link" e "validar assinatura") | Claude | D2 |
| D4 | Escrever a tela `fila/` e a aba "Fila" do painel | Claude | D1 |
| D5 | Preencher `config.fila_webhook_url` | Você | D3 |
| D6 | Teste ponta a ponta com paciente de teste | Você | D3, D4, D5 |
| D7 | LGPD da biometria (consentimento, retenção, RIPD) e recalibrar o limiar 0,30 | Você e jurídico | D6, antes de paciente real |
| D8 | Decidir o merge do PR #15 | Você | D6 |

### Trilha E: Klingo e catálogo

| # | Item | Quem | Depende de |
|---|---|---|---|
| E1 | Pedir ao suporte do Klingo (`docs/fase-0-email-suporte-klingo.md`): `baseUrl`, login e senha de integração da API de marcação, busca por CPF, valor e preparo, ambiente de testes | Você | nada |
| E2 | Ligar a consulta de horários livres e o cadastro do paciente no Klingo, mantendo a marcação com o humano | Claude | E1 |
| E3 | Corrigir no Klingo os 18 de 104 pares exame/operadora com preço 10% ou mais diferente do catálogo | Você | nada |
| E4 | Limpar o catálogo no Klingo (aba Catálogo do painel mostra o que limpar) | Você | nada |
| E5 | Validar a conferência automática (Fase 3) com uma marcação real | Você | nada |

### Trilha F: melhorias já decididas, sem urgência

| # | Item | Quem | Depende de |
|---|---|---|---|
| F1 | Mudar escolhas ao vivo com caixas de marcar; mapa de dependências no banco (`fluxo_dependencia`) (`docs/lembrete-mudar-escolhas-e-convenio.md`) | Claude | nada |
| F2 | Testar com 3 a 5 pessoas de 70 anos ou mais antes de liberar para todos | Você | F1 |
| F3 | Validade vencida da carteirinha (opcional) | Claude | F1 |
| F4 | Guardar laudos para "resultado de exame" (hoje só mostra a orientação cadastrada) | Claude | decisão sua e A8 |
| F5 | Nó de IA do n8n sem repetição nem fluxo de erro. Só importa se `config.motor` voltar para `ia` | Claude | só se voltar |
| F6 | Ideias com dado real: sinônimos aprendidos, base de perguntas frequentes, anonimização após 2 anos sem marcação | Claude | dados acumulados |

### Trilha G: higiene do repositório

| # | Item | Quem | Depende de |
|---|---|---|---|
| G1 | **Versionar o quadro** (SQL das 9 migrações `jornada_01` a `jornada_09`, chaves de `config`). **Parcial em 01/11/2026:** a Edge Function `sync-jornada-klingo` e a migração `jornada_10` (monitor de 1 minuto e cron) já estão no repositório; faltam as 9 primeiras. O quadro entrou no painel em 01/11/2026 como função do Atendimento (`docs/quadro-nas-conversas.md`); o SQL e a função ainda existem só no Supabase | Claude | confirmar que a outra sessão terminou |
| G3 | (**decisão mudou em 01/11/2026**: você pediu monitorar o paciente a cada minuto; ver `docs/jornada-monitoramento.md`) Klingo só para o que importa: atualizar status de quem tem conversa e dos agendamentos de hoje, sem carregar o relatório inteiro; decidir se se apaga o que já foi carregado (2.704 cartões) | Claude, com sua confirmação para apagar | G1 |
| G2 | Registrar no `LEIAME.md` o estado do que for sendo concluído | Claude | cada item |

## 3. Por onde começar

1. **Agora, em paralelo e sem dependência:** A1, A2, A8, B1, C1, D1 e E1 são seus; G1 e C2 são meus.
2. **Primeiro bloqueio real:** A3 (teste com conta de verdade), porque valida o que já foi mesclado e libera A9.
3. **Primeira entrega minha de maior valor:** A4, depois A5 e A6. Preciso da sua decisão sobre o desenho do cadastro (a descrição está no `LEIAME.md`, seção PENDENTE).
