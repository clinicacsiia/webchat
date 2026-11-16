# Laudos no aplicativo: baixar o PDF quantas vezes quiser

Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial. **Banco aplicado e Edge Function publicada em 16/11/2026; a tela publica quando o PR entrar na `main`.** As rotas de resultado do Klingo **nunca foram provadas com um laudo real** (ver "O que não foi provado").

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
- Só entrega se o Klingo disser **`pronto` verdadeiro E mandar o arquivo**. Sem o campo `pronto`, `pronto` falso, 403/HTML, PDF que não começa com `%PDF`: **nada sai**.
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
| Testes | `npm run test:laudos-sql` (25), `npm run test:laudos` (15, Chromium), `npm run test:edge` (inclui `app-laudos/laudos.test.ts`, 19) |

## Ligar e desligar
`select valor from public.config where chave = 'app_laudos';` — **`sim` = ligado** (nasceu ligado). **Desligar na hora:** `update public.config set valor = 'nao' where chave = 'app_laudos';` (a lista some e o download é recusado). O texto de reversão completo está no cabeçalho do SQL.

## O que não foi provado (leia antes de confiar)
- **Nenhuma rota de resultado foi testada com laudo pronto de verdade.** O swagger diz `GET /resultado/{id}` → `{ lista: [ { pronto, resultado_pdf, resultado_html, anexos, procedimento… } ] }` e `GET /resultado/pdf/{id}` → `{ pdf_base64 }`; o único teste real (13/11) foi uma marcação **sem** laudo, que respondeu 403 com página HTML. O código aceita `{lista:[…]}`, lista direta e laudo solto, e **na dúvida não entrega**. Se o formato real for outro, o sintoma é "Aguardando a liberação" mesmo com o laudo pronto no Klingo — nunca um laudo errado.
- `GET /vouchers` devolve as marcações `atendido` de **todo o histórico**? O guia diz que sim para achar o id, mas não foi medido; se só vier o recente, exames antigos não aparecem.
- Laudo de **imagem** pela rota `/resultado/pdf/an/{accession_number}`: **não implementado** (não sabemos de onde sai o *accession number*). Se o laudo de imagem só existir por essa rota, ele não vai aparecer.
- Laudo só em HTML (sem PDF) é entregue como arquivo `.html` (nunca renderizado dentro do aplicativo).
- O nome do paciente pode não vir na resposta do Klingo; nesse caso a conferência fica com CPF + nascimento (a função anota `nomeConferido`).
- **Teste real recomendado (você, como paciente, com autorização):** cadastrar com o seu CPF/nascimento, abrir Meus laudos, baixar; depois pedir à equipe para retirar o laudo no Klingo e tentar baixar de novo (tem que recusar). Se algo vier diferente, me passe só **o formato** (nomes dos campos), nunca o conteúdo do laudo.

## Privacidade (jurídico, item 2.5 das pendências)
O aplicativo passa a **ler** laudos do Klingo e a entregá-los ao paciente. O banco guarda só id da marcação, nome do exame, data e unidade (dado de saúde de baixo detalhe), sem prazo de guarda definido. `privacidade.html` precisa citar a entrega de laudos (não alterei: mudança de texto jurídico é decisão sua).
