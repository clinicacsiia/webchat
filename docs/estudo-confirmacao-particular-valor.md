# Estudo: confirmação do valor para paciente Particular (16/11/2026)

Pedido do dono: quando o paciente escolhe **Particular**, antes de marcar deve existir uma tela que mostre o **valor em destaque**, para ele marcar sabendo quanto vai pagar. Se não quiser por causa do valor, não marca; se aceitar, confirma e a marcação segue. Vale **só para Particular**.

Nada foi alterado no banco nem nas telas. Este é só o estudo.

## 1. Como é hoje

Caminho do motor (`fluxo_proximo`): ... → `plano` → `horario` → `dados_ident` → `dados_contato` → **`confirmar`** → `pronto`/`marcando`.

- O passo `confirmar` (`fluxo_perguntar`) mostra o resumo (`fluxo_leitura`: exames, médico, plano, horário, dados) e os botões *Está tudo certo / Corrigir o exame / o plano / o horário / os dados*. **Não mostra valor nenhum.**
- O valor só aparece se o paciente **perguntar** "quanto custa" (`fluxo_avancar` chama `preco_previsao_chat`). Essa função só responde se o preço do exame foi **revisado e ligado** pelo administrador (`catalogo_preco_revisao`, `ligado = true`).
- Existe também `preco_referencia_pedido` (lê `catalogo_preco`, fonte `particular`, confiança alta/média), usada pela equipe.
- Ao tocar "Está tudo certo", `fluxo_aplicar` grava `confirmado = true` e `fluxo_proximo` devolve `pronto`; `fluxo_finalizar` envia o pedido à equipe ou, com `klingo_api_marcar` (hoje `sim`), cria a operação e a marcação automática roda.

## 2. O que o banco tem de preço Particular (medido hoje, só contagens)

| Medida | Valor |
|---|---|
| Procedimentos no catálogo | 2.153 |
| Com preço Particular confiável (`catalogo_preco`, alta/média) | 125 |
| Com preço revisado e ligado (`catalogo_preco_revisao`) | **0** |
| Exames diferentes já pedidos no chat | 27 |
| ...desses, com preço Particular confiável | **10** (138 de 353 itens, 39%) |
| Pedidos já feitos como Particular | 27 de 353 |

**Conclusão:** a tela do valor é fácil de construir; o obstáculo é o **dado**. Hoje 6 de cada 10 itens pedidos não têm preço confiável. E a pendência do Klingo (onde fica o preço Particular; `docs/klingo-relatorios-pendentes.md`, pergunta 1) segue sem resposta: o preço vem de dedução das marcações, não de relatório oficial. Nenhum relatório novo é necessário para a tela; um melhor ajuda a cobrir mais exames.

## 3. Desenho proposto

Novo passo do motor, **`confirmar_valor`**, entre `confirmar` ("Está tudo certo") e o envio:

```
confirmar (ok) ──► plano é Particular?
                     ├─ não ──► pronto (como hoje)
                     └─ sim ──► valor de TODOS os exames conhecido?
                                  ├─ sim ─► confirmar_valor  (tela com o valor em destaque)
                                  │           ├─ "Sim, aceito o valor e quero marcar" ─► pronto / marcando
                                  │           └─ "Não quero marcar" ─► pedido fica sem marcar; mensagem educada
                                  └─ não ─► NÃO marca sozinho: vai para a equipe informar o valor
```

### 3.1 A tela (chat, `index.html`)
Cartão novo no widget de escolha, com:
- título "Valor do atendimento Particular";
- **valor total em fonte grande** (R$ 000,00), e abaixo a lista por exame (e "2x" quando for os dois lados);
- aviso curto: "Valor para pagamento Particular. A forma de pagamento é combinada na clínica." (texto revisado pelo dono);
- dois botões: **"Sim, concordo com o valor e quero marcar"** (principal) e **"Não quero marcar por causa do valor"**;
- o texto do valor sai do **banco** (não do navegador), assim o que o paciente viu fica gravado.

### 3.2 O que fica gravado (prova de que o paciente viu e aceitou)
Em `conversa_fluxo.dados`: `valor_confirmado = {total, itens, em}` e, na linha do tempo da conversa, o evento "Paciente aceitou o valor R$ X". Se recusar: `valor_recusado` + nota para a equipe. O pedido enviado à equipe carrega o valor aceito.

### 3.3 Regras importantes
1. **Só Particular** (`norm_chave(plano) like 'PARTICULAR%'`). Convênio não muda nada.
2. **Sem valor confiável, nunca inventar.** Exame sem preço (ou preço dividido entre faixas) → a marcação automática **não roda**; o paciente é avisado "o atendente vai informar o valor antes de marcar" e o pedido vai para a equipe. Isso é conservador, mas é o que impede dizer um valor errado.
3. **Pedido com vários exames:** o total só aparece se **todos** têm preço; senão vai tudo para a equipe.
4. **Mudou algo depois** (corrigiu exame, plano ou horário): o valor aceito é descartado e a tela volta a aparecer.
5. **Recusa:** a conversa não é encerrada à força; o paciente escolhe entre corrigir o exame, trocar o plano (ex.: convênio) ou desistir. Desistir marca o pedido como cancelado pelo paciente com o motivo "valor", que passa a ser um indicador útil.
6. **Fonte do valor:** preferir o preço **revisado e ligado** (`catalogo_preco_revisao`); se não houver, `catalogo_preco` com confiança alta. Média só depois de o dono aprovar.
7. **Interruptor** `particular_valor_modo` em `config`: `nao` (como hoje) / `teste` (só telefones de teste) / `sim`. Entra em `nao`.

### 3.4 Onde mexer (arquivos)
| Peça | Mudança |
|---|---|
| Banco (arquivo novo `supabase/particular-valor-confirmar.sql`) | função `preco_particular_valor(conversa)` (devolve total, itens, ou nulo); passo `confirmar_valor` em `fluxo_proximo`, `fluxo_perguntar`, `fluxo_aplicar`; texto em `fluxo_texto`; chave em `config`; recusa em `fluxo_voltar_passo` |
| `fluxo_finalizar` | não criar a operação do Klingo sem `valor_confirmado` quando o plano é Particular |
| Chat `index.html` | destaque visual do valor no widget de escolha (tipo novo `valor`); trocar `VERSAO_APP` e `sw.js` |
| Painel | mostrar "Valor aceito pelo paciente: R$ X" no cartão do pedido |
| Testes | `sql-particular-valor.test.mjs` (aceita, recusa, sem preço, vários exames, convênio inalterado, mudou algo) + teste de navegador do cartão |
| Retrato | refazer `supabase/producao/` e `npm run test:retrato` |

## 4. Riscos
- **Cobertura do preço (principal):** com 10 de 27 exames cobertos, a maioria dos Particulares cairia na equipe até o catálogo ser revisado. Sugestão: o dono revisa e liga na aba **Catálogo > Cardápio** os exames mais pedidos (a lista dos 27 sai de uma consulta) antes de ligar o interruptor.
- Preço antigo: o valor aceito é o do momento; se o Klingo cobrar outro, a conferência já existente (`alerta_preco_conferir`) pode avisar a equipe.
- Quem usa a conta com pessoa menor: o valor aparece para o responsável que está no chat; sem mudança.

## 5. Decisões que dependem do dono
1. Se o valor **não** for conhecido, está certo mandar para a equipe (recomendado) ou prefere marcar mesmo assim com aviso?
2. Texto do aviso abaixo do valor (forma de pagamento: PIX, cartão, na recepção?).
3. Quem recusar: só encerrar com "desistiu pelo valor" ou oferecer logo a troca para convênio?
4. Revisar/ligar os preços dos exames mais pedidos antes de ativar.
