# TesteWebchat — sistema de marcação por etapas (homologação)

Endereço: https://clinicacsiia.github.io/webchat/painel/testedowebchat/ · **só homologação; nada aqui vai para a produção sem autorização do dono.**

## O que o paciente vê
Tela inicial e identificação de quem será atendido (como antes) → **Começar** abre o sistema de marcação, sem balões de conversa:

| Etapa | O que acontece |
|---|---|
| (início) | Vai direto para a escolha da consulta: sem pergunta "O que você precisa?", sem Exame e sem "Outro assunto" (o atendente continua no botão do topo) |
| Procedimento | Lista com busca; procedimento **desativado** (pela configuração) aparece marcado "agendado pela equipe" e segue como pré-marcação |
| Pagamento | Particular (mostra valor), Convênio ou **Não sei** |
| Convênio / Plano | Listas + **Não sei** |
| Carteirinha | Foto (câmera ou galeria) ou "Não tenho agora" (vira pré-marcação) |
| Horário | Dias e horários vindos da integração simulada; **regra de antecedência** (24 h, configurável) esconde o que é mais próximo |
| Pré-marcação | Só aparece quando não dá para concluir: **Sim/Não**, período e dias |
| Condições | Cancelamento e remarcação, com aceite |
| Resumo | Tudo com "Corrigir" em cada linha; diz se será **MARCAÇÃO** ou **PRÉ-MARCAÇÃO** |
| Resultado | Selo verde "MARCAÇÃO confirmada" ou amarelo "PRÉ-MARCAÇÃO registrada", com protocolo |

Barra de progresso, Voltar/Continuar sem perder dados (o estado fica guardado), **Acompanhar solicitações** (remarcar até 2 vezes, cancelar) e (Botão "Falar com atendente" retirado a pedido do dono em 24/11/2026.) O botão "Previsão de marcação" foi retirado.

## Arquitetura (arquivos)
- `index.html`: tela inicial/identificação (reaproveitada). O "Começar" chama `CSI_MARCACAO.abrir(...)` em vez de abrir a conversa.
- `marcacao.js` / `marcacao.css`: interface das etapas, acompanhamento e atendimento humano (separados do chat antigo, que continua no arquivo mas não é usado neste ambiente).
- `integracao-simulada.js`: **toda** a regra e os dados fictícios (catálogo, convênios, horários, regra de antecedência, ativação, política de cancelamento, solicitações). Sem rede. É o único ponto a trocar pela integração real; a tela não conhece regra de negócio.
  - `catalogo` ~ `chat_exames_buscar`/`chat_consultas` · `disponibilidade` ~ `chat_horarios`/`chat-agenda-api` · `marcar` ~ `chat_horario_escolher` + `klingo-executar` · `solicitacoes` ~ "Acompanhe seus pedidos".

## Segurança deste ambiente
- Dados 100% fictícios, guardados só no navegador (`teste_*`); apagar em **⚙ Configurar teste > Apagar dados do teste**.
- A rede para o Supabase é barrada na própria página: **só `chat_config` (leitura)** passa. Sem RPC, sem login, sem Edge Function, sem push, sem service worker. Nada chega ao Klingo nem ao banco, e nenhum aviso real é disparado.
- Faixa laranja "AMBIENTE DE TESTE" sempre visível.

## Configurar o teste (faixa laranja > ⚙)
Antecedência (sem regra, 24, 48, 72 h) · exigir carteirinha · simular agenda fora do ar · ativar/desativar cada procedimento.

## Limites / próximos passos
- Reaproveitar o motor de regras do banco (`fluxo_*`, `klingo_*`) exige trocar `integracao-simulada.js` por chamadas reais, o que só deve ocorrer com um banco de homologação (hoje só existe a produção).
- Regras de negócio mostradas (lista de procedimentos, convênios, política de cancelamento) são exemplos para validação com a diretoria.

## Lista de consultas
Copiada da produção em 24/11/2026 (`consultas_da_unidade('DESENVOAR')`): pediatra, cirurgia pediátrica, ortopediatra, endocrinopediatra, gastropediatra, neuropediatra e pediátrica pré-natal. Sem valor particular (o chat real não mostra nesta etapa). Se a lista mudar em produção, atualizar `CATALOGO` em `integracao-simulada.js`.

## Horários e médicas (24/11/2026)
- Passo novo **Qual médica?** (ou "Tanto faz"), com as médicas reais de cada consulta.
- Os horários agora vêm da **grade real de atendimento** das médicas (`agenda-real.js`: dia da semana, início, fim, duração da consulta, consultório e vigência), lida da produção em modo **somente leitura** (`catalogo_agenda`, unidade Desenvoar). Sem dado de paciente.
- **Limite importante:** é a grade, não a disponibilidade ao vivo do Klingo: não desconta horários já ocupados. A tela avisa isso. A disponibilidade ao vivo (`chat-agenda-api`) exige abrir uma conversa no banco de produção e está bloqueada neste ambiente.
- Para atualizar o snapshot, reler `catalogo_agenda` e regerar `agenda-real.js`.

## Opções que vão diminuindo (24/11/2026)
Ordem: **consulta → pagamento → convênio → plano → carteirinha → médica → horário**. A cada clique a lista seguinte encolhe:
- As escolhas feitas aparecem como chips no topo (✎ = tocar para corrigir).
- **Convênio:** os nomes vêm das restrições reais das agendas (`catalogo_agenda.operadoras`). A lista de **médicas** mostra só quem atende aquele convênio (ou Particular), com o número de horários de cada uma.
- **Horário:** só os da(s) médica(s) restantes, com filtros **Manhã/Tarde** e **dias da semana** e um contador ("80 horários em 8 dias").
- Sem médica ou sem horário que sirva: oferece a **pré-marcação** (Sim/Não).
- Plano: texto livre ou "Não sei" (a lista real tem ~4.700 planos; não cabe neste teste).

Suposições a confirmar com a clínica: agenda sem restrição de operadora (`operadoras` vazio) = **aceita qualquer convênio**; a tabela `medico_convenio_bloqueio` **não** é usada (ela contradiz a agenda para algumas médicas, ex.: Geanne e SulAmérica).

## Regra "não sei" → pré-marcação (24/11/2026)
Qualquer "Não sei" (pagamento, convênio ou plano) ou "Não tenho agora" (carteirinha) leva **direto** à pré-marcação: o sistema não pergunta mais nada (nem médica nem horário), mostra a lista **"A equipe precisa confirmar"** (pendências), pergunta Sim/Não e segue para condições e resumo. A lista aparece também no resumo, no resultado e em "Suas solicitações". Quem sabe tudo continua: médica → horário → marcação. A barra de progresso se ajusta (ex.: "Etapa 3 de 5").

## Nova ordem (24/11/2026)
**Pagamento (Particular / Convênio / Não sei) é a 1ª pergunta**, porque limita tudo: pagamento → convênio → plano → carteirinha → **consulta** → médica → horário. Com o pagamento conhecido, a lista de consultas mostra só as que têm médica para ele (com número de médicas e de horários); as sem médica ficam no fim, marcadas "pré-marcação". "Não sei" ainda pede a consulta e vai à pré-marcação com a lista de pendências.

## Horários REAIS do Klingo (24/11/2026) — substitui a grade
Os horários e as médicas agora vêm **ao vivo da API do Klingo** pela Edge Function nova **`teste-agenda-klingo`** (`supabase/functions/teste-agenda-klingo/index.ts`), publicada em 24/11/2026 a pedido do dono (opção B).
- **Só leitura:** consulta `GET /agenda/horarios`; não marca, não reserva, **não grava nada no banco** (só lê `klingo_especialidade` e chama `klingo_plano_resolver`, que é `STABLE`); sem dado de paciente.
- **Proteções:** só responde à origem `https://clinicacsiia.github.io`; limite de 20 consultas/min por IP; cache de 60 s; janela de 14 dias (a tela pede 2 janelas = 28 dias); não usa a cota global (que grava no banco). Usa o mesmo segredo `KLINGO_APP_TOKEN` das outras funções, então as consultas dividem a cota do Klingo com o chat real.
- **O que a API oferece:** só Pediatria (inclui pré-natal), Neurologia (neuropediatra) e Radiologia (`klingo_especialidade.liberada_api`). Ortopediatra, endócrino, gastro e cirurgia pediátrica **não têm horário na API**: seguem como pré-marcação (equipe).
- **Convênio:** a lista é a do `klingo_plano_map` (26 operadoras que a clínica atende). Seis delas (Amor Saúde, Bradesco x2, Central Nacional Unimed, SulAmérica, Unimed Seguros) precisam do **plano do cadastro do paciente** para consultar horário (`plano_do_cadastro_necessario`): neste teste, que não tem CPF/cadastro, caem na **pré-marcação**.
- A marcação continua **simulada** (nada é reservado no Klingo) e os dados do paciente continuam fictícios.
- `agenda-real.js` agora só guarda a lista de convênios e quais consultas a API oferece; a grade foi removida.
