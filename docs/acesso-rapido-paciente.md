# Acesso rápido do paciente (celular + PIN de 4 dígitos)

Versão 1.2 — 15/11/2026 / Mudança: contas antigas (e-mail e senha) viram acesso rápido, uma forma de login só. Versão 1.1 — 15/11/2026 / Mudança: acesso rápido dentro do chat real (CPF e nascimento perguntados uma vez só). Versão 1.0 — 14/11/2026 / Mudança: Implementação inicial (primeira versão guardava tudo só no celular; esta liga ao Supabase)

**Página:** `acesso/index.html` (`https://clinicacsiia.github.io/webchat/acesso/`, ainda sem link em nenhuma outra tela). **Banco:** `supabase/acesso-rapido-paciente.sql`. **Testes:** `npm run test:acesso-sql` (57), `npm run test:acesso` (36, a página `/acesso/` num Chromium falando com o banco de teste), `npm run test:acesso-chat-sql` (20, motor real do chat) e `npm run test:acesso-chat` (12, o `index.html` real do chat num Chromium falando com o motor real).

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

## No chat real: o fim do "CPF e data de nascimento toda hora" (15/11/2026)
**Causa:** o motor do chat trata CPF + nascimento como a **primeira pergunta de toda conversa nova** (`cpf_nasc`, em `fluxo_proximo`), e ainda pode pedir o CPF de novo (`cpf_confirma`, paciente que o chat já conhecia) e o nascimento (`identidade`). Nada guardava isso entre conversas, e cada filho também era perguntado de novo.

**O que muda para quem tem acesso rápido** (`supabase/acesso-rapido-chat.sql` + `index.html`, tudo atrás de `app_acesso_modo`):
1. Tela inicial do chat: faixa "⚡ Acesso rápido: Ana" (ou "Digitar PIN", com o teclado dentro do próprio chat). Nome e celular vêm do cadastro.
2. "Para quem é o atendimento?" vira **Para mim / Para <filho> / Todos os filhos**, reaproveitando o que o chat já tem (filho e irmãos "juntos" ou "um de cada vez").
3. Na **1ª** conversa de cada pessoa o chat pergunta CPF e nascimento como sempre; o banco **guarda o CPF** (`app_paciente.cpf` / `app_filho.cpf`) e o e-mail digitados.
4. Da **2ª** em diante, quando o motor mostra `cpf_nasc`, `cpf_confirma` ou `identidade`, a página chama `app_chat_dados`, que responde **pelo mesmo caminho do chat** (`chat_responder`), então o motor, o Klingo e os avisos se comportam como se a pessoa tivesse digitado. Na conversa aparece só "Usei os dados salvos no meu acesso rápido." (sem o CPF).
5. Nenhuma função do motor (`fluxo_*`, `chat_*`) foi alterada.

**Segurança:** o PIN é a prova de identidade (por isso o `cpf_confirma` pode ser respondido sozinho). O navegador nunca recebe o CPF inteiro, só `***.***.***-25`. A conversa precisa ser do celular do cadastro e a criança precisa ser filho do cadastro (pelo nome); senão o chat pergunta normalmente. Se o PIN passar de 30 minutos, o chat volta a perguntar normalmente. Em **Meus dados** (`/acesso/`) dá para informar, alterar ou apagar o CPF salvo de cada pessoa.

**Limites conhecidos:**
- "Todos os filhos" usa os irmãos do chat (só filhos). **Pai/mãe + filhos no mesmo pedido** não existe no motor (uma conversa é de uma pessoa); fica para outra etapa.
- O **nome da mãe** e o **sexo** (`dados_ident`) ainda são perguntados nas conversas com a API do Klingo; só CPF e nascimento foram resolvidos.
- ~~Quem usa e-mail e senha (conta antiga) continua pelo caminho de antes~~ — resolvido na seção abaixo (15/11/2026).
- Se o CPF guardado estiver errado, a pessoa corrige em *Meus dados > Alterar* (o chat não sobrescreve um CPF já salvo).

## Contas antigas viram acesso rápido: uma forma de login só (15/11/2026)
**Banco:** `supabase/acesso-rapido-conta-antiga.sql` (`npm run test:acesso-antiga-sql`, 20 casos). **Telas:** `acesso/index.html` e `index.html` (`npm run test:acesso-antiga`, 13 casos; `test:login`, 26).

**O que acontece com quem já tem conta de e-mail e senha** (hoje 8 contas; 5 com nome e celular, 1 ligada a cadastro da clínica com CPF e nascimento):
1. Com o acesso rápido ligado, o chat mostra ao logado: "⚡ Crie seu PIN: seus dados já estão salvos…" → *Criar meu PIN* (abre `/acesso/?voltar=chat&antiga=1`). Quem entra por `/acesso/` usa *Tenho conta com e-mail e senha*.
2. Vindo do chat, a página **reaproveita a sessão** (não pede a senha de novo). Senão pede e-mail e senha, **uma última vez** (a sessão fica só na memória da página).
3. A tela mostra o que já temos (e-mail, CPF mascarado) e deixa celular, nome e nascimento **já preenchidos**; só o que estiver em branco a pessoa digita.
4. Ela cria o PIN (duas vezes). O banco (`app_conta_antiga_herdar`) junta **conta + cadastro da clínica** e grava em `app_paciente`: nome, celular (login), e-mail, **CPF** e nascimento; `conta_antiga_id` guarda de qual conta veio e `paciente_sugerido_id` repete o cadastro da clínica já ligado à conta.
5. A conta antiga **não é apagada**: só sai deste aparelho (logout + sessão apagada). Daí em diante: celular + PIN, o chat não pergunta CPF e nascimento de novo, e *Meus dados* mostra nome, nascimento, celular, e-mail e CPF mascarado.

**Regras:** nada nasce sozinho (sem PIN digitado, nenhuma linha em `app_paciente`); só o papel `authenticated` executa as duas funções e elas usam a sessão (`auth.uid()`), então ninguém herda a conta de outra pessoa; celular já usado por outro acesso é recusado; menor de 18 é recusado; mesma trava de cadastros por hora. O celular continua **sem confirmação por SMS** (limite já conhecido do acesso rápido).
**Com o acesso rápido ligado**, a faixa "Entrar / Criar conta" de e-mail some do chat para quem não tem conta antiga (e quem se cadastrar passa a ser só celular + PIN).
**Voltar atrás:** comandos no cabeçalho do SQL (apagam as 3 funções e a coluna `conta_antiga_id`; as contas antigas continuam funcionando).
**Ainda não existe:** filhos nas contas antigas (as contas antigas nunca tiveram filhos); código por SMS para provar o celular.

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
