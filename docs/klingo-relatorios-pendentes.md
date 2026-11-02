# PENDÊNCIA CRÍTICA: relatórios do Klingo que precisam ser editados ou criados (02/11/2026)

**Estado: NADA disso existe ainda (atualizado em 02/11/2026: acrescentados os relatórios D e E, de preço Particular e de convênio × procedimento).** Sem eles, o sistema não consegue ligar o chat ao paciente do Klingo, confirmar quem é o paciente por CPF, buscar histórico sob demanda nem entregar resultado. A API do Klingo que usamos só lê (`/api/info/relatorio`), então tudo passa por relatório.

Hoje o sistema usa só estes (ver `docs/fase-0-verificacao.md`): **#13825** (marcações, filtro por data de criação), **#7**, **#47**, **#13981/#13983/#13984** (catálogo e preços). Nenhum traz CPF, nascimento ou e-mail, e nenhum filtra por paciente.

## O que preciso que você faça no Klingo

### Relatório A (NOVO): "Pacientes – cadastro"
Para validar quem é o paciente, ligar chat e prontuário e saber o que precisa ser atualizado.
- **Colunas:** Prontuário, Nome, **CPF**, **Data de nascimento**, **E-mail**, Celular, Telefone, Sexo (opcional), Data da última atualização do cadastro, Convênio/Operadora e carteirinha (opcionais).
- **Filtros (o mais importante):** por **Prontuário**, por **CPF**, por **Nome** e por **Celular**. Sem filtro por paciente o sistema teria de baixar todos os pacientes.

### Relatório B (NOVO ou cópia do #13825): "Marcações do paciente"
Histórico sob demanda: só o que a atendente pede, sem carregar tudo.
- **Colunas:** as mesmas do #13825 (Id da Marcação, Id do Atendimento, Prontuário, Agendado Em, Agendado Para, Procedimento, Operadora, Unidade, Confirm Status, Cancelamento - Motivo, Status, Atendido S/N). Se o Klingo permitir, acrescentar **hora de chegada** e **hora do atendimento**.
- **Filtros:** por **Prontuário** (ou CPF) **e** período longo (12 meses ou mais). Hoje o #13825 só filtra pela data em que a marcação foi criada.

### Relatório C (NOVO, se o Klingo tiver): "Resultados / laudos"
Para enviar o resultado ao paciente.
- **Colunas:** Id do Atendimento, Prontuário, Procedimento, Data do exame, **Situação do laudo** (pendente, liberado, entregue), Data de liberação e, se existir, **link do resultado** e **usuário/senha ou código de acesso** do portal do paciente.
- **Filtros:** por Prontuário e por período.
- **Pergunta para o suporte do Klingo:** o Klingo gera link e senha do resultado pelo paciente? Se sim, qual relatório ou consulta devolve? (Texto de e-mail pronto em `docs/fase-0-email-suporte-klingo.md`; acrescente esta pergunta.)

### Relatório D (NOVO): "Tabela de preço Particular por procedimento"
Hoje o valor Particular é **deduzido das marcações** (o valor mais comum em marcações recentes) e oscila: a CONSULTA já apareceu como R$ 380, R$ 220 e R$ 380 de novo. Com a tabela oficial o painel de Convênios deixa de adivinhar e passa a avisar quando o valor muda de verdade.
- **Colunas:** Id do procedimento (o mesmo do catálogo), Nome do procedimento, **Valor Particular em reais**, **Data de início da vigência** (e fim, se houver), Tabela de preço (nome).
- **Filtros:** nenhum obrigatório (a tabela inteira); se tiver, por vigência.

### Relatório E (NOVO ou editar o #13981): "Convênio × procedimento: situação e cobertura"
Para o painel saber, por convênio e por exame, se o convênio está ativo no Klingo, se cobre o exame, o valor da tabela do convênio e se exige autorização ou limite de quantidade.
- **Colunas:** Operadora/Convênio, Plano, **Situação do convênio (ativo/inativo)**, Id do procedimento, Nome, **Cobre (S/N)**, **Valor da tabela do convênio**, **Exige autorização (S/N)**, Quantidade máxima por pedido (se existir), Data da última alteração.
- **Filtros:** por Operadora e por Situação.
- **Pergunta para o suporte do Klingo:** quando o cadastro de um convênio é inativado, o relatório traz isso? Qual campo?

### O que o painel já faz SEM esses dois relatórios (02/11/2026)
A aba **Convênios** do painel já liga/desliga cada convênio, guarda mensagem e regra ("um exame por vez") por convênio e avisa mudanças de preço, usando o que já temos (#13825, #7, #13981/#13983/#13984). Os relatórios D e E só tornam os números mais confiáveis: **sem eles continua valendo o valor deduzido das marcações e o desligamento é manual.**

## O que eu preciso de volta
O **número** de cada relatório novo (ou do #13825 alterado) e os **nomes exatos dos filtros**, para configurar a leitura. Não preciso do token: ele continua num secret do Supabase.

## Regra de trabalho
Sempre que uma tarefa depender de relatório do Klingo editado ou criado, o Claude avisa **antes de começar** e diz qual relatório falta. Esta regra está em `CLAUDE.md`.

## Tarefas travadas por isto
Busca de histórico sob demanda; verificação por CPF e pedido de atualização de dado; ligação automática chat-prontuário com aviso; envio de link e senha do resultado ao paciente.
