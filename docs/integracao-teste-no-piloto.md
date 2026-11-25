# Tela do teste (v20261125a) no piloto, marcando de verdade

Versão 1.0 — 25/11/2026 / Mudança: primeira fase construída e publicada; ligada só com `marcacao_etapas_modo = 'teste'` e só para os telefones de `marcacao_etapas_telefones`.

## O que é
A tela do ambiente de teste (`painel/testedowebchat/`: `marcacao.js`, `marcacao.css`, `agenda-real.js`) foi copiada para a raiz do site e ligada ao **motor real** do banco por `integracao-real.js`. A tela é a mesma do teste (mesma ordem: pagamento, convênio, plano, carteirinha, consulta, médico, horário, condições, resumo). Só mudou o fim: no "Confirmar marcação", `marcar()` conduz o motor (consulta, médico, plano, horário, confirmar) com as travas de sempre (PIN, retorno em menos de 30 dias, unidade autorizada, médico escolhido nunca trocado).

Quando o motor pergunta algo que a tela do teste não sabe responder, **a conversa continua na tela por etapas (`etapas.js`), na mesma conversa**, sem perder nada.

## Como ligar e desligar
- Ligar: `update public.config set valor = 'teste' where chave = 'marcacao_etapas_modo';`
- Voltar para a tela por etapas de produção: valor `piloto`. Voltar ao chat de sempre: `nao`.
- Os telefones do piloto ficam em `marcacao_etapas_telefones` (hoje só o do dono).

## O que funciona na fase 1
- Tela e ordem iguais ao teste; horários e médicos reais do Klingo (leitura).
- Marcação real pelo motor quando o cadastro está completo, o plano é Particular ou convênio da lista e o horário ainda existe.
- Voltar na primeira pergunta e "Fazer outra marcação" levam ao menu principal.
- "Acompanhar" abre "Acompanhe seus pedidos" (`minha-vez/?acompanhar=1`), onde o cancelamento real já existe.

## Feito na fase 2 (25/11/2026)
- **Pré-marcação real** pela tela do teste: a ciência é gravada no servidor (`marcacao_ciencia_registrar`) e o motor recebe "Não sei" (convênio ou plano), "Nenhum horário serve" ou "Não tenho a carteirinha agora", levando o pedido para a equipe. "Não, obrigado" vira pedido de atendente.
- **Foto da carteirinha** enviada à conversa (`chat_anexo_enviar`) quando a pessoa anexa.
- **Valor Particular**: a tela do teste mostra o valor do motor, com "Concordo e quero marcar" e "Não quero".
- **Cancelar e remarcar**: "Acompanhar" abre "Acompanhe seus pedidos", que já cancela e remarca de verdade. O "remarcar até 2 vezes" e o "Completar agora" simulados do teste não existem aqui.

## Pendências (anotadas)
1. **Dados do cadastro** (endereço, contato, sexo) quando faltam: a tela por etapas assume. A tela do teste não tem essas perguntas.
2. **Previsão de marcação** (perguntas de turno, período e antecedência que o motor faz depois da pré-marcação): a tela por etapas assume.
3. **Leituras abertas**: a tela usa `teste-agenda-klingo` e `teste-planos-klingo` (funções abertas, só leitura) para listar médicos, horários e planos antes de existir a marcação. Trocar por `chat-agenda-api`/`chat_horarios` exige conduzir o motor passo a passo durante as perguntas, não só no fim. **Não apagar essas funções antes.**
4. **Antecedência de 24 h e política de cancelamento** do teste valem só como filtro e texto da tela; o motor tem as suas regras. Conferir se coincidem.
5. **Retrato do banco** (`supabase/producao/`) não foi refeito para `marcacao_etapas_pode`, `marcacao_ciencia_registrar`, `chat_config` e a tabela `marcacao_ciencia` (procedimento em `supabase/producao/LEIAME.md`, `parcial.py`).
6. **Teste contra o banco real**: só foi feito com o motor simulado e com a tela em página isolada. A primeira marcação e a primeira pré-marcação reais são o teste de verdade.
