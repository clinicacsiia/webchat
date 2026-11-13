# Pendências que dependem do dono

Versão 1.2 — 13/11/2026 / Mudança: seção 2.11 (revisão mensal das conversas). Versão 1.1 — 12/11/2026: seção 2.8 (autoatendimento Klingo). Versão 1.0 — 11/11/2026: lista única, conferida na produção em 11/11/2026 às 14:50 (Brasília)

Só entra aqui o que **só você consegue fazer**: decidir, colar um segredo, autorizar, falar com terceiros. O que é técnico e não depende de você está no fim, para você saber que não está esquecido. Cada item tem o link direto da tela onde a ação acontece.

A mesma lista existe como página (com caixas de marcar): peça ao Claude "abra a página de pendências".

---

## 1. Faça primeiro (afeta gente hoje)

### 1.1 O e-mail do sistema não está saindo
- **O que acontece:** o Gmail recusa a senha que o Supabase usa para enviar e-mail (`535 Username and Password not accepted`). Foram **8 tentativas falhas**: 3 em 10/11 (17h21 a 17h23) e 5 em 11/11 (entre 8h e 10h).
- **Efeito:** ninguém consegue **criar conta** (paciente ou equipe) nem usar **"esqueci a senha"**. Quem já tem conta entra normalmente. É isto que impede a Luzia e a Juliana de entrarem pelos convites.
- **Como resolver (5 minutos):**
  1. Na conta do Google que envia os e-mails da clínica, crie uma senha de app nova: https://myaccount.google.com/apppasswords
  2. Cole a senha em Supabase > Authentication > SMTP Settings (campo Password) e salve: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/auth/smtp
  3. Teste criando uma conta no painel: https://clinicacsiia.github.io/webchat/painel/
- **Não cole a senha na conversa com o Claude.** Se quiser, eu confiro os registros depois e digo se voltou.

### 1.2 Publicar as correções do chat e do painel
- **O que acontece:** as correções das telas estão prontas e testadas na branch `ccr-52cd66b5-sduxnt`, mas o site só muda quando ela entra na `main`. Enquanto isso o chat antigo continua gerando o erro "Essa pergunta já foi respondida" (7 vezes nas últimas 8 horas).
- **Como resolver (2 minutos):** abra a PR e junte: https://github.com/clinicacsiia/webchat/compare/main...ccr-52cd66b5-sduxnt?expand=1 — ou diga ao Claude "abra a PR".
- Depois de juntar, o GitHub publica sozinho em cerca de 1 minuto: https://github.com/clinicacsiia/webchat/actions

---

## 2. Decisões e dados que só você tem

### 2.1 Fechar a estrutura da equipe (Etapa B)
- Depende do item 1.1 (as contas novas precisam do e-mail).
- Quando a **Luzia** e a **Juliana** criarem a conta, ligar cada uma em Equipe > Estrutura: https://clinicacsiia.github.io/webchat/painel/
- **Autorizar** (ou não) mudar o papel da **Carla Adrielle** de administradora para supervisora.
- Dizer **quem atende em cada equipe** (hoje constam "Atendente 1 a 4") e a unidade de cada equipe.
- Só depois disso ligar as permissões por unidade (hoje em modo observação: nada é bloqueado). Eu ligo quando você pedir.

### 2.2 Aprovar dois textos que o paciente lê
Estão no ar com a redação proposta; dá para editar em Configurações.
- Aviso de previsão: *"Importante: os dias e horários que mostramos aqui são uma previsão de agendamento. Quem confirma o seu agendamento é uma pessoa da nossa equipe."*
- Convênio suspenso: *"O convênio {convenio} está temporariamente suspenso por decisão administrativa. Posso te ajudar a escolher outro convênio ou o atendimento particular?"*

### 2.3 Perguntas ao suporte do Klingo
Enviar para **suporte@klingo.com.br** (o texto-base está em `docs/fase-0-email-suporte-klingo.md`):
1. Onde fica cadastrado o **preço Particular**? (o relatório D não traz)
2. O Klingo gera **link e senha do resultado** para o paciente? Qual consulta devolve?
3. Há como saber que um **convênio foi inativado**?
4. Existe **última atualização do cadastro** e **hora real do atendimento**?
5. O histórico de marcações é mesmo curto? (3 e 12 meses deram o mesmo total)

Sem essas respostas: o preço Particular continua digitado à mão no Cardápio, a suspensão de convênio é controlada aqui e o resultado de exame não é entregue pelo chat.

### 2.4 Um paciente real para o teste do Klingo
A conferência por CPF + nascimento (`klingo-paciente`) nunca foi provada com um paciente de verdade. Preciso de **um paciente cadastrado que autorize** (ou do seu nome completo e nascimento como estão no Klingo).

### 2.5 Jurídico
- Revisar `privacidade.html` e `termos.html` (hoje são rascunho).
- Informar **CNPJ** e **e-mail do encarregado** (aparecem como "a informar").
- Definir o **prazo de guarda** de conversas e fotos.
- Parecer sobre a **leitura da foto do pedido por IA** e sobre a **assinatura biométrica** antes de ligar qualquer uma das duas.

### 2.6 Leitura da letra do médico por IA (opcional, depois do jurídico)
- Criar o segredo `ANTHROPIC_API_KEY`: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions/secrets
- Depois me peça "publique a ler-pedido". Hoje o chat lê só o texto impresso, no próprio celular.

### 2.7 Desenho do cadastro do paciente
Decidir se o login continua opcional como está ou se vira o cadastro único (nome, telefone e e-mail, com a senha confirmada pela data de nascimento) e quando abrir ao público.

---

## 2.8 Autoatendimento Klingo (12/11/2026): o que só você ou o Klingo fazem
Detalhes e números em [`klingo-autoatendimento.md`](klingo-autoatendimento.md).
- **Primeiro teste real de marcação** (o único passo para abrir a marcação sozinha): um paciente que autorize, o celular dele em `klingo_api_telefones_teste` (Configurações) e o call center avisado para cancelar. Passo a passo na seção 6 do documento. Sem isso a marcação sozinha fica em modo teste (ninguém usa) e o sistema não avança.
- **Perguntas ao suporte do Klingo** (e-mail em `docs/klingo-api-externa/roteiro-reuniao-suporte.md`): a URL do webhook (`https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/klingo-webhook`, com a chave da clínica no cabeçalho `X-APP-TOKEN`); o limite de chamadas por minuto; liberar ortopedia, endocrinologia e as outras especialidades na API (hoje só neurologia, pediatria e radiologia); o número do plano da ASSEFAZ; uma agenda de teste na API; se `/vouchers` mostra o `id_externo`.
- **13 pacientes com nascimento diferente do Klingo** (o mesmo CPF com outra data): o sistema não marca sozinho para eles; a recepção confere (pode ser CPF do responsável de uma criança).
- **Revisar `privacidade.html`** para citar a marcação automática e o envio de CPF ao Klingo (junto com o item 2.5).
- **Código por SMS/e-mail** (segundo fator): sem ele, resultado de exame e troca de telefone ficam com a equipe (plano, etapa 6).

### 2.9 Pedido sem horário (13/11/2026): ligar para todos
Está em modo `teste` (só o celular da lista de teste). Quando você aprovar o comportamento, rode em Configurações/SQL: `update public.config set valor = 'ligado' where chave = 'pedido_horario_modo';` Textos que o paciente recebe (oferta do horário mais próximo, do seguinte e pedido para escolher no calendário): chaves `pedido_sem_horario_texto`, `pedido_oferta2_texto` e `pedido_escolha_texto`. Prazo do aviso ao atendente: `pedido_parado_horas` (24). Atenção: horário "ocupado no Klingo" também dispara a oferta, e pode ser a própria equipe que marcou com outro nome ou telefone.

### 2.10 Lista de previsão (13/11/2026)
Quando o paciente toca em "Nenhum horário serve" (ou recusa as duas ofertas), o assistente pergunta turno e período, oferece horário dentro do filtro e, se não houver, pergunta se quer ficar na LISTA DE PREVISÃO (texto: não confirma o dia). Quem fica diz com que antecedência pode ser chamado. Está em modo `teste` (mesma chave `pedido_horario_modo`). No painel há o botão **Lista de previsão** (admin e atendente): mostra quem espera, turno, período, antecedência e destaca a linha quando abre vaga; só leitura, com botão para abrir a conversa. A tabela `pedido_previsao` guarda os dados. Decida o prazo que a equipe se compromete a responder e revise os textos `previsao_*` em `config`.

### 2.11 Revisão mensal das conversas com o Claude (criada em 13/11/2026)
- **Regra:** se passar **1 mês sem a revisão**, a pendência vira "faça primeiro". **Última revisão feita: 13/11/2026** (primeira análise). **Próxima: até 13/12/2026.**
- **Como fazer (5 minutos):** abra uma sessão do Claude neste repositório e cole: *"Rode o ciclo de melhoria do chat (`docs/ciclo-de-melhoria-com-claude.md`): compare com a revisão anterior, diga o que melhorou ou piorou, proponha mudanças de texto e de ordem das opções e deixe em arquivos novos para eu aprovar. Não aplique nada na produção sem eu mandar."*
- **Depois:** o Claude anota aqui a nova data de "Última revisão". Quem for conferir a lista de pendências olha esta data: se tiver mais de 30 dias, avisar o dono.
- **Até lá, três coisas esperam sua decisão:** aplicar os textos novos (`supabase/textos-acolhimento.sql` e `textos-acolhimento-botao.sql`) junto com a tela nova; reordenar as opções por uso; escrever na política de privacidade que as conversas ajudam a melhorar o serviço (revisão jurídica).

### 2.12 Conferência Klingo × webchat (13/11/2026)
- **Equipe:** abrir a aba **Avisos** e resolver os cartões "Conflito entre o chat e o Klingo" e "Falta dado no cadastro do Klingo" (36 abertos na primeira leitura, quase todos de filho(a): faltava o e-mail do responsável). Em filho(a), nunca cadastrar o CPF do responsável na criança.
- **Você decide:** "atendido" deve valer mesmo quando a marcação está **cancelada** no Klingo? (14 casos em 09 a 12/11.) Hoje o banco conta como atendido.
- **Apagar no painel do Supabase** (https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions): a função temporária `klingo-comparar-14554`.
- **Apagar no banco** quando o Supabase pedir a confirmação: `drop function public.klingo_conferir_agendar(integer);` (não mexer na de mesmo nome com `uuid`). Detalhes em `klingo-conferencia.md`.

## 3. Contas e segurança

### 3.1 Plano do Supabase e proteção contra senha vazada
- O projeto está no plano gratuito (500 MB). O banco está em **208 MB** e deve cair para cerca de 90 MB nos próximos 3 dias, agora que a avalanche de avisos parou.
- A **proteção contra senha vazada** só existe no plano Pro. Se assinar, ligue em Authentication > Providers > Email: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/auth/providers

### 3.2 E-mails em português
Trocar os modelos "Confirm signup" e "Reset password" pelo texto da clínica (`supabase-emails/confirmar-cadastro.html`): https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/auth/templates

### 3.3 Dados pessoais no histórico do Git
Um telefone de teste e o seu CPF saíram dos arquivos atuais, mas **continuam nos commits antigos** de um repositório público. Decidir: limpar o histórico (eu faço, com a sua autorização, porque reescreve a história) e/ou tornar o repositório privado: https://github.com/clinicacsiia/webchat/settings

**Atenção:** em conta gratuita do GitHub, repositório privado **desliga o GitHub Pages**, que é onde o chat e o painel ficam. Não torne privado sem antes conferir o plano.

---

## 4. Limpezas pequenas (quando sobrar tempo)

- Apagar a função temporária `klingo-inspecionar-chat`: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions/klingo-inspecionar-chat
- Apagar também a função de testes `klingo-teste-api` (já desativada; responde 410): https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions/klingo-teste-api
- Conferir se os 7 bloqueios automáticos antigos de "mesma pessoa" (02/11) ainda existem; o comando está em `docs/pendencias-pessoa-unica.md` e precisa ser rodado por você no editor SQL: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/sql/new
- Testar o chat com 3 a 5 pessoas de 70 anos ou mais.
- Decidir se o módulo "Fila com assinatura biométrica" segue ou é arquivado (está parado desde 30/10).

---

## 5. O que NÃO depende de você (está comigo)

Já feito nesta rodada (11/11/2026), tudo conferido na produção:

| Feito | Resultado |
|---|---|
| Avalanche de avisos de tempo real | De ~9.960 por hora para 33 a 60 por hora |
| Encerrar como "Agendado" | 70 conversas em 0,12 s (eram 43 s; estourava o limite) |
| "Mapa do corpo" do chat | 0,9 ms (eram 1.180 ms) |
| Limpeza do histórico das rotinas | 18.668 registros velhos apagados; roda toda madrugada |
| Funções de gatilho abertas sem necessidade | De 9 para 0 |
| Retrato da produção no repositório | 425 funções e 101 tabelas, com teste de ponta a ponta sobre o código real |

Próxima rodada técnica (é só pedir):
1. Deixar mais leve a gravação da ocupação da agenda (`agenda_ocupacao_atualizar`: 0,8 s por chamada, 22 mil chamadas).
2. Permissões por unidade também em pacientes, pedidos e contatos (depois do item 2.1).
3. Convênio suspenso aparecer esmaecido na lista do chat (hoje some).
4. Histórico completo da pessoa e separar "ao vivo" de "histórico" no painel.
5. Acessibilidade do painel (título principal, contraste da borda dos campos, foco preso em janelas).
6. Conferir linha a linha as Edge Functions publicadas contra o repositório.
