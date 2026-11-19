# Consultas oferecidas no chat (Configurações)

**Por quê:** a equipe de atendimento pediu para separar "Consulta Com Pediatra (Neuro Desenvolvimento)" (id 2128, Vanessa Reis) de "Consulta Neuropediatria" (id 1472, Geanne Christina Pinheiro), que se confundiam na escolha do paciente.

**O que existe:** em Painel → Configurações → **Consultas oferecidas no chat**, cada consulta com agenda vigente tem:
- uma chave **Mostrar no chat** (desligar esconde a consulta do paciente; nada muda no Klingo nem na agenda);
- um campo **nome que o paciente vê** (vazio = nome automático).

Só administrador. Vale para as próximas conversas.

**Técnico:** tabela `consulta_config` (sem policy, só funções), `consultas_da_unidade` filtra ocultas e usa o nome personalizado, `consultas_config_listar()` e `consulta_config_salvar(id, oculta, rotulo)` (admin). SQL em `supabase/consultas-config.sql`, já aplicado no projeto.

## Lista oficial de consultas (19/11/2026)

O chat da Desenvoar oferece: **Consulta com pediatra, ortopediatra, endocrinopediatra, neuropediatra e gastropediatra.** Saíram: Pré-Natal, Teleconsulta de Pediatria, "Pediatra (Neuro Desenvolvimento)" e Puericultura (escondidas pela tela de Configurações; dá para religar lá).

- Ortopediatra, endocrinopediatra e gastropediatra tinham sumido em 13/11 porque a API do Klingo só oferece Pediatria, Neurologia e Radiologia (`klingo_so_liberados = sim`). Voltaram pela chave `consultas_sem_api` (ids separados por vírgula, em `config`): consulta nessa lista passa pelo filtro, sem horário da API (cai na grade e a atendente confirma). Quando o Klingo expor a especialidade na API, dá para tirar o id da chave.
- **Cardiopediatra (id 416) não aparece:** só tem agenda na CSI, e a CSI está desligada no chat. Precisa de agenda na Desenvoar ou de ligar a CSI.
- SQL: `supabase/consultas-lista-oficial.sql` (com rollback). Função `klingo_liberado` mudou; retrato em `supabase/producao/funcoes/klingo_liberado.sql`.
- Conversas já abertas com Pré-Natal, Teleconsulta ou Neuro Desenvolvimento (17 itens ativos) seguem no pedido, mas o nome do médico/da consulta nelas pode não aparecer nos textos automáticos.
