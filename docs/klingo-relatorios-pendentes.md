# Relatórios do Klingo para o chat (atualizado em 03/11/2026)

**Estado: os 5 relatórios foram criados no Klingo (acesso só do Claude). Só o D foi executado; A, B, C e E estão salvos, mas sem teste de execução.** A API do Klingo que usamos só lê (`/api/info/relatorio`), então tudo passa por relatório.

Já usados antes (ver `docs/fase-0-verificacao.md`): **#13825** (marcações, filtro por data de criação), **#7**, **#47**, **#13981/#13983/#13984** (catálogo e preços).

## Relatórios criados

| Letra | Nº | Nome | Filtros (rótulo no Klingo · tipo) |
|---|---|---|---|
| A | **#14024** | CHAT A - Pacientes (Cadastro) | `Paciente - Prontuário` (Apenas), `Paciente - CPF` (Apenas), `Paciente - Nome` (Contém), `Paciente - Celular` (Apenas) |
| B | **#14025** | CHAT B - Marcações do Paciente | `Prontuário` (Apenas), `Paciente - CPF` (Apenas), `Data Agendado Para` (período) |
| C | **#14026** | CHAT C - Resultados / Laudos | `Paciente - Número de Prontuário` (Apenas), `Atendimento - Data` (período) |
| D | **#14027** | CHAT D - Tabela de Preço Particular | `Operadora - Nome` (texto, Apenas) |
| E | **#14028** | CHAT E - Convênio x Procedimento | `Operadora - Nome` (texto, Apenas) |

> Só o rótulo do D foi **conferido na tela de execução**. Os de A, B, C e E foram deduzidos (abrir a tela rodaria o relatório com dado de paciente): confirmar no primeiro teste. O B filtra só por "Data Agendado Para"; se precisar de período pela chegada, acrescentar "Check-In - Data".

## O que ficou diferente do pedido

- **A:** tem Prontuário, Nome, CPF, nascimento, e-mail, celular, telefone e **Data de Cadastro**. Não existe "última atualização do cadastro" no Klingo; usar a data de cadastro.
- **B:** mesmas colunas do #13825, mais CPF, **Check-In (chegada)** e hora agendada. **Não existe hora real do atendimento.**
- **C:** Id do atendimento, Prontuário, Paciente, Procedimento, data do exame, situação do laudo, data pronto e Id do laudo. **Não há link nem senha do portal** nessa área.
- **D:** Id e nome do procedimento, valor, nome da tabela e operadora. **Sem data de vigência.** Filtrando "Particular" não veio nada (com "SUS" funcionou): o preço Particular parece não ficar nessa área de tabela de preços.
- **E:** Operadora, procedimento, Cobertura (S/N), Autorização Prévia (S/N) e tipo/regra do filtro. **Faltam** Plano, situação do convênio (ativo/inativo), valor da tabela e quantidade máxima por pedido. O valor vem do D ou do #13983.

## Pendências com o suporte do Klingo
(Texto de e-mail em `docs/fase-0-email-suporte-klingo.md`; acrescentar estas perguntas.)
1. Onde fica cadastrado o **preço Particular** (a tabela "Particular" não aparece no relatório D)?
2. O Klingo gera **link e senha/código do resultado** para o paciente? Qual relatório ou consulta devolve?
3. Há como saber que um **convênio foi inativado** (campo ou relatório)?
4. Existe campo de **última atualização do cadastro** do paciente e de **hora real do atendimento**?

## Próximos passos
- Executar A, B, C e E uma vez para validar colunas e filtros (cuidado: A, B e C trazem dado de paciente).
- Configurar a leitura no sistema com os nomes exatos dos filtros.
- Enquanto a pergunta 1 não for respondida, o valor Particular continua deduzido das marcações.

## Regra de trabalho
Sempre que uma tarefa depender de relatório do Klingo editado ou criado, o Claude avisa **antes de começar** e diz qual relatório falta. Esta regra está em `CLAUDE.md`.

## Tarefas agora liberadas (dependem do teste de A, B, C)
Busca de histórico sob demanda (B); verificação por CPF e pedido de atualização de dado (A); ligação automática chat-prontuário com aviso (A).

## Ainda travadas
Envio de link e senha do resultado ao paciente (sem link/senha no C; depende do suporte).
