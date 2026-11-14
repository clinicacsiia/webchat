# Página de agendamento técnica (`/agendamento/completo/`)

> **13/11/2026:** a página `/agendamento/` agora é a **página nova para o paciente e a família** (ver `docs/familia-agendamento.md`). Esta, com todas as abas (catálogos, equipe, API), mudou para `/agendamento/completo/` e continua igual; o link está no rodapé da página nova. O teste desta página (`npm run test:agendamento`) aponta para o novo endereço.

Versão 1.1 — 13/11/2026 / Mudança: acrescenta tudo o que a documentação tinha e a página não usava (verificar horário, resultado de imagem, entrada por telefone, conta do portal, totais do dia, API de telefonia), menos dinheiro. A 1.0 era a primeira versão. Fonte das regras: `docs/klingo-api-externa/GUIA-COMPLETO.md`.

**Endereço depois de publicada:** `https://clinicacsiia.github.io/webchat/agendamento/` · **Arquivos:** `agendamento/index.html` (a página) e `supabase/functions/klingo-agendamento/` (a função que fala com o Klingo).

## Como funciona

```
 paciente (celular)  ──►  agendamento/index.html  ──POST JSON──►  Edge Function klingo-agendamento  ──►  API do Klingo
   CPF + nascimento          só fala com a função                  guarda a chave (KLINGO_APP_TOKEN),
   ficam na memória          (nunca com o Klingo)                  confere identidade, trava tentativas
```

- **A chave do Klingo não está na página.** Ela só existe no secret `KLINGO_APP_TOKEN` do Supabase.
- **CPF e nascimento ficam só na memória da aba.** Não vão para `localStorage`, cookie nem endereço. "Sair" apaga.
- Cada ação sobre um paciente manda CPF + nascimento de novo; a função confere no Klingo **antes** (`/paciente/cpf`, nascimento igual) e **depois** do login (id e nascimento da sessão).
- Não criou tabela nem função no banco: usa a `klingo_identidade` (guarda o id do pré-cadastro por CPF + nascimento, só com hash) e as funções `klingo_hash`, `klingo_cota_pegar`, `klingo_cota_429`, `klingo_identidade_registrar`, `klingo_pre_gravar`.

## O que a página faz (abas)

| Aba | O que tem | Rotas do Klingo |
|---|---|---|
| **Marcar** | consulta ou exame, convênio/plano, período (até 31 dias), horários por médico/unidade/turno, entrar ou cadastrar paciente novo, segura o horário 10 min, valor de tabela, recado, confirmar, remarcar | `/agenda/horarios`, `/agenda/reservar`, `/agenda/horario`, `/preco`, `/agenda/especialidades`, `/agenda/exames`, `/convenios`, `/paciente/cpf`, `/externo/login`, `/externo/register` |
| **Minhas marcações** | lista, cancelar, remarcar, trocar procedimento, check-in e desfazer, ver resultado, **resultado de imagem pelo número de acesso** | `/vouchers`, `/voucher`, `/agenda/procedimento`, `/checkin`, `/resultado/{id}`, `/resultado/pdf/an/{número}` |
| **Meus dados** | cadastro (contato mascarado), atualizar celular/telefone/e-mail, autorizações do convênio | `/paciente`, `PUT /paciente`, `/autorizacoes` |
| **Consultar a clínica** | unidades, especialidades, consultas, exames, convênios (e por CNPJ), médicos, preço, tabela de preços, recepções, coleta domiciliar, procedimentos de um horário, **verificar horário**, requisição | catálogos e `/agenda/verificar_horario` |
| **Equipe** (v1.1) | totais dos atendimentos do dia (por médico, plano e procedimento) e a API de Confirmação (telefonia: no ar, marcações do dia, uma marcação, bloqueios, confirmar, NPS). Só com a chave da equipe | `/atendimentos`, `/telefonia/*` |
| **Sobre a API** | mapa de tudo o que a API faz, o que a página usa e o que ficou de fora | — |

## O que ficou de fora de propósito

| Rota | Por quê |
|---|---|
| `/adiantamento(s)`, `/pagamento(s)`, `/registrar_atendimento`, `/formas_de_pagamento` | Mexem em dinheiro; o guia manda validar com o suporte do Klingo antes |
| `/webhook-configurado` | É o Klingo que chama a clínica. O receptor já existe (função `klingo-webhook`); falta o Klingo cadastrar o endereço |
| Telefonia: `/lista_ultimo_por_cpf` e `/entrada` | A primeira recebe uma lista de CPFs de pacientes (GET com corpo) e a segunda é a central telefônica avisando uma chamada: nenhuma é ação da página |

## O que entrou na 1.1 (pedido do dono, 13/11/2026) e como foi protegido

| Recurso | Como fica | Proteção |
|---|---|---|
| `/agenda/verificar_horario` | aba Consultar | só leitura; a doc pede um corpo num GET, a função manda `id` na consulta (**não testado**) |
| `/resultado/pdf/an/{número}` | aba Minhas marcações | exige CPF + nascimento; usa o **mesmo interruptor do laudo** (`AGENDAMENTO_RESULTADO=1`, desligado); `dtnasc` vai na consulta (**não testado**) |
| `/paciente/identificar` (telefone) | “Como quer entrar?” → Telefone | **DESLIGADO**: liga com `AGENDAMENTO_TELEFONE=1`. Sempre com nascimento (nunca `apenas_telefone`); sessão conferida (nascimento da sessão = o digitado); 5 recusas por telefone em 1 h travam (só hash na `klingo_identidade`). Risco que continua: dois cadastros com o mesmo telefone e o mesmo nascimento (gêmeos) |
| `/externo/portal/register`, `/login`, `/recuperar` | “Criar conta com e-mail e senha”, “E-mail e senha do portal”, “Esqueci a senha” | **DESLIGADO**: liga com `AGENDAMENTO_PORTAL=1`. O cadastro usa a mesma trava por CPF e o mesmo teto de 40/dia; 5 senhas erradas por e-mail travam 1 h (a senha nunca é guardada); “esqueci a senha” responde igual exista ou não a conta e tem freio de 3 por e-mail e 30 no total por hora (**na memória da instância**, freio simples) |
| `/atendimentos` | aba Equipe | só com a chave da equipe (`AGENDAMENTO_EQUIPE_CHAVE`, mínimo 20 caracteres, cabeçalho `x-equipe-chave`, comparação em tempo constante); a função devolve **só totais** (médico, plano, procedimento): nunca nome, CPF, mãe, endereço ou telefone |
| `/telefonia/*` | aba Equipe | mesma chave; a lista e a marcação saem **sem** nome, CPF, telefone e id de paciente; confirmar e NPS pedem confirmação, e o status N (que cancela a marcação) pede uma segunda. A API respondeu 404 em 12/11/2026: provavelmente **não está habilitada** para a CSI (**nada testado**) |

**Como ligar** (Supabase > Edge Functions > `klingo-agendamento` > Secrets: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions): crie só os que quiser. Sem o secret, o recurso responde “ainda não foi liberado”.

**Antes de ligar o telefone e o portal**, decidir: telefone + nascimento é uma identificação **mais fraca** que CPF + nascimento (e a página deixa cancelar marcação). A conta do portal tem a senha como segredo, mas o Klingo não deixa claro se limita tentativas de senha: só a trava da função protege.

## Travas de segurança (todas com teste)

1. **Cinco nascimentos errados para o mesmo CPF em 1 hora travam o CPF** (`429 tentativas_demais`). Conta as linhas `divergente` da `klingo_identidade`. A resposta de "CPF não existe" e "nascimento errado" é igual, para a página não revelar quem é paciente.
2. **Só mexe em marcação ativa do próprio paciente:** cancelar, remarcar, trocar procedimento, check-in e resultado conferem o voucher na lista `/vouchers` da sessão dele.
3. **Pré-cadastro uma vez por CPF:** a API do Klingo aceita registrar o mesmo CPF duas vezes. A função grava uma marca na `klingo_identidade` (índice único por CPF) **antes** de registrar; se a resposta se perder, a marca fica e a recepção confere (nunca registra de novo). Teto de **40 pré-cadastros por dia**.
4. **Login de pré-cadastro sem a letra P** e com conferência de id e nascimento da sessão (com `P` o Klingo abre outro paciente).
5. **Marcar com resposta perdida:** reconcilia pelas marcações ativas (`id_externo` = `pagina-…`); se não achar, responde "incerto" e **não tenta de novo**.
6. **Cota global do Klingo** antes de cada chamada, mas esta função espera pouco (até ~4 fichas × 2 s) e responde `429` para nunca segurar as rotinas internas. Catálogos ficam 60 s em memória e horários 20 s.
7. Nunca devolve corpo de erro do Klingo; CPF, RG, foto e contato de profissional são retirados dos catálogos; contato do paciente volta mascarado; nada de paciente vai para log.
8. **Resultado de exame vem DESLIGADO.** Em 03/11/2026 o dono decidiu que link e senha do resultado são passados pela equipe. Para ligar, crie o secret `AGENDAMENTO_RESULTADO` = `1` na função. Sem isso, a ação responde `desligado`.

## Riscos que continuam (decisões do dono)

- **CPF + nascimento é uma identificação fraca.** É a mesma que o chat usa para marcar, mas esta página também deixa **cancelar** a marcação de alguém que tenha esses dois dados. Por isso o resultado de exame está desligado.
- **Quem erra 5 vezes tranca o CPF por 1 hora**, inclusive o dono verdadeiro, se alguém ficar tentando. É o preço da trava.
- **Não há limite por aparelho/IP.** O limite é por CPF, pela cota global do Klingo e pelo teto diário de cadastros. Se houver abuso, o caminho é um limite no Supabase/Cloudflare ou um teste anti-robô na página.
- **Pré-cadastro falso** (alguém inventando CPFs válidos): o teto de 40/dia limita o estrago; a recepção continua juntando duplicados.

## O que NÃO foi provado com o Klingo de verdade

A página e a função foram testadas com um Klingo de mentira (dados inventados). **Não foi feita nenhuma chamada real ao Klingo**, e a função ainda não foi publicada. Estão marcadas como "não testado" na tela as rotas que o `GUIA-COMPLETO.md` (itens 2.5, 2.6 e 5.1) lista como nunca exercitadas: check-in no dia, desfazer check-in, laudo pronto, e-mail de confirmação, requisição e o envio exato do `PUT /paciente` (a função manda `{"paciente":{"contatos":{…}}}`, que segue o padrão do `register`). Os nomes dos campos dos catálogos (`/convenios`, `/agenda/especialidades`) foram lidos do guia; a página tem alternativas se algum nome for diferente e mostra o JSON bruto na aba Consultar.

## Testes

- `supabase/functions/klingo-agendamento/agendamento.test.ts` (40 testes, dentro de `npm run test:edge`): Klingo de mentira e banco em memória; inclui trava de tentativas, sessão trocada, voucher de outro paciente, pré-cadastro sem duplicar, resposta perdida e rotas de dinheiro inexistentes. Conferido por mutação: desligar a trava, o dono do voucher ou o login sem `P` faz teste falhar.
- `testes/agendamento.navegador.mjs` (`npm run test:agendamento`, 20 verificações): a página em Chromium com a função simulada; confere o que a página envia e mostra, injeção de HTML vinda da API e privacidade do CPF.
- `testes/sw.test.mjs`: `/agendamento/` não passa pelo cache do chat (o `sw.js` do chat controla o site todo e serviria o chat no lugar da página). `VERSAO` do `sw.js` do chat foi a `webchat-cliente-v38`.

## Para colocar no ar (passos do dono)

1. **Publicar a função** `klingo-agendamento` com `verify_jwt=false`: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions (usa o secret `KLINGO_APP_TOKEN` que já existe).
2. **Testar de verdade, com um paciente que autorize**: horários (só leitura), depois uma marcação e o cancelamento logo em seguida (avisar o call center). Ver `GUIA-COMPLETO.md`, item 8.
3. **Publicar a página** (junta na `main`; o GitHub Pages serve `/agendamento/`).
4. Decidir se liga o resultado de exame (`AGENDAMENTO_RESULTADO=1`) e se quer algum limite por aparelho.
