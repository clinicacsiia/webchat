# Pendências da correção "uma pessoa" (02/11/2026)

## Já está no banco
- Data de nascimento com erro de digitação (1996 x 1997, dia e mês trocados) não separa a pessoa (`pessoa_nasc_parecida`, `pessoa_sinais`).
- `pessoa_unir_grupos`: une dois grupos quando ninguém de um contradiz ninguém do outro. Ligada aos dois gatilhos.
- Fila de chegada acha TODAS as conversas e TODOS os pedidos da pessoa, com ou sem conta (`pessoa_conversas_de`, `pessoa_pedidos_de`, `pessoa_resumo_de`, `fila_identificar_todos`).

## Pendente (precisa de você)
1. **Apagar os 7 bloqueios automáticos antigos** (criados só pelo 1996 digitado errado). O Supabase pede aprovação em comando com `delete` e expira em 60 s. Rode no editor SQL (https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/sql/new):
   `delete from public.conversa_grupo_recusa where por is null and jsonb_array_length(public.pessoa_sinais(a, b) -> 'conflitos') = 0;`
   Depois: `select sum(public.pessoa_unir_grupos(id)) from public.conversas;` (deve unir os 3 grupos do Alisson).
2. **Aviso à atendente quando a data diverge**: FEITO (cartão "Data de nascimento diferente" no alto da lista: escolher a data certa e unir, ou manter separado).
3. **Paciente no centro**: PARCIAL. Feito o bloco "Histórico do paciente" no chat (todos os exames de todas as conversas, com o passo de cada um e o que fazer: oferecer de novo, registrar recusa). Falta: uma conversa só na lista para o atendente (hoje já é uma por pessoa quando agrupada) e o módulo `.js` que recalcula o passo a passo.
4. **Entrega de resultado** (link + usuário e senha): PENDENTE. Falta o link e a regra "exame antes de setembro".

## Klingo como centro do paciente (02/11/2026)
- FEITO: `paciente_klingo(conversa)` acha o paciente no Klingo pelo nome + marca do telefone (ou pelo vínculo manual) e traz os exames dele. O bloco "Histórico do paciente" mostra "No Klingo" ao lado dos pedidos do chat.
- Limites de hoje: o Klingo carregado cobre só 30/10 a 01/12, e guarda só nome + marca do telefone (sem e-mail nem nascimento, de propósito, por privacidade). 967 de 2.396 pacientes não têm prontuário (chave gerada por nome + telefone).
- DECISÕES SUAS: (1) puxar histórico mais antigo do Klingo? (2) guardar telefone, e-mail e nascimento reais do Klingo no banco, hoje só a marca? (3) ligar o chat ao prontuário automaticamente (hoje só a leitura).

## Decisões do dono sobre o Klingo (02/11/2026)
1. Histórico antigo: SÓ SOB DEMANDA. A atendente (ou o paciente, pelo atendente virtual) pede e o sistema pesquisa o Klingo na hora, só aquele paciente, sem puxar tudo e sem pressa. Se o Klingo não permitir, perguntar ao paciente pelo atendente virtual.
2. Dados reais: guardar o que for preciso para ter certeza de que o paciente é ele ou para atualizar dados (telefone, e-mail, nascimento, CPF). O CPF é o fator para pedir atualização de um dado (as outras conferências já terão passado).
3. Ligação automática chat <-> prontuário do Klingo, com notificação (como já é no cadastro novo). Sempre que alguém se cadastra ou tenta agendar, conferir com o que vem do Klingo.
BLOQUEIO: o código só usa o relatório do Klingo (api-externa.klingo.app/api/info/relatorio), que traz nome e telefone, sem CPF, e-mail nem nascimento. Falta saber qual consulta do Klingo devolve paciente por prontuário/CPF, ou incluir essas colunas no relatório.
SUPABASE: aprovações de `delete` expiram. Solução definitiva: em https://claude.ai/customize/connectors, abrir o Supabase e deixar execute_sql e apply_migration em "Sempre permitir".
