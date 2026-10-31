# Fase 8: leitura do pedido médico (letra de médico, dúvida explicada ao paciente e memória que aprende)

Data: 31/10/2026. SQL em `supabase/fase8-leitura-pedido.sql` (**ainda não aplicado no projeto**). Função nova: `supabase/functions/ler-pedido` (**ainda não publicada**). Chat: `index.html`. Painel: `painel/index.html`.

## 1. O que mudou para o paciente

Antes: o celular lia a foto (Tesseract 5) e marcava sozinho o primeiro exame parecido de cada linha. Letra de médico quase nunca era lida, e quando o nome batia com vários exames o paciente não era avisado.

Agora:

- **Dois botões grandes**: "Tirar foto do pedido agora" e "Escolher a foto do pedido na galeria" (muitos idosos já têm o pedido no WhatsApp). Há uma dica de como fotografar e a frase "A foto fica guardada com segurança para o atendente conferir o seu pedido".
- **Um cartão por exame do pedido**, com o recorte da linha da foto ("1º exame do pedido" e o trecho do papel) e, quando a IA leu, "Entendi: Ressonância do joelho esquerdo".
- **Quatro situações, cada uma explicada**:

| Situação | O que o paciente vê |
|---|---|
| Certo (um exame só, ou já aprendido) | Caixa grande já marcada. Pode desmarcar |
| Parecido (achou, mas há outros com nome parecido) | O primeiro já marcado e "Não é este? Ver outras opções" |
| **Dúvida** (exames diferentes, ex.: ecocardiograma comum ou com doppler) | "Não tenho certeza de qual exame é este. Qual destes está no seu pedido?" com caixas grandes e a saída "Não sei. O atendente confere pela foto." O botão de enviar fica "Responda qual é o exame acima" até ele tocar |
| Não identificado ou fora da lista da clínica | "Não encontrei este exame na lista da clínica. O atendente vai conferir pela foto. Ele já está no seu pedido", com "Isto não é um exame: tirar do pedido" |

- **Quantos exames tem o pedido**: "Encontrei 3 exames no seu pedido." Se a IA contar mais exames do que conseguiu ler: "O pedido parece ter 4 exames. Um deles eu não consegui ler: o atendente confere pela foto."
- **Foto que não é pedido** (receita de remédio, documento): o paciente é avisado e pode tirar outra foto ou procurar pelo nome.
- **Mais de uma folha**: "+ O pedido tem outra folha? Enviar outra foto". Os exames das folhas se somam.
- **Lado**: quando o pedido diz o lado, ele já vem marcado ("Lado (confira)"); quando não diz, "De qual lado?".

### Regra de ouro: o que o paciente decidiu nunca é desfeito

A leitura do celular chega em 2 a 3 segundos; a da IA, alguns segundos depois. Quando a IA chega:

- O que foi marcado **sozinho** e a IA não confirma é desmarcado.
- O que o **paciente escolheu** vira a opção marcada do cartão novo (não aparece em dobro).
- O que o paciente **tirou** continua fora.
- Uma **dúvida** da IA só é respondida por um toque do paciente; a marcação automática da leitura do celular não vale como resposta.

Os três casos foram testados na tela (seção 6).

## 2. O que há de mais novo em OCR e o que foi aplicado

Pesquisa de outubro de 2026:

- **Modelos de visão e linguagem (VLM)** são hoje o que melhor lê letra à mão. Um estudo recente comparou 17 modelos num formulário médico real e só os mais novos foram bem ([arXiv 2604.16504](https://arxiv.org/pdf/2604.16504)). Benchmarks de letra à mão ainda mostram distância para o humano ([WildHandBench](https://arxiv.org/pdf/2608.22959), [OmniHandwritingOCR](https://arxiv.org/pdf/2608.18586)).
- **OCR clássico** (Tesseract, EasyOCR) vai bem em texto impresso e mal em letra de médico. Num teste de abril de 2026 com receitas escritas à mão, modelos novos e pequenos (PP-OCRv5, GLM-OCR) acertaram cerca de 10 vezes mais palavras que o Tesseract, mas ainda pouco para dispensar conferência humana ([Arabian Post](https://thearabianpost.com/modern-ocr-narrows-gap-on-doctors-handwriting/), [DEV Community](https://dev.to/kaniel_outis/how-well-can-ocr-read-doctor-handwriting-in-2026-54hn)).
- Ponto em comum: **nenhuma leitura de letra de médico é confiável sozinha**. O certo é mostrar a dúvida e ter conferência humana ([guia da Extend](https://www.extend.ai/resources/ocr-physician-handwriting-complete-guide), [estudo na Frontiers in Medicine](https://www.frontiersin.org/journals/medicine/articles/10.3389/fmed.2026.1856485/abstract)).

Aplicado:

1. **No celular: Tesseract 7.0.0** (dez/2025; antes era o 5.1.1), com o modelo LSTM em português e:
   - preparo da foto: tons de cinza, remoção da sombra e da luz desigual (divide a foto pela versão borrada dela) e contraste esticado;
   - correção automática de foto torta (`rotateAuto`);
   - leitura por linha, com a confiança e a posição de cada uma: é o que permite recortar a linha e mostrar ao paciente.
   No teste, uma foto torta e com sombra foi lida em 1,5 a 2,5 s, com 93 a 96% de confiança por linha.
2. **No servidor: IA de visão (Claude, modelo `claude-opus-5-5`)** pela Edge Function `ler-pedido`, para a letra de médico:
   - recebe a foto e o catálogo inteiro (647 exames com agenda), que fica em cache na API;
   - devolve uma resposta num formato fixo e validado (structured outputs): quantos exames, o que está escrito, o que entendeu, o lado, a certeza e as opções do catálogo;
   - junta numa opção só os nomes repetidos do mesmo exame (o catálogo tem "US ABDOME TOTAL", "USG ABDÔMEN TOTAL" e outros iguais) e só pergunta ao paciente quando são exames **de fato diferentes**, com nomes simples ("Ultrassom da barriga inteira");
   - sabe se o paciente é adulto ou criança (para o ecocardiograma de adulto ou o pediátrico);
   - recebe as escritas que a equipe já confirmou (seção 3);
   - só aceita ids que existem no catálogo; o resto é descartado no servidor.
   A IA não conversa com o paciente: só devolve opções para ele marcar. A mesma foto nunca é lida duas vezes.
3. **Mesmo sem a IA** (sem chave, fora do ar ou sem resposta), a leitura do celular continua e melhorou: exame de criança e fetal deixam de vir primeiro para adulto, a mesma linha repetida não vira dois exames, e "1)" e riscos da borda saem do texto.

## 3. Guardar as fotos e ensinar a leitura

Tudo fica em `conversa_anexo`, junto da foto:

| Coluna | O que guarda |
|---|---|
| `ocr_texto`, `ocr_linhas` | O que o celular leu, linha a linha, com confiança e posição |
| `ia_leitura`, `ia_modelo`, `ia_ms`, `ia_erro` | O que a IA leu, qual modelo, quanto tempo levou e, se falhou, por quê |
| `escolha` | O que o paciente marcou em cada exame e se ele só deixou como veio (`auto`) |
| `gabarito`, `gabarito_por`, `gabarito_em` | O que a equipe confirmou ser o pedido (o "certo") |

**Como o sistema aprende**: no painel, "Ver foto do pedido médico" mostra a leitura da IA (com o grau de certeza de cada exame), o que o paciente marcou e o quadro **"Conferir a leitura (ensina o sistema)"**. O atendente escreve cada exame como está no papel (ex.: "RNM J E") e escolhe o exame certo. Ao salvar:

- a escrita normalizada vai para `ocr_aprendido` (escrita → exame, com quantas vezes foi confirmada);
- da próxima vez que a mesma escrita aparecer, **a leitura do celular já acerta sozinha**, mesmo sem a IA ("rnm j. e." passou a vir como "RM de joelho, lado esquerdo", com certeza alta);
- as 120 escritas mais confirmadas vão para a IA como exemplos do jeito de escrever dos médicos da região.

Isto não é treinar um modelo novo: é uma memória que a equipe alimenta e que vale na hora. As fotos com gabarito também servem para, mais tarde, medir modelos ou treinar um modelo próprio. A view `ocr_treino` junta foto, leituras, escolha do paciente, gabarito e quantos exames a IA acertou:

```sql
select count(*) fotos, sum(exames_confirmados) exames, sum(ia_acertos) acertos_ia,
       round(100.0 * sum(ia_acertos) / nullif(sum(exames_confirmados), 0), 1) as pct_ia
from ocr_treino where gabarito_em > now() - interval '30 days';
```

As fotos ficam no banco da clínica. Para a leitura da letra, a foto é enviada à API da Anthropic, que age como operadora e, por padrão, não usa dados da API comercial para treinar modelos. Pedido médico é dado de saúde (dado sensível na LGPD): vale citar no aviso de privacidade do chat que a foto é lida por um serviço de IA e guardada para conferência e melhoria da leitura, e definir por quanto tempo as fotos ficam guardadas.

## 4. Ligar

1. **Banco**: aplicar `supabase/fase8-leitura-pedido.sql` (só colunas e funções novas; `painel_anexo` passa a devolver mais campos). Testado no banco real em transação desfeita (seção 6).
2. **Função**: publicar `supabase/functions/ler-pedido` **sem exigir JWT** (`verify_jwt = false`). O chat usa a chave publicável, que não é JWT; quem prova o acesso é o token da conversa, conferido no banco.
3. **Chave**: em Supabase > Edge Functions > Secrets, criar `ANTHROPIC_API_KEY`. Opcionais: `OCR_MODELO` (padrão `claude-opus-5-5`) e `OCR_ESFORCO` (`low`, `medium` ou `high`; padrão `medium`). Sem a chave, a função responde `sem_chave` e o chat segue só com a leitura do celular.
4. **Chat e painel**: entram no ar com o merge (GitHub Pages).

A ordem não quebra nada:

- Chat novo com o banco antigo: volta para a busca antiga pelo texto lido.
- Chat novo sem a função publicada: só a leitura do celular.
- Banco novo com o chat antigo: tudo continua como hoje.

**Custo da IA**: cerca de 1.500 tokens por foto, mais o catálogo (cerca de 7 mil tokens, lido do cache a preço reduzido), mais a resposta. Fica na casa de 1 a 3 centavos de dólar por foto. Limites: 6 fotos por conversa, uma leitura por foto.

## 5. Limites conhecidos

- A leitura do celular só ajuda com texto impresso. Letra de médico depende da IA.
- A IA ainda pode errar letra muito ruim. Por isso a dúvida é mostrada, a foto sempre vai ao atendente e a conferência no painel ensina.
- Quando o Tesseract gira uma foto muito torta, o recorte da linha não é mostrado (a posição deixa de bater com a foto original); aparece o texto "No papel está escrito: …".
- O recorte só existe para linhas que o celular leu. Linhas que só a IA leu aparecem como texto.
- A leitura pela IA não foi testada com uma chave real neste ambiente, que não alcança o Supabase nem a API. O formato do pedido à API foi conferido contra o SDK oficial com um servidor de teste local.

- **Teto de gasto**: `ler-pedido` é pública (sem JWT) e o limite é de 6 fotos por conversa, não global. Antes de divulgar o chat a muita gente, vale um limite diário ou por origem.
- **Modelo**: o padrão é `claude-opus-5-5`; `OCR_MODELO` troca. Comparar o acerto com a view `ocr_treino` antes de mudar.
- **Relação com a Fase 7**: a IA não volta a conversar com o paciente nem entra no motor de fluxo. Ela só devolve opções para o paciente marcar, sem bloquear o chat. O custo em créditos da API é o único item que a Fase 7 havia eliminado e que volta.

## 6. Testes feitos

1. **Banco real, em transações desfeitas** (nada ficou gravado; antes, uma sonda confirmou que o erro proposital no final desfaz tudo):
   - Linhas de um pedido: o cabeçalho, o nome do médico e o endereço ficam de fora. "Cintilografia óssea", que não está no catálogo, vira "não identificado". RM do joelho e US do abdome vêm "parecido", ecocardiograma de adulto vem antes do fetal e do pediátrico, e a linha repetida não vira um segundo exame.
   - A leitura da IA gravada vira cartões: dúvida entre exames diferentes, id inventado descartado, exame ilegível como "não identificado".
   - A conferência do painel gravou a escrita "RNM J E" e, na leitura seguinte, "rnm j. e." veio certo, com o lado esquerdo.
   - `ocr_ia_contexto` devolve a leitura guardada em vez de ler de novo. `painel_exames_buscar` e a view `ocr_treino` também foram testados.
2. **Função `ler-pedido`**:
   - 5 testes da parte pura: `node --experimental-strip-types --test supabase/functions/ler-pedido/leitura.test.ts`.
   - Tipos conferidos com o TypeScript contra o SDK `@anthropic-ai/sdk` 1.3.0.
   - Chamada contra um servidor local que imita a API: modelo, `fallbacks: "default"`, formato JSON, cache do sistema, imagem e o tratamento de 429, recusa e tipo de imagem.
3. **Tela do chat no Chromium (390 × 844)**, com o Tesseract 7 de verdade e as respostas reais do banco do teste 1:
   - foto torta e com sombra lida em 1,5 a 2,5 s;
   - cartões com recorte e o botão travado até responder a dúvida;
   - envio do pedido e da escolha;
   - o paciente mexe antes de a IA chegar: a escolha dele continua, o que ele tirou continua fora e não há duplicado.
4. **Painel**: leitura, escolha do paciente e conferência salvando as escritas.
