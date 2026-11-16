# Valor do atendimento Particular antes de marcar (16/11/2026)

Pedido do dono: quando o paciente escolhe **Particular**, antes de marcar ele vê o **valor em destaque** e decide. Concordou = o chat segue (e marca sozinho, se for o caso). Não quis = vai para o atendente, que é avisado de que o paciente **recusou o valor**, e **nada é cadastrado no Klingo**. Se a API não trouxer o preço, o chat diz que a assistência pode informar e pergunta se o paciente quer saber o valor; isso fica **pendente para a equipe responder**, também sem cadastrar no Klingo.

**No ar desde 16/11/2026** (`config.particular_valor_modo = sim`). Para desligar na hora: `update public.config set valor = 'nao' where chave = 'particular_valor_modo';` (tudo volta ao jeito de antes). Nenhum relatório do Klingo é usado ou precisa ser criado: o preço vem da **API externa**.

## Como funciona

```
plano Particular escolhido ──► o banco pede à API (assíncrono) o preço de cada exame do pedido
...horário, dados, "Está tudo certo"...
                              ──► passo `valor`
        todos os itens com preço ──► cartão com o VALOR TOTAL grande + [Concordo e quero marcar] [Não quero marcar por causa do valor]
              concordou  ─► segue (marcação automática, se liberada) e grava "ACEITOU R$ X"
              recusou    ─► atendente avisado: "VALOR RECUSADO (R$ X)... nada foi cadastrado no Klingo"
        algum item sem preço ──► "a assistência pode te passar o preço. Quer que a equipe informe?"  [Sim, quero saber] [Não preciso agora]
              os dois ─► pedido vai para a equipe (marcação manual). "Sim" = PENDENTE: equipe informa o valor na conversa
```

- **Fonte do preço:** `GET /preco?id_procedimento=&id_plano=` da API do Klingo (plano Particular = 1, vem de `klingo_plano_map`). Testado em 16/11/2026 com 13 exames e consultas: os valores batem com o catálogo; mamografia e RM de crânio vieram **sem valor** e por isso vão para a equipe.
- **Valor vazio, zero ou erro da API = "sem preço"**. O chat nunca inventa valor.
- **Preço vale 12 h** (`klingo_preco_api.consultado_em`); sem valor, consulta de novo depois de 30 min.
- **Vários exames:** o total só aparece se **todos** têm preço. "Os dois lados" de exame unilateral cobra 2x; dúvida de lado = sem preço.
- **A resposta do paciente vale só para o pedido que ele viu** (assinatura = plano + exames + quantidade + lado). Mudou o exame ou o plano: o valor é perguntado de novo.
- **O valor mudou entre ver e aceitar:** o chat não aceita o valor antigo, mostra o novo e pergunta de novo.
- **Trava no servidor:** `klingo_pode_marcar` devolve `valor_nao_aceito` para Particular que não aceitou o valor (não depende da tela). Convênio e remarcação de agendamento existente não passam por esse passo.
- **Dá para responder digitando** "sim" ou "não" no passo `valor`.

## Onde está

| Peça | Arquivo |
|---|---|
| Banco, parte 1 (tabela `klingo_preco_api`, chave, 5 textos, 6 funções) | `supabase/particular-valor-parte1-base.sql` |
| Banco, partes 2 e 3 (`fluxo_proximo`, `fluxo_ler_texto`, `klingo_pode_marcar`, `fluxo_perguntar`, `fluxo_aplicar`, `fluxo_finalizar`) | `supabase/particular-valor-parte2-roteiro.sql`, `...-parte3-telas.sql`. **Lêem a definição que está no banco e trocam só os trechos marcados** (erro e nada aplicado se algum trecho não existir exatamente uma vez); rodar de novo não faz nada |
| Edge Function `klingo-preco` (só lê o `/preco`, usa a cota global, só o banco chama, segredo do cofre) | `supabase/functions/klingo-preco/` |
| Tela (cartão `.valor-destaque`, chat `2026.11.16-9`, `sw.js` v69) | `index.html` |
| Testes | `testes/sql-particular-valor.test.mjs` (`npm run test:particular-valor`, 20 casos), `testes/particular-valor.navegador.mjs` (4), `klingo-preco/preco.test.ts` (em `test:edge`) |
| Como fica a tela | `docs/particular-valor-tela.png` |

Textos editáveis em Configurações (tabela `fluxo_texto`): `valor`, `valor_sem`, `valor_recusado_equipe`, `valor_quer_equipe`, `valor_dispensou_equipe`. O texto de pagamento ("combinada com a recepção") pode ser ajustado ali.

## O que a equipe vê

- **Recusou:** a conversa é transferida com o motivo "VALOR RECUSADO: o paciente viu o valor Particular (R$ X) e NÃO quis marcar. Nada foi cadastrado no Klingo." (aviso por push como qualquer transferência) e a observação "Paciente VIU o valor ... e RECUSOU".
- **Sem preço, quer saber:** pedido pronto, urgência média, motivo "PENDENTE: o paciente quer saber o VALOR do atendimento Particular". A equipe responde na conversa.
- **Concordou:** observação "Paciente VIU e ACEITOU o valor Particular de R$ X (preço da API do Klingo)".

## Cuidados

- Hoje só uma parte dos exames tem preço Particular na API; os sem preço (ex.: mamografia, RM de crânio) vão para a equipe. O que mais cair em "sem preço" mostra no Painel como pendência "quer saber o valor".
- O `/preco` aceita também médico e unidade; **não foi testado** se o valor muda por eles. Conferir 2 ou 3 valores com a recepção.
- Outras sessões podem reaplicar versões antigas de `fluxo_*` e `klingo_pode_marcar` por cima. Depois de qualquer mudança nessas funções, rodar `npm run test:particular-valor` (o teste acusa se o passo `valor` sumiu).
- A função `klingo-preco-teste` (stub 410) foi criada para o teste de leitura e pode ser apagada em https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions.
