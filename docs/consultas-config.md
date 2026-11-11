# Consultas oferecidas no chat (Configurações)

**Por quê:** a equipe de atendimento pediu para separar "Consulta Com Pediatra (Neuro Desenvolvimento)" (id 2128, Vanessa Reis) de "Consulta Neuropediatria" (id 1472, Geanne Christina Pinheiro), que se confundiam na escolha do paciente.

**O que existe:** em Painel → Configurações → **Consultas oferecidas no chat**, cada consulta com agenda vigente tem:
- uma chave **Mostrar no chat** (desligar esconde a consulta do paciente; nada muda no Klingo nem na agenda);
- um campo **nome que o paciente vê** (vazio = nome automático).

Só administrador. Vale para as próximas conversas.

**Técnico:** tabela `consulta_config` (sem policy, só funções), `consultas_da_unidade` filtra ocultas e usa o nome personalizado, `consultas_config_listar()` e `consulta_config_salvar(id, oculta, rotulo)` (admin). SQL em `supabase/consultas-config.sql`, já aplicado no projeto.
