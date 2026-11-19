# Indicador de recorrência: quem usa o chat, quem é primeira vez e quantas pessoas já estão cadastradas (19/11/2026)

Pedido do dono: um indicador de **recorrência** com quantas pessoas estão usando, quem é primeira vez e quantas pessoas já estão cadastradas.

## Onde está
Painel > **Indicadores**, logo abaixo dos 5 números do topo: seção **"Quem usa o chat: primeira vez e quem volta"**. Vale o período, o filtro de unidade e o "Incluir conversas de teste" (só administrador) da própria aba. Só números: nenhum nome, telefone ou CPF.

## O que mostra
| Quadro | Significa |
|---|---|
| Pessoas que usaram o chat | Pessoas diferentes que abriram pelo menos uma conversa no período |
| Primeira vez | A **primeira conversa da pessoa em toda a história** caiu dentro do período |
| Já tinham usado antes | Já tinha conversa **antes** do período e abriu outra dentro dele (recorrente) |
| Pessoas já cadastradas no chat | Todas as pessoas que já abriram o chat até o fim do período (de qualquer unidade) |
| Quantas vezes cada pessoa já usou | Das cadastradas: 1 vez, 2 vezes, 3 ou mais |
| Acesso rápido | Contas com celular e PIN (clínica toda): criadas, novas no período, entraram no período, voltaram em outro dia, só entraram no dia do cadastro |
| Por dia | Colunas por dia: primeira vez × já tinham usado (últimos 31 dias; tabela com todos) |

Usaram = primeira vez + já tinham usado. As setas comparam com o período anterior de mesmo tamanho.

## Quem é "a mesma pessoa" aqui (diferente dos 5 números do topo)
**O mesmo celular** (contato) ou o agrupamento de pessoa única (`conversa_grupo`), o que juntar mais. Os 5 números do topo só usam o agrupamento, que exige 3 dados batendo. Medido na produção em 19/11/2026: **30 dos 75 celulares com mais de uma conversa estavam em "pessoas" separadas**; para medir quem voltou, o celular repetido tem de contar como a mesma pessoa. Por isso estes números podem ser um pouco menores que "Procuraram o chat". Limite: se um celular tiver dois agrupamentos diferentes, as conversas sem agrupamento seguem o de menor código.

## Números reais em 19/11/2026 (produção, só contagens)
- Cadastradas no chat: **390 pessoas** (501 conversas desde 29/10/2026; 314 usaram 1 vez, 54 duas, 22 três ou mais).
- Últimos 7 dias: **168 usaram**, 150 primeira vez (89%), 18 já tinham usado (11%); 23 das 150 de primeira vez já voltaram dentro da própria semana.
- Acesso rápido: 151 contas (todas criadas desde 15/11), 29 voltaram em outro dia, 122 só entraram no dia do cadastro.

## Limites que continuam
- O chat é novo (primeira conversa em 29/10/2026): quem falava antes disso aparece como primeira vez.
- O acesso rápido guarda só o **último** acesso de cada conta (`ultimo_acesso_em`): em períodos antigos "entraram no período" fica abaixo do real.
- Não mostra **quem** (nomes): para ver pessoas use Contatos ou Atendimento. Se o dono quiser a lista de quem é primeira vez, pedir à parte (dado pessoal só em arquivo entregue ao dono).

## Arquivos
`supabase/indicadores-recorrencia.sql` (fluxograma, versão e rollback no cabeçalho; aplicada em 3 partes: `indicadores_recorrencia_parte1_base`, `parte2_periodo`, `parte3_painel`; só funções novas), `painel/index.html` (`blocoRecorrencia`), `painel/sw.js` (v77), `testes/sql-recorrencia.test.mjs` (17 verificações no banco: `npm run test:recorrencia-sql`), `testes/indicadores.navegador.mjs` (3 casos novos).
Desfazer: `drop function public.painel_indicadores_recorrencia(date, date, text, boolean); drop function public.ind_recorrencia_periodo(date, date, text, boolean, boolean); drop function public.ind_recorrencia_base(date, boolean);` (a tela mostra um aviso no lugar do bloco; o resto da aba continua).
