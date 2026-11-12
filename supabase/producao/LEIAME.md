# Retrato da estrutura do banco de produção

Versão 1.3 — 12/11/2026 / Mudança: acrescentadas as funções e as 12 tabelas do autoatendimento com a API do Klingo (52 funções novas ou alteradas), 5 rotinas e 9 chaves de `config`. Feito a partir das migrações `supabase/klingo-auto-parte1..9.sql` aplicadas num clone do retrato anterior (as definições são as do `pg_get_functiondef` do clone, não uma leitura direta da produção): 11 delas diferem do banco real só em comentários e variáveis sem uso, porque as migrações foram coladas sem os comentários. O comportamento é o mesmo (os testes passam nos dois). O próximo retrato completo, tirado da produção, normaliza.
Versão 1.2 — 11/11/2026 (noite) / Mudança: retrato atualizado com o que o dono aplicou depois (431 funções, 102 tabelas): 6 funções novas (`chat_arquivo_equipe`, `painel_arquivo_enviar`, `painel_indicadores_decisao`, `painel_indicadores_atendentes`, `ind_decisao_periodo`, `origem_limpa`), `chat_iniciar` alterada e a tabela `respostas_prontas`
Versão 1.1 — 11/11/2026 (14h49) / Mudança: retrato refeito depois das PRs #120 a #134 do dono e das últimas migrações da auditoria
Versão 1.0 — 11/11/2026 (07h14) / Mudança: primeiro retrato (auditoria de 11/11/2026)

**Esta pasta é a verdade sobre o banco.** Ela copia a **estrutura** do projeto Supabase `webchat-atendimento` (`nrvuynjwcgwpjdptkiay`) como ele está de fato: funções, tabelas, gatilhos, regras de acesso e rotinas. **Não tem nenhuma linha de tabela, nenhum valor de configuração e nenhum segredo** (o gerador recusa gravar se achar e-mail, telefone, chave ou token).

Tirado em **11/11/2026 às 14:49 de Brasília**: 431 funções, 102 tabelas, 5 visões, 56 gatilhos, 65 regras de acesso, 21 rotinas, Postgres 17.11.

## Por que existe

Até 11/11/2026 o repositório guardava só os arquivos `supabase/*.sql` de cada mudança. A comparação com a produção mostrou:

- **333** funções da produção batem com alguma versão desses arquivos (ignorando comentário e espaço);
- **31** existem nos dois lugares, mas **a produção é diferente de todas as versões do repositório** (foram corrigidas direto no banco);
- **52** existem **só na produção** (quase todo o módulo Jornada, contas de paciente, vínculo com o Klingo);
- 8 existem só no repositório (funções do n8n e da IA antiga, já apagadas do banco, e do módulo da biometria, que não foi atualizado).

Ou seja: quem lesse só os arquivos antigos entenderia errado 83 funções, inclusive o coração do motor do chat (`fluxo_aplicar`, `fluxo_avancar`, `fluxo_perguntar`, `chat_iniciar`, `chat_horarios`). Com o retrato isso acaba, e os testes passam a rodar contra o código real.

## O que tem aqui

| Arquivo | Conteúdo |
|---|---|
| `funcoes/<nome>.sql` | Uma função por arquivo, exatamente como está na produção, com quem pode executar. É onde se lê "como isso funciona hoje". |
| `estrutura.sql` | Tabelas (colunas, restrições, índices, RLS, regras de acesso), chaves estrangeiras, visões, gatilhos, tabelas no tempo real, rotinas do pg_cron, limites de tempo por papel e os **nomes** das chaves de `config`. |
| `indice.json` | O mesmo, enxuto, para os testes lerem (função → parâmetros e permissões; tabela → colunas; rotinas; gatilhos). |
| `consultas.sql` | As duas consultas que tiram o retrato. |
| `gerar.py` | Transforma o resultado das consultas nestes arquivos. |

## Para que serve

1. **Entender o sistema**: abrir `funcoes/chat_responder.sql` mostra o que roda de verdade.
2. **Testar contra a produção**: `testes/banco-producao.mjs` monta um Postgres embutido com este retrato em 3 segundos. Em cima dele rodam `sql-producao.test.mjs` (as correções) e `sql-ponta-a-ponta.test.mjs` (o paciente do começo ao fim, a equipe, a segurança).
3. **Manter tela e banco sincronizados**: `testes/retrato.test.mjs` confere que toda função chamada pelas telas existe aqui com os mesmos parâmetros.
4. **Ver o que mudou no banco**: o histórico do git desta pasta é o histórico do banco. Nos quatro retratos de 11/11 a diferença entre um e outro foi exatamente o que cada sessão aplicou: as 3 funções da auditoria de manhã; as 6 funções novas, 9 alteradas, 1 tabela e 1 rotina do dono à tarde; e as 3 funções e a tabela das últimas migrações da auditoria.
5. **Voltar atrás**: a definição anterior de qualquer função está no commit anterior.

## Como refazer (sempre que o banco mudar)

Peça ao Claude: **"atualize o retrato da produção"**. O passo a passo está no começo de `consultas.sql`. Leva 2 minutos e só lê o catálogo do banco.

Depois: `cd testes && npm run test:retrato && npm run test:producao-sql && npm run test:ponta-a-ponta`.

**Não rodar `estrutura.sql` nem as funções em cima da produção.** O retrato é leitura e teste; mudança no banco continua sendo um arquivo novo em `supabase/`, testado no clone e aplicado em partes.

## As diferenças encontradas em 11/11/2026 (primeiro retrato, 416 funções)

**Produção diferente de qualquer versão do repositório (31):** `agenda_cobre`, `agenda_conferencia_alvos`, `agenda_horarios_klingo`, `assinatura_contexto`, `assinatura_registrar`, `catalogo_preco_revisar`, `chat_horario_escolher`, `chat_horarios`, `chat_iniciar`, `chat_pedido_salvar`, `consultas_da_unidade`, `convenio_salvar`, `equipe_pedido_reforcar`, `fila_emitir_token`, `fila_entrar`, `fila_identificar_todos`, `fila_reenviar_link`, `fluxo_aplicar`, `fluxo_assunto_aplicar`, `fluxo_avancar`, `fluxo_leitura`, `fluxo_ler_texto`, `fluxo_perguntar`, `ia_pre_agendar`, `painel_mensagem_alterar`, `pessoa_agrupar_conversa_trg`, `pessoa_agrupar_pre_trg`, `pre_agendamento_historico_trg`, `pre_reaproveitar`, `preco_referencia_pedido`, `unidade_medicos`.

**Só na produção (52):** `agenda_horarios_klingo_v1`, `agenda_horarios_klingo_v2`, `chat_medicos_disponiveis`, `conta_paciente_adotar_conversas`, `conta_paciente_confirmar_cpf`, `conta_paciente_conversas`, `conta_paciente_pedir_alteracao`, `conta_paciente_vincular`, `conta_paciente_vinculo_estado`, `cpf_digitos`, `cpf_valido`, `jornada_acordar`, `jornada_admin`, `jornada_aplicar_chat`, `jornada_aplicar_klingo`, `jornada_aplicar_regras`, `jornada_atribuir_card`, `jornada_checklist_do_card`, `jornada_checklist_gatilho`, `jornada_coluna_do_card`, `jornada_coluna_do_chat`, `jornada_conversa_do_card`, `jornada_conversas_sincronizar`, `jornada_criar_tarefa`, `jornada_enviar_mensagem`, `jornada_equipe`, `jornada_imutavel`, `jornada_klingo_expediente`, `jornada_klingo_fechar`, `jornada_klingo_lote`, `jornada_klingo_pode_mover`, `jornada_marcar_tarefa`, `jornada_mover_card`, `jornada_nome_de`, `jornada_pendencia_resolver`, `jornada_pode`, `jornada_registrar_acesso`, `jornada_regra_ativa`, `jornada_status_exame`, `jornada_unidade_curta`, `medicos_disponiveis_interno`, `paciente_aviso_resolver`, `paciente_avisos`, `paciente_dado_conferir`, `paciente_klingo`, `paciente_klingo_ligar`, `paciente_linha_do_tempo`, `pessoa_pedidos_de`, `pessoa_resumo_de`, `pessoa_unir_grupos`, `vinculo_decidir`, `vinculo_listar`.

**Só no repositório (8, esperado):** `avisar_n8n_mensagem`, `ia_catalogo`, `ia_contexto`, `ia_responder`, `ia_responder_v2` (apagadas com a saída do n8n) e `fila_avisar_link`, `fila_n8n_autorizado`, `fila_segredo_do_cabecalho` (versão 2 da biometria, nunca aplicada).

Isto resolve a pendência antiga "G1: versionar o módulo Jornada", que estava aberta desde 01/11/2026.
