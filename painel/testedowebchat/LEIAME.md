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

Barra de progresso, Voltar/Continuar sem perder dados (o estado fica guardado), **Acompanhar solicitações** (remarcar até 2 vezes, cancelar) e **Falar com atendente** em todas as telas. O botão "Previsão de marcação" foi retirado.

## Arquitetura (arquivos)
- `index.html`: tela inicial/identificação (reaproveitada). O "Começar" chama `CSI_MARCACAO.abrir(...)` em vez de abrir a conversa.
- `marcacao.js` / `marcacao.css`: interface das etapas, acompanhamento e atendimento humano (separados do chat antigo, que continua no arquivo mas não é usado neste ambiente).
- `integracao-simulada.js`: **toda** a regra e os dados fictícios (catálogo, convênios, horários, regra de antecedência, ativação, política de cancelamento, solicitações). Sem rede. É o único ponto a trocar pela integração real; a tela não conhece regra de negócio.
  - `catalogo` ~ `chat_exames_buscar`/`chat_consultas` · `disponibilidade` ~ `chat_horarios`/`chat-agenda-api` · `marcar` ~ `chat_horario_escolher` + `klingo-executar` · `solicitacoes` ~ "Acompanhe seus pedidos".
- Atendimento humano: a tela dispara o evento `csi:atendimento-humano` (com o resumo da marcação). Em produção, um ouvinte desse evento abre o atendimento atual da equipe.

## Segurança deste ambiente
- Dados 100% fictícios, guardados só no navegador (`teste_*`); apagar em **⚙ Configurar teste > Apagar dados do teste**.
- A rede para o Supabase é barrada na própria página: **só `chat_config` (leitura)** passa. Sem RPC, sem login, sem Edge Function, sem push, sem service worker. Nada chega ao Klingo nem ao banco, e nenhum aviso real é disparado.
- Faixa laranja "AMBIENTE DE TESTE" sempre visível.

## Configurar o teste (faixa laranja > ⚙)
Antecedência (sem regra, 24, 48, 72 h) · exigir carteirinha · simular agenda fora do ar · ativar/desativar cada procedimento.

## Limites / próximos passos
- Reaproveitar o motor de regras do banco (`fluxo_*`, `klingo_*`) exige trocar `integracao-simulada.js` por chamadas reais, o que só deve ocorrer com um banco de homologação (hoje só existe a produção).
- Regras de negócio mostradas (lista de procedimentos, convênios, política de cancelamento) são exemplos para validação com a diretoria.
