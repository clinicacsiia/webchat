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

## Pendências (anotadas)
1. **Pré-marcação** (não sei o plano, nenhum horário serve, sem carteirinha): a tela do teste faz a pergunta, mas o envio real ainda vai pela tela por etapas. Falta ligar a ciência (`marcacao_ciencia_registrar`) e o envio ao motor/painel direto da tela do teste.
2. **Foto da carteirinha**: a tela do teste guarda a foto no aparelho e ela **não é enviada**. Falta usar `chat_anexo_enviar`. Com convênio, o motor pede o número da carteirinha e a tela por etapas assume.
3. **Valor Particular**: o motor exige que o paciente concorde com o valor; a tela do teste não mostra. Hoje a tela por etapas assume nesse passo.
4. **Dados do cadastro** (endereço, contato, sexo) quando faltam: a tela por etapas assume.
5. **Cancelar e remarcar** dentro da tela do teste (hoje "Acompanhar" abre "Acompanhe seus pedidos"). "Remarcar até 2 vezes" e "Completar agora" do teste continuam simulados e estão desligados aqui.
6. **Leituras abertas**: a tela usa `teste-agenda-klingo` e `teste-planos-klingo` (funções abertas, só leitura). Não apagar essas funções antes de trocar por `chat-agenda-api`/`chat_horarios` (pendência 8 da seção 2.22).
7. **Antecedência de 24 h e política de cancelamento** do teste valem só como texto e filtro da tela; o motor tem as suas regras. Conferir se coincidem.
8. **Retrato do banco** (`supabase/producao/`) não foi refeito para as funções `marcacao_*`.
9. **Teste no navegador contra o banco real**: só foi testado com o motor simulado (`marcar()` com respostas combinadas) e com a tela em página isolada. A primeira marcação real é o teste de verdade.
