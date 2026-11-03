# Relatórios do Klingo para o chat (atualizado em 03/11/2026)

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

## Pendências com o suporte do Klingo
(Texto de e-mail em `docs/fase-0-email-suporte-klingo.md`; acrescentar estas perguntas.)
1. Onde fica cadastrado o **preço Particular** (a tabela "Particular" não aparece no relatório D)?
2. O Klingo gera **link e senha/código do resultado** para o paciente? Qual relatório ou consulta devolve?
3. Há como saber que um **convênio foi inativado** (campo ou relatório)?
4. Existe campo de **última atualização do cadastro** do paciente e de **hora real do atendimento**?

## Próximos passos
- ~~Executar A a E para validar colunas e filtros~~ (feito em 03/11/2026 com a função `klingo-inspecionar-chat`, que só devolve estrutura e contagem).
- Testar `klingo-paciente` com um paciente real cadastrado (ver acima).
- Ligar a função ao chat/n8n (verificação por CPF, pedido de atualização de dado, histórico sob demanda). Ainda não ligada.
- Enquanto a pergunta 1 não for respondida, o valor Particular continua deduzido das marcações.

## Regra de trabalho
Sempre que uma tarefa depender de relatório do Klingo editado ou criado, o Claude avisa **antes de começar** e diz qual relatório falta. Esta regra está em `CLAUDE.md`.

## Tarefas agora liberadas (função pronta; falta ligar ao chat e testar com paciente real)
Busca de histórico sob demanda (B); verificação por CPF e pedido de atualização de dado (A); ligação automática chat-prontuário com aviso (A).

## Ainda travadas
Envio de link e senha do resultado ao paciente (sem link/senha no C; depende do suporte).
