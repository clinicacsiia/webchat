# Laudos no aplicativo: baixar o PDF quantas vezes quiser

Versão 1.1 — 16/11/2026 / Mudança: **provado com laudos reais** (só o formato foi lido, nunca o conteúdo): `resultado_pdf` é um link assinado do S3 (vale 1 hora), não o PDF; a função baixa o arquivo no download e não repassa o link. Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial. **Banco aplicado e Edge Function publicada em 16/11/2026; a tela publica quando o PR entrar na `main`.** As rotas de resultado do Klingo **nunca foram provadas com um laudo real** (ver "O que não foi provado").

## O que o paciente vê
1. Entra no aplicativo (celular + PIN) e toca em **Acompanhe seus pedidos**. No portal aparece o cartão **Meus laudos**, logo abaixo do cabeçalho, **mesmo que ele nunca tenha aberto o chat**: a lista vem do Klingo, não das conversas.
2. Cada exame feito aparece com um destes estados:
   - **Disponível** — botão **Baixar laudo (PDF)**. Pode baixar quantas vezes quiser.
   - **Em revisão** — "Este laudo está em revisão pela equipe e não pode ser baixado agora." (a equipe retirou para ajuste; volta sozinho quando o Klingo liberar de novo).
   - **Aguardando** — "Aguardando a liberação do laudo." (só exames dos últimos 30 dias e que não sejam consulta/retorno; exame mais antigo sem laudo não aparece).
3. Titular e **filhos** aparecem juntos (o nome do filho vem na linha do exame). Cada pessoa é conferida com o **próprio** CPF e nascimento.
4. Se faltar o CPF de alguém, o cartão avisa e leva a *Meus dados*. Se a clínica não confirmar o cadastro, pede para conferir CPF, nascimento e nome, **sem dizer qual dado errou**. Paciente que ainda não tem cadastro na clínica não vê aviso nenhum.

## A regra que importa: o Klingo manda, a cada download
- **O PDF nunca é guardado** (nem no banco, nem no aparelho, nem em log). Cada toque em *Baixar* faz a Edge Function `app-laudos` perguntar ao Klingo na hora (`GET /resultado/{id_marcacao}`, e `/resultado/pdf/{id}` para laboratório).
- Só entrega se o Klingo disser **`pronto` verdadeiro E apontar o arquivo**, e se o arquivo baixado for mesmo um PDF. Sem o campo `pronto`, `pronto` falso (inclusive rascunho com texto), 403/HTML, link de outro endereço, arquivo que não começa com `%PDF`: **nada sai**. Falha ao buscar o arquivo (rede) também não entrega, mas **não** marca o laudo como retirado.
- **Equipe retirou o laudo para ajuste?** O próximo toque em *Baixar* é recusado, o estado vira "em revisão" e o aviso aparece. Laudo que já estava no celular do paciente (arquivo baixado antes) a clínica não consegue apagar; o que ela controla é o próximo download.
- **Klingo fora do ar = não entrega** (queda de rede não libera laudo por engano e também **não** marca como retirado).
- Na lista (sem baixar), o estado é conferido de novo a cada 15 minutos, no máximo 6 marcações por abertura da tela; o download sempre confere na hora.

## Como a pessoa é reconhecida (sem a equipe)
`app-laudos` confere no Klingo, em ordem, e só segue se tudo bater:
1. o aparelho tem o PIN dos últimos 30 minutos (conferido pelo **banco**; abrir/recarregar a tela não estende o PIN, baixar estende);
2. `GET /paciente/cpf` com o CPF guardado no cadastro: o **nascimento** do Klingo é o do cadastro;
3. o `login` do Klingo volta o mesmo id e nascimento, e o **nome** do Klingo confere com o do cadastro (mesma regra de `nome_confere`: sem acento, nome do meio pode faltar, uma palavra só não basta). Só cadastro **definitivo** (id `P…`); pré-cadastro ainda não tem atendimento;
4. com a sessão da própria pessoa lê `GET /vouchers` e guarda **só as marcações com status `atendido`** (id, nome do exame, data, unidade). **É isso que prova que a marcação é dela**: o download só vale para um id que saiu dessa lista.
Se o CPF ou o nascimento mudarem em *Meus dados*, a conferência anterior **deixa de valer** (as linhas antigas não passam para a nova identidade).

## Travas
- Quem erra o CPF/nascimento/nome: registrado em `klingo_identidade`; **5 conferências erradas por hora com o mesmo CPF** travam novas tentativas (mesma regra da página pública de agendamento). Quem já foi confirmado não é travado.
- Quem a clínica não confirmou só é conferido de novo depois de **6 horas** (ou se mudar CPF/nascimento).
- **60 downloads por hora** por cadastro; depois disso "tente de novo daqui a pouco".
- Cada download e cada bloqueio grava um evento **sem dado pessoal** em `app_evento` (`laudo_baixado`, `laudo_bloqueado`): `select tipo, count(*) from public.app_evento where tipo like 'laudo%' group by 1;`
- Cota global do Klingo respeitada (`klingo_cota_pegar`), como nas outras funções.

## Onde fica cada coisa
| O quê | Onde |
|---|---|
| Tabelas | `app_laudo_pessoa` (conferência por pessoa, só hash), `app_laudo` (marcações atendidas + estado). RLS sem regra |
| Funções (todas só do `service_role`) | `app_laudos_contexto`, `app_laudos_pessoas`, `app_laudos_pessoa_gravar`, `app_laudos_itens_gravar`, `app_laudos_a_checar`, `app_laudos_estado`, `app_laudos_lista`, `app_laudos_pode` |
| Edge Function | `supabase/functions/app-laudos/` (`laudos.ts` regras puras, `index.ts` HTTP, `api.ts` cópia do cliente do Klingo). `verify_jwt=false`; protege o código do aparelho com PIN |
| Banco | `supabase/laudos-no-app.sql` (3 partes, sem DELETE/DROP) |
| Tela | `minha-vez/index.html` (cartão **Meus laudos**) e o texto do cartão do chat |
| Testes | `npm run test:laudos-sql` (25), `npm run test:laudos` (15, Chromium), `npm run test:edge` (inclui `app-laudos/laudos.test.ts`, 26, com o formato real) |

## Ligar e desligar
`select valor from public.config where chave = 'app_laudos';` — **`sim` = ligado** (nasceu ligado). **Desligar na hora:** `update public.config set valor = 'nao' where chave = 'app_laudos';` (a lista some e o download é recusado). O texto de reversão completo está no cabeçalho do SQL.

## O que foi provado com laudos reais (16/11/2026) e o que ainda não
**Provado** (9 marcações reais de 12/11/2026: RM, TC, US, RX, densitometria e consulta; só estrutura, tamanho e cabeçalho foram olhados; nada foi guardado):
- `GET /resultado/{id_marcacao}` devolve `{lista:[{id_laudo, id_marcacao, id_atendimento, dt_atendimento, procedimento, status, pronto, medico, unidade, resultado_html, resultado_pdf, anexos}]}`, como no swagger. **Uma marcação pode ter vários laudos** (vimos 4 e 2): a função entrega todos os prontos (o aplicativo mostra um link para cada).
- **Laudo pronto** (`pronto: true`, `status: "Laudado"`): `resultado_pdf` é **um link assinado do S3** (`s3.amazonaws.com/arquivos.azuremed/clientes/clinicacsi/laudos/….pdf`, validade 3600 s) e `resultado_html` é nulo. O link baixa um **PDF válido** (começa com `%PDF`, termina com `%%EOF`, 135 KB a 700 KB), sem redirecionamento.
- **Rascunho** (`pronto: false`): `resultado_pdf` vazio e `resultado_html` pode trazer o **texto do laudo** (vimos 1 caso). A função ignora tudo que não é `pronto: true`, então o rascunho nunca sai.
- **Consulta**: `{lista: []}` (nada a baixar).
- `GET /resultado/pdf/{id}` responde **403** para exame de imagem (só laboratório usaria; fica como reserva).
- Por segurança o link do S3 é um "cartão de acesso" de 1 hora: ele **nunca vai ao paciente nem ao banco nem ao log**. A função só busca endereço `https` do host `s3.amazonaws.com` na pasta dos laudos da CSI, sem seguir redirecionamento, e só aceita o que começa com `%PDF` (até 15 MB).
- Na **lista** a função só confirma "pronto + arquivo apontado" (não baixa PDF); o PDF é baixado **só** quando o paciente toca em *Baixar*.

**Ainda NÃO provado:**
- A parte do **paciente** de ponta a ponta (CPF + nascimento + nome → `GET /vouchers` com a sessão da pessoa → marcações atendidas) não foi rodada com um paciente real, porque exige o CPF dele. Só o teste do dono, com autorização, fecha isso.
- `GET /vouchers` traz as marcações `atendido` de **todo o histórico**? (se só vier o recente, exames antigos não aparecem).
- Laudo de **laboratório** (rota `/resultado/pdf/{id}`) não apareceu na amostra; o caminho existe mas não foi visto funcionando.
- Laudo de imagem pela rota `accession_number` não é usado (o laudo de imagem já vem pelo link acima).
- Se o laudo for retirado para ajuste, supomos que o Klingo volte a responder `pronto: false` (ou 403): é o que o código bloqueia, mas **a retirada real não foi observada**. Teste do dono: pedir à equipe para retirar um laudo e tentar baixar.

## Privacidade (jurídico, item 2.5 das pendências)
O aplicativo passa a **ler** laudos do Klingo e a entregá-los ao paciente. O banco guarda só id da marcação, nome do exame, data e unidade (dado de saúde de baixo detalhe), sem prazo de guarda definido. `privacidade.html` precisa citar a entrega de laudos (não alterei: mudança de texto jurídico é decisão sua).
