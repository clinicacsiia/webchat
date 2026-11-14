# 08 — Telefone de teste que foi parar no GitHub: o que foi feito e o que sobra

Versão 1.0 — 14/11/2026 / Mudança: primeira versão. O número **não é escrito aqui** de propósito.

## O que aconteceu

Durante a primeira rodada, copiei para arquivos de teste um telefone que lia na configuração de produção (`klingo_api_telefones_teste`). Ele entrou em **8 commits** da branch `ccr-462c5406-8n7vre` (5 arquivos de teste) e foi enviado ao GitHub, que é público. Foi um erro meu (regra do `CLAUDE.md`: nada de dado de paciente ou da produção no repositório).

## O que foi feito (com a sua autorização de 14/11/2026)

| Passo | Resultado |
|---|---|
| Identificar os commits | 8 commits da minha branch (todos depois de `e6c2d15`, a base). Nenhum commit de outra pessoa. |
| A branch é compartilhada? | Não: só tem commits desta tarefa; nenhum pull request aberto a partir dela. |
| Cópia de segurança | Feita **localmente** (arquivo fora do repositório e fora do GitHub) e depois descartada da árvore de trabalho; nada com o número foi republicado. |
| Remover do histórico | Reescrita da história da branch (`filter-branch`) trocando o número por um telefone **inventado** nos 8 commits. O conteúdo de cada commit é o mesmo, só sem o número. |
| Conferir | Busca em todos os commits da branch local e da remota, nas mensagens de commit, nos arquivos atuais e nos formatos com máscara/código do país: **0 ocorrências**. A árvore final é idêntica à de antes da limpeza (os testes continuam presentes e passando). |
| Atualizar o GitHub | `git push --force-with-lease` **só** da minha branch (nenhuma outra branch tocada). |
| Não repetir | Os testes novos usam telefones inventados da faixa `7198…` e CPF/nascimento fictícios; nenhum teste lê a configuração real. O número que você autorizou para usar em testes **não foi necessário** (e usá-lo num repositório público também o exporia): usei dados inventados. |

## O que NÃO dá para garantir (limites reais)

1. **O mesmo número já estava no repositório antes do meu trabalho.** Ele aparece no histórico da `main` desde **10/11/2026** (um documento de roteiro de teste, `docs/fase6-roteiro-de-teste-e-producao.md`, que listava "contatos que parecem testes da equipe") e em branches antigas de outras sessões. Não está mais na versão atual da `main`, **mas continua no histórico dela e das branches que a contêm**. Limpar isso exige reescrever a `main` e várias branches de outras sessões, o que o seu pedido **não autoriza** (só a minha branch). **Decisão sua** (ver §Pendências).
2. **O GitHub guarda commits antigos mesmo depois de reescrever a branch**: quem souber o código (SHA) de um commit antigo ainda consegue abri-lo até o GitHub apagar objetos sem referência (pode levar semanas). Os SHAs antigos da minha branch: `843b521`, `7b5fc23`, `79750fa`, `3a1dab5`, `b21f80e`, `c37062b` (e os intermediários). O jeito de forçar a remoção é pedir ao suporte do GitHub (**Contact Support → "remove cached views / sensitive data"**).
3. **Caches e cópias externas** (forks, clones, buscadores, o histórico do assistente) estão fora do meu alcance; **não afirmo que o número foi eliminado da internet**.

## Pendências (dependem de você)

* Decidir se quer limpar o número também da `main` e das outras branches (reescrever histórico compartilhado). Recomendação: **não reescrever a `main`**; trocar o telefone na lista de teste da clínica por outro (https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/editor, tabela `config`, chave `klingo_api_telefones_teste`, ou pelo painel em Configurações) resolve o risco prático de alguém usar aquele número como teste.
* Se quiser pedir ao GitHub a remoção dos commits em cache: https://support.github.com/contact/private-information
