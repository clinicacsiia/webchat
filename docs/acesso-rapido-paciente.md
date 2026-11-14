# Acesso rápido do paciente (celular + PIN de 4 dígitos)

Versão 1.0 — 14/11/2026 / Mudança: Implementação inicial (primeira versão guardava tudo só no celular; esta liga ao Supabase)

**Página:** `acesso/index.html` (`https://clinicacsiia.github.io/webchat/acesso/`, ainda sem link em nenhuma outra tela). **Banco:** `supabase/acesso-rapido-paciente.sql`. **Testes:** `npm run test:acesso-sql` (57 casos) e `npm run test:acesso` (33 casos, a página real num Chromium falando com o banco de teste).

## O que a pessoa vê
1. **Primeiro acesso:** celular com DDD (vira o login) → nome completo e nascimento (maior de 18) → "Tem filhos?" (um ou vários) → número de confiança (opcional) → cria e confirma o PIN.
2. **Depois:** o app abre direto no PIN. Tela inicial com **Eu**, cada filho e **Todos juntos** (a última escolha fica lembrada). **Nova marcação** cria uma solicitação para cada pessoa escolhida.
3. **Meus dados:** adicionar/remover filho **a qualquer momento**, números de confiança (com código), trocar PIN, sair deste aparelho.
4. **Trocou de celular:** "Já tenho cadastro" → celular + PIN. **Esqueceu o PIN:** celular + nome + nascimento.
5. PIN errado 5 vezes bloqueia 1 minuto; fica mais de 5 minutos em segundo plano, pede o PIN de novo.

## Onde fica cada coisa
| O quê | Onde |
|---|---|
| Titular, PIN (bcrypt), tentativas | `app_paciente` |
| Aparelhos (só o hash do código) | `app_aparelho` |
| Filhos (remover só marca `removido_em`) | `app_filho` |
| Números de confiança e o código de 6 dígitos | `app_contato_confianca` |
| Solicitações (uma linha por pessoa, mesmo `grupo`) | `app_marcacao` |
| Registro sem dado pessoal (cadastro, PIN trocado, bloqueio…) | `app_evento` |

Todas as tabelas têm RLS ligada **sem nenhuma regra** e o público não tem permissão de tabela: só as funções `app_*` (paciente, com a chave pública) e `painel_app_*` (equipe logada) leem e gravam. O celular guarda só `{código do aparelho, primeiro nome}`.

## Decisões de segurança (e por quê)
- **PIN conferido no servidor.** Quatro dígitos são 10 mil combinações: o bloqueio **cresce** (1 min nos primeiros 5 erros, 15 min nos 5 seguintes, depois 1 h a cada 5) e só um acerto zera. Vale para entrar, desbloquear, trocar o PIN e "esqueci". *(Pedido original: 1 minuto fixo. Subi porque 1 minuto fixo permite testar os 10 mil PINs em cerca de 33 horas.)*
- **O servidor também cobra o PIN:** depois de 30 minutos sem uso, qualquer função devolve "bloqueado" e a página mostra o teclado. A trava de 5 minutos em segundo plano continua, na tela.
- **Número de confiança com código.** O celular **não é confirmado por SMS**. Se bastasse cadastrar o mesmo celular, qualquer pessoa que se cadastrasse antes com o número de outra veria os filhos de quem a listou. Por isso o titular recebe um código de 6 dígitos por contato e o passa à pessoa (WhatsApp ou voz); ela digita em *Meus dados > Tenho um código*. 5 erros invalidam o código; o titular gera outro. Quem acompanha só **lê**.
- **"Esqueci o PIN" (celular + nome + nascimento) é o elo mais fraco:** família e dados vazados conhecem os três. Por isso conta nas mesmas tentativas, derruba os outros aparelhos e grava `pin_redefinido` em `app_evento`. O ideal é trocar por código SMS (pendência já existente: segundo fator).
- **Cadastro em massa:** limite por hora (`config.app_cadastros_max_hora`, 100). Celular já cadastrado responde "entre com o seu PIN" (isso revela que o número tem cadastro; aceito para este fluxo).

## Ligação com a base da clínica (o antigo `validarNaBase`)
Feita **só dentro do banco**, só como **sugestão**: se existir um único paciente em `public.pacientes` com o mesmo celular, nascimento e nome, grava `app_paciente.paciente_sugerido_id`. Nunca vincula sozinho (mesma regra de `contas_paciente`), não impede cadastro e nada disso volta para a tela. A equipe vê `cadastro_sugerido` em `painel_app_solicitacoes`. **Klingo/relatórios:** não foi ligado e nenhum relatório novo é necessário para esta etapa.

## Equipe
- `select public.painel_app_solicitacoes('solicitada');` lista as solicitações (responsável, celular, pessoas com nascimento, exame, data, turno, observação). Só administrador e atendente.
- `select public.painel_app_solicitacao_status('<grupo>', 'confirmada');` muda a situação (`confirmada`, `concluida`, `cancelada`, `solicitada`); o paciente vê "Confirmada pela clínica".
- **Ainda não há botão no painel** para isso. A página diz só "Solicitação registrada… para agilizar, envie o resumo ao atendimento", sem prometer que alguém já viu.

## Ligar e desligar
Nasce **desligado**. Ligar: `update public.config set valor = 'sim' where chave = 'app_acesso_modo';` Desligar na hora (derruba também quem já está dentro, que passa a ver "ainda não disponível"): `... valor = 'nao' ...`.

## Voltar atrás
Comandos no cabeçalho de `supabase/acesso-rapido-paciente.sql` (apagam só objetos `app_*` e as duas chaves de config).

## Ainda não existe
- Código por SMS (confirmar o celular de verdade, número de confiança sem passar código, "esqueci" mais forte).
- Tela da equipe para as solicitações (hoje só as duas funções acima).
- Agendar de verdade (a solicitação não cria marcação no Klingo).
- Aviso (push) ao paciente quando a clínica confirma.
- Texto de privacidade citando o acesso rápido, dados de crianças e o prazo de guarda (jurídico, item 2.5 de `pendencias-do-dono.md`).
