# Relatórios do Klingo para o chat (atualizado em 12/11/2026)

> **12/11/2026:** a conferência de CPF + nascimento passou a ser feita também pela **API externa** (`/paciente/cpf`, função `klingo-identificar`), que achou o cadastro onde o relatório A dizia `nao_encontrado`. O relatório A continua rodando (dá o prontuário e o histórico usados pelo reconhecimento de marcações), mas **o número do prontuário dos relatórios não é o id da API** (0 iguais em 38 comparações): nunca misture os dois. Nenhum relatório novo ou editado é necessário para o autoatendimento. Ver `klingo-autoatendimento.md`.


**Estado: os 5 relatórios foram criados no Klingo e testados em 03/11/2026 (só estrutura e contagem de linhas; nenhum valor de paciente foi lido, gravado ou mostrado).** A API do Klingo que usamos só lê (`/api/info/relatorio`), então tudo passa por relatório.

Já usados antes (ver `docs/fase-0-verificacao.md`): **#13825** (marcações, filtro por data de criação), **#7**, **#47**, **#13981/#13983/#13984** (catálogo e preços).

## Relatórios criados

| Letra | Nº | Nome | Filtros (rótulo no Klingo · tipo) |
|---|---|---|---|
| A | **#14024** | CHAT A - Pacientes (Cadastro) | `Paciente - Prontuário` (Apenas), `Paciente - CPF` (Apenas), `Paciente - Nome` (Contém), `Paciente - Celular` (Apenas) |
| B | **#14025** | CHAT B - Marcações do Paciente | `Prontuário` (Apenas), `Paciente - CPF` (Apenas), `Data Agendado Para` (período) |
| C | **#14026** | CHAT C - Resultados / Laudos | `Paciente - Número de Prontuário` (Apenas), `Atendimento - Data` (período) |
| D | **#14027** | CHAT D - Tabela de Preço Particular | `Operadora - Nome` (texto, Apenas) |
| E | **#14028** | CHAT E - Convênio x Procedimento | `Operadora - Nome` (texto, Apenas) |

### Ids dos filtros na API (conferidos em 03/11/2026)
Formato igual ao do #13825: valor em `:parmN=valor`; período em `:periodoN=l`, `:periodoN-from=AAAA-MM-DD`, `:periodoN-to=AAAA-MM-DD`.

| Relatório | Filtros (id → nome) | Resultado do teste |
|---|---|---|
| A #14024 | `parm0` paciente_prontuario, `parm1` paciente_cpf, `parm2` paciente_nome (contém), `parm3` paciente_celular | Colunas conferidas (8). Filtro por nome "contém" funciona. **Sem nenhum filtro o Klingo recusa** ("Relatório sem parâmetros preenchidos"), o que protege contra baixar todos os pacientes |
| B #14025 | `parm0` prontuario, `parm1` paciente_cpf, `periodo2` data_agendado_para | Colunas conferidas (21). Período de 12 meses funciona. Sem filtro, recusa |
| C #14026 | `parm0` paciente_prontuario, `periodo1` atendimento_data | Colunas conferidas (8). Sem filtro, recusa |
| D #14027 | `parm0` operadora_nome | Sem filtro devolve **67.613 linhas** (tabela inteira); com "SUS" 25 |
| E #14028 | `parm0` operadora_nome | Sem filtro **64 linhas**; "Unimed" não existe (0) |

Obs.: uma chamada do B com prontuário "1" e período até 03/11/2026 deu erro "."; com período até 31/10 e com período sem prontuário funcionou. Se o erro voltar, usar data final anterior a hoje. O B com 3 e com 12 meses voltou o mesmo total (17.836), então o histórico do Klingo parece começar há pouco tempo (confirmar com a clínica).

> Colunas do C: não há "Situação do laudo" própria; use `Status - Nome` (col5) e `Laudo - Data Pronto` (col6).

## O que ficou diferente do pedido

- **A:** tem Prontuário, Nome, CPF, nascimento, e-mail, celular, telefone e **Data de Cadastro**. Não existe "última atualização do cadastro" no Klingo; usar a data de cadastro.
- **B:** mesmas colunas do #13825, mais CPF, **Check-In (chegada)** e hora agendada. **Não existe hora real do atendimento.**
- **C:** Id do atendimento, Prontuário, Paciente, Procedimento, data do exame, situação do laudo, data pronto e Id do laudo. **Não há link nem senha do portal** nessa área.
- **D:** Id e nome do procedimento, valor, nome da tabela e operadora. **Sem data de vigência.** Filtrando "Particular" não veio nada (com "SUS" funcionou): o preço Particular parece não ficar nessa área de tabela de preços.
- **E:** Operadora, procedimento, Cobertura (S/N), Autorização Prévia (S/N) e tipo/regra do filtro. **Faltam** Plano, situação do convênio (ativo/inativo), valor da tabela e quantidade máxima por pedido. O valor vem do D ou do #13983.

## Função que usa A, B e C: `klingo-paciente` (03/11/2026)
Edge Function no ar (`supabase/functions/klingo-paciente/`), chamada com `x-sync-key` (= `config.ia_segredo`) e corpo JSON:
- `{"acao":"conferir","cpf":"…","nascimento":"AAAA-MM-DD"}` → `encontrado`, `ambiguo`, `confere`, `prontuario` (só se confere) e `cadastro_faltando` (quais entre email/celular/telefone estão vazios, nunca o valor).
- `{"acao":"historico","prontuario":"…","nascimento":"…","meses":12}` → marcações enxutas (sem nome, CPF, valor, observação nem telefone).
- `{"acao":"resultados","prontuario":"…","nascimento":"…","meses":12}` → atendimentos com `laudo_pronto` (sem link/senha: o Klingo não tem).
Histórico e resultados **só saem depois de o nascimento conferir** com o cadastro daquele prontuário. Máximo de 12 meses (o Klingo recusa períodos maiores) e 200 linhas. Nada de paciente vai para log ou banco.

**Testado sem paciente real:** 11 testes com dados inventados (`testes`: `npm run test:edge`) e chamadas reais com CPF/prontuário inexistente (volta "não encontrado"), entradas inválidas (400) e sem chave (403).
**Ainda NÃO provado com paciente real:** se o Klingo guarda o CPF com ou sem pontos (a função tenta os dois) e em que formato vem o nascimento (aceita AAAA-MM-DD e DD/MM/AAAA). Fazer um teste com um paciente cadastrado, com autorização dele, antes de ligar ao chat.
A função `klingo-inspecionar-chat` (só estrutura/contagem) continua publicada e pode ser apagada no painel.

## Ligado ao chat (03/11/2026, sem n8n)
Quando o paciente preenche **CPF + data de nascimento** no chat, o banco (`supabase/klingo-vinculo.sql`, gatilho `conversa_fluxo_klingo_trg`) chama a `klingo-paciente`, que confere no Klingo e grava o resultado por `paciente_klingo_registrar` (a resposta HTTP não leva dado de paciente). Fica em `paciente_klingo_vinculo` (RLS fechada): situação (`confere`, `divergente`, `nao_encontrado`, `ambiguo`, `erro`), **prontuário (só se o nascimento confere)**, quais campos do cadastro estão vazios e um resumo do histórico (total, data e nome do último exame, 12 meses). Não grava nome, telefone, e-mail nem CPF do Klingo. A equipe vê no resumo da conversa notas como "cadastro localizado (prontuário …)", "nascimento NÃO confere", "CPF não encontrado", "cadastro no Klingo sem: email, celular" e "Histórico no Klingo: N marcações…". Mudou o CPF ou a data na conversa → confere de novo. `config.klingo_paciente_url` vazio desliga.
Ensaiado no banco real em transação desfeita (gatilho, vínculo e notas) e chamada real da função; **não ensaiado com paciente real**.

**Push (os dois, no ar):** equipe (`avisar-equipe`, `config.equipe_push_url` preenchida; testada: 2 aparelhos receberam) e paciente (`chat-avisar`). Cada atendente precisa abrir o painel uma vez e permitir os avisos.

## Pendências anotadas (03/11/2026)
1. **Teste com paciente real** do `klingo-paciente`: o CPF do dono (omitido aqui por privacidade) não foi achado no relatório A (0 linhas nos 3 formatos). Falta saber se o cadastro dele está sem CPF ou se o filtro "Apenas" de CPF não casa. Para fechar: nome completo e nascimento do cadastro, ou outro paciente que autorize.
2. **Resultado de exame: link e senha** serão passados pela equipe (decisão do dono). Falta definir o canal e a tela: sugestão é a atendente enviar pelo chat/painel, com a senha em mensagem separada. O relatório C só diz se o laudo está pronto.
3. **Histórico do Klingo para o paciente ver no chat** (hoje só a equipe vê o resumo; o paciente que volta usa o histórico do próprio chat). `klingo-paciente` já tem as ações `historico` e `resultados` para isso.
4. **Aviso na tela do painel** com o vínculo (selo "Klingo: cadastro incompleto"); hoje aparece só nas notas do resumo.
5. **Suporte do Klingo:** preço Particular; link/senha do resultado; convênio inativado; última atualização do cadastro e hora real do atendimento.
6. **Limpeza que sobrou:** `fila_avisar_n8n`, `fila_entrar` e `fila_reenviar_link` ainda citam o n8n (módulo da fila, `supabase/saida-n8n-fila.sql`, não aplicado). `privacidade.html` cita o n8n: só mudar com revisão jurídica. Apagar a função temporária `klingo-inspecionar-chat` no painel do Supabase.
7. Confirmar com a clínica se o histórico do Klingo é curto (3 e 12 meses deram o mesmo total no relatório B).

## Pendências com o suporte do Klingo
(Texto de e-mail em `docs/fase-0-email-suporte-klingo.md`; acrescentar estas perguntas.)
1. Onde fica cadastrado o **preço Particular** (a tabela "Particular" não aparece no relatório D)?
2. O Klingo gera **link e senha/código do resultado** para o paciente? Qual relatório ou consulta devolve?
3. Há como saber que um **convênio foi inativado** (campo ou relatório)?
4. Existe campo de **última atualização do cadastro** do paciente e de **hora real do atendimento**?

## Próximos passos
- ~~Executar A a E para validar colunas e filtros~~ (feito em 03/11/2026 com a função `klingo-inspecionar-chat`, que só devolve estrutura e contagem).
- Testar `klingo-paciente` com um paciente real cadastrado (ver acima).
- ~~Ligar ao chat~~ (feito, ver acima).
- Enquanto a pergunta 1 não for respondida, o valor Particular continua deduzido das marcações.

## Regra de trabalho
Sempre que uma tarefa depender de relatório do Klingo editado ou criado, o Claude avisa **antes de começar** e diz qual relatório falta. Esta regra está em `CLAUDE.md`.

## Tarefas liberadas (ligadas ao chat; falta testar com paciente real)
Busca de histórico sob demanda (B); verificação por CPF e pedido de atualização de dado (A); ligação automática chat-prontuário com aviso (A).

## Ainda travadas
Envio de link e senha do resultado ao paciente (sem link/senha no C; depende do suporte).


## Relatório #14554 (13/11/2026): todas as marcações com os dados do paciente
Criado pelo dono ("Marcações pela data em que foram marcadas", filtros `periodo0` = marcado em e `parm1` = unidade). 17 colunas: Id, Agendado Em, Agendado Para, Origem, Portal, Responsável, Responsável - Classificação, Procedimento, Operadora, Unidade, Paciente - Nome, Status (Aberta/Cancelada/Bloqueada), CPF, Telefone, e-mail, Nascimento e **Celular**. **Não tem** prontuário, "Atendido S/N", confirmação nem motivo de cancelamento, então **não substitui** o #14359. É a fonte da conferência `docs/klingo-conferencia.md` (Edge Function `klingo-conferir`). Preenchimento medido em 06 a 12/11/2026 (1.990 linhas): nome e nascimento 100%, celular 98%, CPF 68%, e-mail 55%, telefone fixo 15%.

## Relatório por data do exame (#14359, 09/11/2026)
Criado no Klingo ("Agendamentos - Visão Consolidada por Marcação Data Agendado"): é cópia do #13825 com o filtro de período trocado para **Data Agendado Para**. Conferido pela função (só estrutura e contagem, sem dado de paciente): mesmas 18 colunas (col0 a col17) na mesma ordem. **Atenção:** o id do filtro de período é **`periodo1`** (no #13825 é `periodo0`) e o filtro de unidade passou de `parm1` para `parm0`. A Edge Function `sync-jornada-klingo` (versão 5) usa `periodo1` quando `config.jornada_relatorio_filtro = 'exame'`.
Em uso desde 09/11/2026: `config.jornada_relatorio_id = 14359` e `jornada_relatorio_filtro = exame`. Para voltar ao antigo: `13825` e `criacao`.
