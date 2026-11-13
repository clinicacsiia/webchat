# Página de agendamento (`/agendamento/`)

Versão 1.0 — 13/11/2026 / Mudança: primeira versão. Página pública com tudo o que a API externa do Klingo permite, menos dinheiro. Fonte das regras: `docs/klingo-api-externa/GUIA-COMPLETO.md`.

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
| **Minhas marcações** | lista, cancelar, remarcar, trocar procedimento, check-in e desfazer, ver resultado | `/vouchers`, `/voucher`, `/agenda/procedimento`, `/checkin`, `/resultado/{id}` |
| **Meus dados** | cadastro (contato mascarado), atualizar celular/telefone/e-mail, autorizações do convênio | `/paciente`, `PUT /paciente`, `/autorizacoes` |
| **Consultar a clínica** | unidades, especialidades, consultas, exames, convênios (e por CNPJ), médicos, preço, tabela de preços, recepções, coleta domiciliar, procedimentos de um horário, requisição | catálogos |
| **Sobre a API** | mapa de tudo o que a API faz, o que a página usa e o que ficou de fora | — |

## O que ficou de fora de propósito

| Rota | Por quê |
|---|---|
| `/adiantamento(s)`, `/pagamento(s)`, `/registrar_atendimento`, `/formas_de_pagamento` | Mexem em dinheiro; o guia manda validar com o suporte do Klingo antes |
| `/atendimentos` | Devolve nome, CPF, mãe, endereço e telefone de **todos** os pacientes do dia |
| `/paciente/identificar` (só telefone) | Telefone é fácil de saber; usamos CPF + nascimento |
| `/externo/portal/*` | Cria conta de portal e dispara e-mail; não é preciso para marcar |
| `/resultado/pdf/an/{n}`, `/agenda/verificar_horario` | GET com corpo, nunca testado |
| `/webhook-configurado` | É o Klingo que chama a clínica; não é ação da página |

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

## O que foi e o que NÃO foi provado com o Klingo de verdade

**Função publicada em 13/11/2026** (`klingo-agendamento`, versão 2, `verify_jwt=false`). Provado ao vivo, só com leitura e sem dado de paciente: CORS da página (`clinicacsiia.github.io`), `versao` (API no ar), ação inexistente (400), CPF inválido (400, barrado antes do Klingo), resultado desligado, `catalogo` (unidades, especialidades, convênios, consultas, exames, preço) e `horarios` (29 horários de neurologia). Os nomes dos campos dos catálogos conferem com o que a página espera.

**Ainda não exercitado de verdade:** entrar com CPF, marcar, remarcar, cancelar, cadastrar paciente novo, check-in, meus dados e resultado. Esses foram testados só com um Klingo de mentira (dados inventados). Estão marcadas como "não testado" na tela as rotas que o `GUIA-COMPLETO.md` (itens 2.5, 2.6 e 5.1) lista como nunca exercitadas: check-in no dia, desfazer check-in, laudo pronto, e-mail de confirmação, requisição e o envio exato do `PUT /paciente` (a função manda `{"paciente":{"contatos":{…}}}`, que segue o padrão do `register`).

## Testes

- `supabase/functions/klingo-agendamento/agendamento.test.ts` (29 testes, dentro de `npm run test:edge`): Klingo de mentira e banco em memória; inclui trava de tentativas, sessão trocada, voucher de outro paciente, pré-cadastro sem duplicar, resposta perdida e rotas de dinheiro inexistentes. Conferido por mutação: desligar a trava, o dono do voucher ou o login sem `P` faz teste falhar.
- `testes/agendamento.navegador.mjs` (`npm run test:agendamento`, 14 verificações): a página em Chromium com a função simulada; confere o que a página envia e mostra, injeção de HTML vinda da API e privacidade do CPF.
- `testes/sw.test.mjs`: `/agendamento/` não passa pelo cache do chat (o `sw.js` do chat controla o site todo e serviria o chat no lugar da página). `VERSAO` do `sw.js` do chat foi a `webchat-cliente-v37`.

## Para colocar no ar (passos do dono)

1. ~~Publicar a função~~ (feito em 13/11/2026; painel: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions).
2. **Testar de verdade, com um paciente que autorize**: entrar com CPF, uma marcação e o cancelamento logo em seguida (avisar o call center). Ver `GUIA-COMPLETO.md`, item 8.
3. **Publicar a página** (junta na `main`; o GitHub Pages serve `/agendamento/`).
4. Decidir se liga o resultado de exame (`AGENDAMENTO_RESULTADO=1`) e se quer algum limite por aparelho.
