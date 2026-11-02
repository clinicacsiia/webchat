# Pendências da correção "uma pessoa" (02/11/2026)

## Já está no banco
- Data de nascimento com erro de digitação (1996 x 1997, dia e mês trocados) não separa a pessoa (`pessoa_nasc_parecida`, `pessoa_sinais`).
- `pessoa_unir_grupos`: une dois grupos quando ninguém de um contradiz ninguém do outro. Ligada aos dois gatilhos.
- Fila de chegada acha TODAS as conversas e TODOS os pedidos da pessoa, com ou sem conta (`pessoa_conversas_de`, `pessoa_pedidos_de`, `pessoa_resumo_de`, `fila_identificar_todos`).

## Pendente (precisa de você)
1. **Apagar os 7 bloqueios automáticos antigos** (criados só pelo 1996 digitado errado). O Supabase pede aprovação em comando com `delete` e expira em 60 s. Rode no editor SQL (https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/sql/new):
   `delete from public.conversa_grupo_recusa where por is null and jsonb_array_length(public.pessoa_sinais(a, b) -> 'conflitos') = 0;`
   Depois: `select sum(public.pessoa_unir_grupos(id)) from public.conversas;` (deve unir os 3 grupos do Alisson).
2. **Aviso à atendente quando a data diverge** (perguntar a data certa, juntar ou manter separado). Ainda não feito.
3. **Paciente no centro** (uma conversa por paciente, status de cada exame, histórico de faltas, oferta de reagendar). Ainda não feito.
4. **Entrega de resultado** (link + usuário e senha). Falta o link que você já tinha mandado e a regra "exame antes de setembro".
