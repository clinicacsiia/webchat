# Pendências que dependem do dono

Versão 2.9 — 15/11/2026 / Mudança: pendência 2.17.0 (relatório da hora real). Versão 2.8 — 15/11/2026 / Mudança: seção 2.17 (simulação da clínica). Versão 2.7 — 15/11/2026 / Mudança: auditoria do PIN no sistema todo (`auditoria-pin-2026-11-15.md`): trava no servidor para 49 funções do paciente (aplicada), PIN óbvio recusado, minha-vez no modelo do PIN, fase 2 da fila (item 12). Versão 2.6 — 15/11/2026 / Mudança: trava do PIN também no servidor (aplicada **desligada**), página do PIN com o azul e o logo da CSI, teste ao vivo (item 11 da seção 2.16). Versão 2.5 — 15/11/2026 / Mudança: correção do chat que abria sem PIN para quem já tinha o service worker (item 10 da seção 2.16). Versão 2.4 — 15/11/2026 / Mudança: coordenadas aproximadas da clínica gravadas em `config` e aba **Acessos** no botão Pendências do painel (itens 3 e 6 da seção 2.16). Versão 2.3 — 15/11/2026 / Mudança: seção 2.16 reescrita com o estado real (PIN obrigatório no ar, banco aplicado, telas publicadas, tabela de acessos fechada, política de privacidade atualizada) e seção 2.15 com a publicação das telas concluída. Versão 2.2 — 15/11/2026 / Mudança: seção 2.16 (PIN obrigatório). Versão 2.1 — 15/11/2026 / Mudança: seção 2.15 (Acompanhe seus pedidos). Versão 2.0 — 15/11/2026 / Mudança: catálogos CSI e CSI RM/TC ligados; notificações e modos do Klingo ligados; botão Pendências no painel; texto de privacidade com o acesso rápido; lista do que continua dependendo do dono (seção 0). Versão 1.9 — 15/11/2026 / Mudança: acesso rápido ligado; itens 1 e 2 da seção 2.14 concluídos. Versão 1.8 — 15/11/2026 / Mudança: item 9 da seção 2.14 (filhos dos contatos antigos); SMS descartado. Versão 1.7 — 15/11/2026 / Mudança: item 8 da seção 2.14 (pendências e dúvidas para todos). Versão 1.6 — 15/11/2026 / Mudança: item 7 da seção 2.14 (contas antigas viram acesso rápido). Versão 1.5 — 14/11/2026 / Mudança: seção 2.14 (acesso rápido do paciente). Versão 1.4 — 14/11/2026 / Mudança: depois das decisões do dono: 1.3 reescrita (a função `klingo-agendamento` é MANTIDA e protegida no servidor), 2.13 atualizada (partes 4 e 5, configuração pública, histórico do telefone tratado). Versão 1.3 — 14/11/2026 / Mudança: seção 1.3 (risco ativo) e 2.13 (reestruturação do WebChat); 2.10 substituída. Versão 1.2 — 13/11/2026 / Mudança: seção 2.11 (revisão mensal das conversas). Versão 1.1 — 12/11/2026: seção 2.8 (autoatendimento Klingo). Versão 1.0 — 11/11/2026: lista única, conferida na produção em 11/11/2026 às 14:50 (Brasília)

Só entra aqui o que **só você consegue fazer**: decidir, colar um segredo, autorizar, falar com terceiros. O que é técnico e não depende de você está no fim, para você saber que não está esquecido. Cada item tem o link direto da tela onde a ação acontece.

A mesma lista existe como página (com caixas de marcar): peça ao Claude "abra a página de pendências".

---

## 0. Ligado em 15/11/2026 e o que ainda depende de você

**Ligado hoje (por pedido seu):** acesso rápido (`app_acesso_modo`), catálogos **CSI** e **CSI RM/TC** (`catalogo_csi`, `catalogo_rmtc`; agora o chat mostra as 3 unidades), notificações e vagas (`notificacao_modo`, `previsao_modo`, `previsao_monitor_modo`) e o **PIN obrigatório** e a **localização opcional** (`app_pin_obrigatorio`, `app_local_ativo`, ligados no mesmo dia; as coordenadas da clínica estão gravadas de forma **aproximada**, ver 2.16) e os modos do autoatendimento do Klingo (`klingo_api_horarios`, `_marcar`, `_pre_cadastro`, `_cancelar`, `_remarcar`, `_consultar` = `sim`; o motor já tratava tudo como ligado desde 14/11, então o painel só passou a mostrar a verdade). **Para desligar qualquer um na hora:** Configurações no painel, ou `update public.config set valor = 'nao' where chave = '<chave>';`.

**Continua desligado de propósito, porque depende de você ou do Klingo:**
| Chave / item | Por que não liguei | O que falta |
|---|---|---|
| `klingo_api_resultado` (laudo) | Nunca foi testado com laudo liberado real; o link e a senha do resultado seguem pela equipe | Resposta do suporte do Klingo (item 2.3) e um paciente real para o teste |
| `klingo_webhook` | O Klingo ainda não cadastrou a URL | Pedir ao Klingo para cadastrar |
| `permissao_modo` = `observacao` | Ligar bloqueia o que a equipe vê por unidade; a estrutura (Luzia, Juliana, atendentes, unidades) ainda não está fechada | Itens 1.1 e 2.1 |
| `cadastro_equipe_sem_convite`, `reaproveitar_cadastro_convidado` | `nao` é o estado **seguro** (só convite cria equipe; convidado não reaproveita cadastro) | Nada: não ligar |
| `disponibilidade_encerra_conversa`, `agendamento_reconhecer_msg_encerradas` | Decisão operacional sua | Dizer se quer |
| E-mail do sistema (SMTP) | Só você cria a senha de app do Gmail | Item 1.1 |
| Proteção contra senha vazada (Supabase Auth) | Chave do painel do Supabase, depende do plano | https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/auth/providers |

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


### 1.3 Função pública `klingo-agendamento`: mantida (decisão sua de 14/11/2026), segurança no servidor pronta e **não publicada**
- **Decisão:** a função **não é apagada nem desativada**. A auditoria (https://github.com/clinicacsiia/webchat/blob/ccr-462c5406-8n7vre/docs/reestruturacao-2026-11-14/07-auditoria-klingo-agendamento.md) confirmou que ela pode ser chamada direto, sem passar pelo site, e que CPF + nascimento são a única prova; marcar/cancelar/remarcar de **outra pessoa só** vale para quem souber esses dois dados.
- **O que já está pronto (na branch, não publicado):** limite de pedidos por IP e por CPF, limite de escritas, trava de nascimentos errados por IP e por CPF, chave para desligar sem publicar (`agendamento_externo_modo`), registro de auditoria só com hashes. Mesmo contrato para quem já usa; três respostas novas possíveis (429/503 com `mensagem`).
- **O que depende de você:** autorizar a publicação (primeiro `supabase/klingo-agendamento-seguranca.sql`, depois a função 1.1) e, se quiser, um **segundo fator por e-mail** (SMS descartado) para ações que escrevem. Link da função: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions/klingo-agendamento
- **`klingo_auto = sim`:** mantido como está, por decisão sua (agendamento automático para todos). **Atualização 14/11/2026:** o autoatendimento ficou SEMPRE LIGADO para todos (`supabase/webchat-v2-sempre-ligado.sql`, aplicada); as chaves de modo (`klingo_auto`, `klingo_api_*`, `previsao_*`, `notificacao_modo`), a lista de telefones de teste, o percentual, a autogestão e a promoção deixaram de decidir qualquer coisa. Ficam só os limites e `agendamento_externo_modo` da página pública e `klingo_api_resultado` (laudo, sem integração).

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
- **Código por e-mail** (segundo fator; SMS descartado pelo dono em 15/11/2026): sem ele, resultado de exame e troca de telefone ficam com a equipe (plano, etapa 6).

### 2.9 Pedido sem horário (13/11/2026): ligar para todos
Está em modo `teste` (só o celular da lista de teste). Quando você aprovar o comportamento, rode em Configurações/SQL: `update public.config set valor = 'ligado' where chave = 'pedido_horario_modo';` Textos que o paciente recebe (oferta do horário mais próximo, do seguinte e pedido para escolher no calendário): chaves `pedido_sem_horario_texto`, `pedido_oferta2_texto` e `pedido_escolha_texto`. Prazo do aviso ao atendente: `pedido_parado_horas` (24). Atenção: horário "ocupado no Klingo" também dispara a oferta, e pode ser a própria equipe que marcou com outro nome ou telefone.

### 2.10 Lista de previsão (13/11/2026) — **substituída em 14/11/2026 pela "Disponibilidade futura" (ver 2.13)**
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

### 2.13 Reestruturação do WebChat (14/11/2026) — tudo pronto no repositório, **nada na produção**
Resumo e plano completo: [`reestruturacao-2026-11-14/00-leia-primeiro.md`](reestruturacao-2026-11-14/00-leia-primeiro.md). O que só você decide ou autoriza:
1. **Autorizar a publicação**, na ordem de [`06-plano-de-publicacao.md`](reestruturacao-2026-11-14/06-plano-de-publicacao.md): segurança da `klingo-agendamento` → migrações (partes 1, 2, 4, 3, 5) → Edge Functions (`chat-agenda-api` v2, `klingo-executar` v1.1, `disponibilidade-vigia`) → tela e painel (merge) → **configuração pública** (`webchat-v2-config-publica.sql`). **Atenção:** entre a parte 1 e a configuração pública o público fica sem marcação automática; o plano concentra isso numa janela única.
2. **Validação com o Klingo real**: todos os testes usam Klingo simulado. Indicar um paciente de teste e uma agenda que a equipe aceite cancelar para conferir marcar, ver, cancelar e remarcar de verdade (lista em `06`, seção 3). Nenhuma marcação real foi feita.
3. **Decidir a política de encerramento** de conversa quando o paciente registra disponibilidade futura (`disponibilidade_encerra_conversa`, hoje `nao`).
4. **Suporte do Klingo**: webhook, resultado de exame liberado, remarcação atômica, marcações do balcão em `/vouchers`, limite por minuto, catálogo (lista em [`05-pendencias.md`](reestruturacao-2026-11-14/05-pendencias.md), seção A).
5. **Jurídico**: `privacidade.html` precisa citar solicitação de disponibilidade, consulta de marcações, aviso no chat, retenção e opt-out (item 2.5).
6. **Telefone de teste no GitHub:** tratado na minha branch (histórico reescrito, com a sua autorização). **Sobra:** o mesmo número já estava na `main` desde 10/11 e nas branches antigas, e o GitHub guarda commits antigos por código. Decisão sua: ver [`08-limpeza-do-telefone-no-github.md`](reestruturacao-2026-11-14/08-limpeza-do-telefone-no-github.md). Trocar o telefone na lista de teste resolve o risco prático.
7. Apagar as funções temporárias `klingo-comparar-chat`, `klingo-comparar-14554`, `klingo-teste-api` e `klingo-inspecionar-chat` (a `klingo-agendamento` **fica**).

### 2.14 Acesso rápido do paciente (14/11/2026) — banco aplicado e **LIGADO em 15/11/2026**
Detalhes em [`acesso-rapido-paciente.md`](acesso-rapido-paciente.md). O que só você decide ou faz:
1. ~~**Confirmar a aplicação no Supabase**~~ (feito em 15/11/2026: o dono colou a última parte; funções e permissões conferidas) (o conector pede confirmação nos comandos com `delete` e expira em 60 s). Link do editor SQL, se preferir colar você mesmo: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/sql/new
2. ~~**Testar no celular** antes de ligar~~ (ligado em 15/11/2026; teste de fumaça sem gravar nada passou). Para desligar na hora: `update public.config set valor = 'sim' where chave = 'app_acesso_modo';` (desliga com `'nao'`).
3. **Decidir sobre o "esqueci o PIN"** (hoje celular + nome + nascimento) (decisão sua de 15/11/2026: **nada de SMS**).
4. **Quem atende as solicitações:** hoje só por SQL (`painel_app_solicitacoes`); falta o botão no painel.
5. **Jurídico:** `privacidade.html` precisa citar o acesso rápido, dados de crianças e prazo de guarda (junto com 2.5).
6. **CPF guardado no cadastro (15/11/2026):** o acesso rápido passa a guardar o CPF de quem usa (e dos filhos) para o chat não perguntar toda vez. Confirme que está de acordo e inclua na política de privacidade (finalidade, prazo, direito de apagar: já existe o botão *Apagar o CPF salvo* em Meus dados).
7. **Contas antigas (15/11/2026):** as 8 contas de e-mail e senha viram acesso rápido quando a pessoa entra uma última vez e cria o PIN (nada é migrado sozinho). Ao ligar o acesso rápido, **avise essas pessoas** (ou deixe o convite do chat fazer isso). Quem esqueceu a senha usa *Esqueci a senha* na própria tela. Depois que todas migrarem, dá para desligar de vez o login por e-mail (`login_paciente = 'nao'`); decisão sua.
8. **Pendências e dúvidas para todos (15/11/2026):** todo paciente do acesso rápido é solicitado a informar CPF (dele e dos filhos) e e-mail. Dúvidas com a base da clínica ficam só para a equipe (`select public.painel_app_revisoes();`). **Decida quem da equipe confere** essas dúvidas (hoje só por SQL; falta o botão no painel) e saiba que, **sem SMS**, os dados da clínica não são trazidos automaticamente (o paciente digita e o sistema confere em silêncio); só as contas antigas, que provam a identidade com e-mail e senha, trazem dados e filhos.
9. **Filhos dos contatos antigos (15/11/2026):** confira a planilha `filhos-dos-contatos-antigos.xlsx` que enviei (14 contatos com "filho" de nome igual ao deles). Os de adulto viram "Você"; os de criança ou sem nascimento a própria pessoa decide na migração. Nada foi alterado nas conversas antigas.

### 2.15 Acompanhe seus pedidos (15/11/2026): banco e telas no ar
Detalhes em [`acompanhar-pedidos.md`](acompanhar-pedidos.md). O que só você faz ou decide:
0. **Decisão (15/11/2026): o que "apagar" significa.** Por segurança, apagar **tira o pedido da lista do paciente** (e some sozinho 30 dias depois do encerramento); a conversa, as mensagens, a avaliação e os indicadores **continuam no painel**. Apagar de verdade a conversa levaria junto avaliações, encerramentos e histórico dos indicadores, e o prazo de guarda ainda não foi definido (item 2.5). Se quiser a eliminação real depois do prazo, é só dizer: faço uma rotina que apaga a conversa inteira (ou só o texto das mensagens) depois do prazo que o jurídico definir.
1. ~~**Publicar as telas**~~ (feito: PR #187 juntado na `main` em 15/11/2026).
2. **Testar no seu celular** (com o acesso rápido): fazer um pedido, ver o botão grande, o balão, o portal e o check-in de um toque.
3. **Resultado automático ("disponível"):** a vigia está no ar mas **desligada**. Ligar só depois de um teste com um paciente real que autorize (um exame feito com laudo pronto): `update public.config set valor = 'sim' where chave = 'app_resultado_vigia';`. Sem isso o paciente ainda pode **pedir** o resultado (botão "Perguntar pelo resultado"), e a equipe entrega na conversa.
4. **Equipe:** para o resultado ficar "entregue" e guardado, mandar o **arquivo** (botão de arquivo da conversa) ou uma **mensagem com link** na conversa em que o paciente pediu. Se entregar de outro jeito: `select public.painel_resultado_entregue('<id da conversa>');` (falta botão no painel; peça se quiser).
5. **Jurídico:** `privacidade.html` precisa citar o acompanhamento de pedidos e o **prazo de guarda dos resultados** (junto com o item 2.5).

### 2.16 PIN obrigatório na porta do chat (15/11/2026): **NO AR**
Detalhes em [`acesso-rapido-paciente.md`](acesso-rapido-paciente.md) (seção "PIN obrigatório"). Estado conferido na produção em 15/11/2026: banco aplicado, telas publicadas (PR #188), `app_pin_obrigatorio = sim`, `app_local_ativo = sim`, rotina `app-acesso-limpar` ativa. **Nenhum paciente usou o acesso rápido ainda** (cadastros, aparelhos e acessos = 0 nessa data). O que só você decide ou faz:
1. ~~Aprovar a aplicação do banco~~ (feito).
2. ~~Publicar as telas~~ (feito: PR #188 na `main`).
3. **Conferir as coordenadas da clínica (gravadas de forma aproximada em 15/11/2026).** Endereço do site: Rua Teixeira de Barros, 27, Brotas, em frente ao Cemitério de Brotas (a pesquisa por CEP mostrou "Teixeira Barros, em frente ao Cemitério de Brotas, Loja 1, 40279-090"). Como não achei o ponto exato da recepção, gravei `clinica_lat = -12.9862` e `clinica_lng = -38.4773`, o meio entre dois pontos da rua (a ~110 m de cada), com raio de 300 m. Funciona para dizer "na clínica", mas **a melhor coordenada é a da recepção**: no Google Maps toque e segure no ponto (https://www.google.com/maps), copie latitude e longitude e mande para eu trocar, ou rode `update public.config set valor = '<lat>' where chave = 'clinica_lat';` (idem `clinica_lng`, `clinica_raio_m`). Editor SQL: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/sql/new. As unidades Desenvoar e CSI RM/TC podem ter outro endereço: se for o caso, mande o endereço de cada uma (hoje há um ponto só).
4. **Acompanhar** se os pedidos novos caem: com o PIN ligado, **paciente novo precisa informar CPF e criar PIN antes de falar com a clínica**. Desligar volta tudo ao normal na hora: `update public.config set valor = 'nao' where chave = 'app_pin_obrigatorio';` (a localização desliga com `app_local_ativo`).
5. **Jurídico/privacidade:** o texto de `privacidade.html` já cita o **IP**, a **localização** (só com permissão, arredondada, 180 dias; finalidade: segurança e confirmar presença na clínica) e o **CPF obrigatório** no acesso rápido, mas continua como **rascunho em revisão jurídica**: falta o advogado conferir (junto com o item 2.5).
6. ~~**Quem lê os acessos**~~ (feito: aba **Acessos** na janela *Pendências* do painel, para admin e atendente, com filtro "Só divergentes"; mostra o que a pessoa fez, onde estava, exames de hoje, IP e aparelho. Também funciona por SQL: `select public.painel_app_acessos();`).
7. **Alerta de segurança do Supabase (resolvido na parte que dava):** a tabela `app_acesso_log` agora não tem nenhuma permissão de tabela para o público (migração `acesso_rapido_acesso_log_fechar`; as outras 8 tabelas `app_*` já eram assim). O aviso que sobra, "função chamável com a chave pública", é **de propósito**: o paciente não tem login e cada função se protege por dentro (aparelho, PIN, trava). Nada a fazer.
8. **Cadastro de teste:** se você já fez um cadastro no acesso rápido e ele não aparece (0 cadastros na produção), confirme que usou a página do projeto certo e tente de novo.
9. **Limpeza de 180 dias:** a rotina `app-acesso-limpar` roda todo dia às 03h47 (Brasília). Para desligar: `select cron.unschedule('app-acesso-limpar');`.
10. **Chat abrindo sem PIN (corrigido em 15/11/2026).** Causa: o service worker (cópia do chat guardada no celular) respondia a página `/acesso/` com o próprio chat, e a trava contra laço acabava abrindo o chat sem PIN. Corrigido no PR dessa data (`sw.js` v51, chat `2026.11.15-7`). **Se o seu celular ainda mostrar o chat antigo:** feche o app/aba e abra de novo uma vez (a cópia nova entra na abertura seguinte); se continuar, limpe os dados do site `clinicacsiia.github.io` nas configurações do navegador. **Limite que continua:** a regra do PIN é aplicada pela **tela** (chat + página de acesso); o servidor ainda não recusa quem chamar o banco direto sem PIN. Se quiser a regra também no servidor (o `chat_iniciar` passar a exigir um aparelho com PIN válido), é uma mudança maior no motor do chat e quebra páginas antigas guardadas: diga e eu faço com testes.
11. **PIN também no servidor (aplicado em 15/11/2026; LIGADO por você às 06h10 de 15/11/2026, depois do merge do PR #190).** O texto abaixo é o plano original; hoje a trava vale para 49 funções (ver item 12 e `auditoria-pin-2026-11-15.md`). O banco já sabe recusar quem tentar falar com a clínica sem PIN (`app_pin_servidor`), mas ligar antes da tela nova estar publicada derrubaria o chat atual. **Sequência:** (a) juntar o PR; (b) esperar ~1 minuto e rodar/pedir o teste ao vivo (`URL_VIVO=https://clinicacsiia.github.io/webchat npm run test:ao-vivo-pin`); (c) **no seu celular**: abrir o chat, criar/entrar com o PIN e mandar uma mensagem; (d) ligar: `update public.config set valor = 'sim' where chave = 'app_pin_servidor';` (editor SQL: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/sql/new). Se algo der errado, `... valor = 'nao'` desliga na hora. Com isso, mesmo uma tela velha ou com defeito não consegue falar com a clínica sem PIN.
12. **Fase 2 da fila (depende de você juntar o PR da auditoria).** A trava do servidor já vale para o chat e para a conta antiga. O **check-in e a fila** (`checkin_publico`, `fila_cheguei`, `fila_minha_vez`, `paciente_jornada`, `fila_push_salvar`) ficaram de fora de propósito: a `minha-vez` publicada ainda é a antiga e não manda o aparelho (aplicar antes derrubou o check-in por alguns minutos; já recuado). **Sequência:** (a) juntar o PR; (b) esperar ~1 minuto e conferir `curl -s https://clinicacsiia.github.io/webchat/minha-vez/ | grep -c fetchComAparelho` (tem de dar 1 ou mais); (c) no celular: abrir "Acompanhe seus pedidos", fazer o check-in de um toque; (d) pedir "aplique a fase 2" (arquivo `supabase/acesso-rapido-pin-fila.sql`). Para desfazer na hora: o bloco de ROLLBACK no topo desse arquivo. **Efeito no dia a dia da recepção:** com o PIN obrigatório, quem chega pelo QR passa pela página do PIN (cria o PIN uma vez) em vez do check-in sem cadastro; a recepção continua podendo registrar a chegada pelo painel e emitir o link da fila.
13. **Edge Functions do chat** (`ler-pedido`, `chat-agenda-api`): conferem só o código da conversa, não o PIN (ver `auditoria-pin-2026-11-15.md`, "O que sobra"). Diga se quer que eu feche (exige publicar as duas funções).

## 2.17 Simulação da clínica (15/11/2026): o que só você decide ou tem
**0. Hora real (a mais importante):** ajuste o filtro do relatório do Klingo que tem a hora real (chegada, início e fim) para consultar por período, sem prontuário nem CPF, e me passe o número, os ids dos filtros e as colunas (detalhes em `simulacao.md`, seção "Hora real de atendimento"). O banco e a simulação já estão prontos para receber.
Abrir: https://clinicacsiia.github.io/webchat/simulacao/ (entre com a conta do painel). Detalhes em [`simulacao.md`](simulacao.md).
1. **Capacidade real:** o Klingo não informa quantas salas e profissionais há por setor. Abra a simulação, ajuste as estações até refletir a clínica e clique em **Definir como capacidade atual da clínica** (fica salvo no seu navegador). Se quiser que fique para todos, me diga e gravo no banco.
2. **Tempos de guichê, preparo e exame:** se alguém da equipe medir com cronômetro por alguns dias, ponha em **Premissas** (hoje são hipóteses: guichê 3 a 6 min, preparo 4 a 8 min, exame pelo padrão de cada modalidade).
3. **"Confirmado" na recepção:** confirme com a equipe se a recepção marca "Confirmado" quando o paciente chega. Se marcar, a taxa de falta dos confirmados (≈ 11%) fica otimista.
4. **Suporte do Klingo (pergunta 4 de `klingo-relatorios-pendentes.md`):** hora real de início e de fim do atendimento. É o que troca hipótese por medida.
5. **Entrega do resultado:** o sistema não registra quando o paciente busca o resultado (a Jornada tem 2 "concluídos" e `app_resultado` está vazia). Por isso a etapa "Exame feito, resultado" da área externa aparece como ponto cego. Decidir como registrar (equipe marca na conversa? Klingo informa?).
6. **Limites de atenção da área externa** (chat 15/60/240 min, pedido 8/24/72 h, confirmação 10/20/30%): são palpites meus; diga se a clínica usa outros.
7. **Check-in pelo "Minha vez":** só 5 pacientes usaram até 15/11/2026. É a única espera de verdade; incentivar na recepção melhora a simulação.

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
