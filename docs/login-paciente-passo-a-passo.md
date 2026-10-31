# Login do paciente — passo a passo para ligar

Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial

**Resumo.** O paciente pode agendar **sem conta** (sempre como paciente novo) ou **criar uma conta com e-mail e senha**. Com conta, nome, telefone e cadastro ficam salvos e não se repetem; o histórico e o "repetir o último exame" aparecem só para quem entrou na conta. O e-mail serve só para confirmar a conta e redefinir a senha. A tela nasce **desligada**: publicar o chat não abre nada.

## O que muda para quem agenda

| Quem | O que acontece |
|---|---|
| Sem conta (convidado) | Agenda normalmente. Não aparece pergunta de data de nascimento, histórico nem "repetir o último exame". Cada agendamento vira um cadastro novo; a recepção une duplicados no Klingo. |
| Com conta, primeira vez | Preenche nome e telefone uma vez. O cadastro criado nessa conversa passa a ser o da conta. |
| Com conta, próximas vezes | Nada para redigitar. Cadastro e histórico valem sem perguntar a data de nascimento (a conta é a prova de identidade). |
| "Para meu filho(a)" | Os dados do responsável vêm da conta, mas o cadastro da criança ainda é digitado a cada vez (dependentes ficam para a próxima etapa). |

Cadastros que já existiam antes (digitados sem verificação) **nunca** são ligados sozinhos a uma conta.

## Ordem de ativação (cada passo só depois do anterior)

1. **Publicar o código** (merge dos PRs). Pode ser a qualquer hora: sem o banco novo, a tela de login simplesmente não aparece.
2. **Colar o SQL** `supabase/aplicar-login-paciente.sql` no Supabase > SQL Editor > Run. Pode rodar de novo sem problema. Depois disso o login continua **desligado**.
3. **Conferir** (opcional, no SQL Editor):
   ```sql
   select (select count(*) from public.contas_paciente) as contas,
          (select valor from public.config where chave = 'login_paciente') as login_paciente,
          (select valor from public.config where chave = 'cadastro_equipe_sem_convite') as equipe_sem_convite,
          (select valor from public.config where chave = 'reaproveitar_cadastro_convidado') as reaproveitar_convidado;
   ```
   Esperado agora: `0`, `nao`, `sim`, `nao`.
4. **Equipe só por convite.** Confirme que o painel novo está no ar (abra o painel e use "Adicionar pessoa" com um e-mail de teste, ou só confira que o botão funciona). Depois rode:
   ```sql
   update public.config set valor = 'nao' where chave = 'cadastro_equipe_sem_convite';
   ```
   A partir daqui, quem se cadastra sem convite vira conta de paciente, **nunca** equipe. Para dar acesso a uma pessoa da equipe, use "Adicionar pessoa" no painel (ele convida o e-mail antes de cadastrar).
5. **Configurar o Auth** (Supabase > Authentication):
   - **Providers > Email:** ligar **Confirm email**. (Sem isso qualquer pessoa cria conta com o e-mail de outra.) Confirme que "Allow new users to sign up" está ligado.
   - **Providers > Email, regras de senha:** mínimo de 8 caracteres, exigindo letras e números. Se o seu plano tiver "Prevent use of leaked passwords", ligue.
   - **URL Configuration > Redirect URLs:** adicionar `https://clinicacsiia.github.io/webchat/**` (o endereço do chat; hoje a lista só tem o painel).
   - **Email Templates:** em "Confirm signup" e "Reset password" troque o texto para algo genérico da clínica (o modelo de `supabase-emails/confirmar-cadastro.html` fala em "painel de atendimento"). Sem trocar, funciona, mas o texto confunde o paciente.
   - **Opcional, recomendado:** CAPTCHA (Authentication > Bot and Abuse Protection > Cloudflare Turnstile, grátis). Se ligar, cole a chave do site em `TURNSTILE_SITEKEY` no `index.html` (uma linha) e publique; sem isso, criar conta e entrar passam a falhar.
6. **Testar com 2 e-mails seus** antes de ligar (precisa do passo 7 ligado só no seu teste, ou ligue e teste logo em seguida):
   crie uma conta, confirme pelo link, entre, faça um pedido de exame "para mim" até o fim, saia, entre de novo e comece outro pedido: o nome, o telefone e o cadastro devem vir prontos.
7. **Ligar:**
   ```sql
   update public.config set valor = 'sim' where chave = 'login_paciente';
   ```
   Para desligar na hora, se algo estranho aparecer: `update public.config set valor = 'nao' where chave = 'login_paciente';`. A tela some e quem estava logado volta a agendar como convidado.

O interruptor só liga de verdade se `cadastro_equipe_sem_convite = 'nao'` (passo 4). Se o passo 4 for esquecido, a tela continua escondida.

## Voltar atrás

- **Desligar só o login:** `login_paciente = 'nao'` (acima).
- **Voltar o reaproveitamento por data de nascimento para convidados** (não recomendado; era o ponto fraco da auditoria): `update public.config set valor = 'sim' where chave = 'reaproveitar_cadastro_convidado';`
- **Equipe se cadastrar sem convite de novo:** `update public.config set valor = 'sim' where chave = 'cadastro_equipe_sem_convite';` (isso também esconde a tela de login).
- Os passos de reverter o código SQL estão no cabeçalho de cada arquivo em `supabase/`.

## Meus dados: ver, baixar uma cópia e apagar a conta (31/10/2026)

Arquivo `supabase/meus-dados.sql` (rodar **depois** do instalador do login; pode rodar de novo sem problema). No chat, quem está logado vê o botão **Meus dados** ao lado de "Sair da conta".

- **Ver:** e-mail, nome e telefone da conta e se há cadastro de paciente ligado. Abrir a janela não registra nada.
- **Baixar uma cópia:** um arquivo de texto legível (e, em outro botão, o mesmo conteúdo em JSON) com a conta, o cadastro, o histórico de atendimentos, os pedidos e as conversas **da própria conta**. Ficam de fora as notas internas da equipe, o resumo da IA e as fotos de pedido (a tela informa quantas existem; para recebê-las a pessoa fala com a clínica).
- **Apagar a conta:** apaga **só o login** (conta, e-mail e vínculo). **Cadastro de paciente, pedidos, conversas, fotos e histórico continuam guardados pela clínica**, e a tela diz isso, em dois toques, antes de confirmar.
- **Registro:** cada cópia e cada exclusão grava uma linha sem dado pessoal em `conta_paciente_evento` (tipo, data, se havia cadastro e quantas conversas). Só o administrador lê: `select * from public.conta_paciente_evento order by id desc;`.
- **Revisão jurídica pendente:** o texto da tela e a lista do que continua guardado precisam ser lidos pelo jurídico antes de ligar o login ao público. Se a clínica decidir apagar mais (por exemplo nome e telefone do cadastro), é uma mudança em `conta_paciente_excluir`.
- **Voltar atrás:** `drop function public.conta_paciente_meus_dados(), public.conta_paciente_excluir(text);` (o botão passa a dar erro; para escondê-lo é preciso publicar o chat sem a tela).
- Teste: `npm run test:meus-dados` (banco) e `npm run test:login` (tela). Não foi testado contra o Supabase real: a exclusão apaga de `auth.users`, e o primeiro teste de ponta a ponta com uma conta de verdade continua pendente (passo 6).

## Cadastro ligado ao paciente que já existe (31/10/2026)

Arquivo `supabase/vincular-cadastro.sql` (rodar **depois** do instalador do login; pode rodar de novo sem problema). Quem já é paciente da clínica não precisa que a equipe ligue a conta à mão.

- **Na tela:** "Criar conta" pede nome, telefone, e-mail, data de nascimento e senha. Use os mesmos dados do cadastro na clínica.
- **Depois de confirmar o e-mail,** o chat chama `conta_paciente_vincular()`. O banco liga a conta ao cadastro **somente se** estas quatro coisas batem **no mesmo cadastro**: e-mail da conta (já confirmado) = e-mail do cadastro, telefone, nome e data de nascimento. Cadastro sem e-mail ou sem data de nascimento nunca é ligado sozinho (a equipe liga).
- **Fica de fora:** cadastro em revisão (`revisar`), cadastro já ligado a outra conta e caso ambíguo (dois cadastros iguais).
- **Segurança:** o e-mail confirmado é a prova principal (só quem abre aquele e-mail chega ao link). A data de nascimento é conferida no banco, no máximo 5 tentativas por hora por conta, e é apagada do login depois da tentativa. A resposta ao paciente só diz "ligou" ou "não achamos"; nenhum dado do cadastro volta.
- **Se não achar:** a conta fica criada e o paciente agenda normalmente; a equipe pode ligar depois. Quem ligou aparece em `contas_paciente` (`vinculado_em`, `vinculo_metodo`, `vinculo_tentativas`).
- **Voltar atrás:** `drop function public.conta_paciente_vincular();` (as colunas novas podem ficar). Sem a função, a tela só mostra o aviso de "não achamos".

## Ainda não existe (próximas etapas)

- Dependentes (filhos) ligados à conta do responsável.
- Vincular à conta um cadastro antigo (a recepção valida a identidade e faz o vínculo).
- Limite de tentativas e bloqueio por conta (hoje valem os limites do Supabase Auth por IP).
- Resultado de exame: o sistema ainda não guarda laudos.
- Texto de privacidade e prazo de retenção revisados pelo jurídico.

## Como foi testado

Suítes em `testes/`: `test:contas` (15), `test:protecao` (11), `test:login-sql` (20, inclui o instalador único), `test:login` (15, navegador). Não houve teste contra o Supabase real nem com e-mail de verdade: o primeiro teste de ponta a ponta é o do passo 6.
