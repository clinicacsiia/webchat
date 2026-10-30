# Fase 6: roteiro para testar e colocar em produção

Atualizado em 30/10/2026. Descrição da fase: `docs/fase6-unidade-e-medico.md`.

## Situação em 30/10/2026

| Item | Estado |
|---|---|
| Banco (Fase 6 e 6b) | **Aplicado e conferido** em 30/10/2026: migrações `fase6_unidade_filho_e_ia_contexto`, `fase6_remove_chat_iniciar_antiga`, `fase6_catalogo_horarios_identidade`, `fase6_consulta_e_irmaos`, `fase6_fecha_funcoes_internas` (e o `fase6b-alerta-preco.sql`, rodado no SQL Editor) |
| Código (chat, painel, docs) | Mesclado na `main` pelo PR #18 |
| n8n | **Pendente: versão antiga publicada** (`7bcf2009-34ff-4085-a17f-a931ff68188f`). Sem as mudanças a IA não segue as instruções novas, não abre o seletor de consulta e ainda pode falar preço |
| Funções provisórias da Fase 3 | Já não existem no banco |
| Dados de teste | 4 contatos de teste ainda no banco (ver "Antes de abrir") |
| PR #15 (Fila + assinatura biométrica) | Rascunho, **não mesclar**. Independente da Fase 6 |

## Passo a passo que falta

1. **n8n** (fluxo `Triagem IA - Atendimento`): fazer as mudanças a), b), c) e d) de "Mudança no n8n" em `docs/fase6-unidade-e-medico.md` e **publicar**. Se algo der errado, restaure a versão `7bcf2009-34ff-4085-a17f-a931ff68188f`.
2. **Testar** (próxima seção) com telefones `7190000xxxx` e um atendente com o painel aberto.
3. **Limpar os dados de teste** e abrir ao público.

Conferência do banco (deve dar tudo `true`; já deu em 30/10/2026):

```sql
select to_regclass('public.unidade_config') is not null as unidades,
  (select count(*) = 3 from public.unidade_config) as tres_unidades,
  (select count(*) = 2 from public.atendimento_tipo) as tipos,
  to_regprocedure('public.chat_irmao_iniciar(uuid,text)') is not null as irmao,
  to_regprocedure('public.chat_consulta_salvar(uuid,text,integer)') is not null as consulta,
  position('v_pref' in pg_get_functiondef('public.chat_horarios(uuid,text,integer,date,date,text,text,jsonb)'::regprocedure)) > 0 as horarios,
  position('v_uni' in pg_get_functiondef('public.ia_catalogo(text,uuid)'::regprocedure)) > 0 as catalogo,
  position('paciente_tipo' in pg_get_functiondef('public.paciente_conferir(uuid)'::regprocedure)) > 0 as identidade,
  to_regclass('public.alerta_preco') is not null as alerta_preco,
  exists (select 1 from pg_trigger where tgname = 'mensagens_conferir_preco') as gatilho_preco,
  position('''precos'', v_precos' in pg_get_functiondef('public.ia_catalogo(text,uuid)'::regprocedure)) = 0 as ia_sem_preco,
  (select count(*) = 1 from pg_proc where proname = 'chat_iniciar' and pronamespace = 'public'::regnamespace) as so_uma_chat_iniciar;
```

## Roteiro de teste

Use telefones de teste `7190000xxxx` e deixe um atendente com o painel aberto. Em cada caso, olhe o **chat** e o **painel**.

| # | Faça | Deve acontecer |
|---|---|---|
| 1 | Formulário: nenhuma unidade escolhida, clicar em Iniciar | Pede para escolher a unidade |
| 2 | Escolher Desenvoar | "Quem será atendido?" vem em "Meu filho ou filha"; aparece "Seu nome (responsável)" e "Nome completo da criança"; médico de preferência vem depois do e-mail com 13 nomes |
| 3 | Desenvoar, filho "Lucas", responsável "Maria", sem mensagem | O chat abre com "Olá! Quero agendar para Lucas." e a IA responde "Olá, Maria! ... para o Lucas" **pelos nomes**. Painel: "Maria · Lucas", unidade Desenvoar |
| 4 | Pedir consulta de pediatria | A IA abre "Escolher o tipo de consulta"; escolher "Consulta de Pediatria"; **não** aparece mapa do corpo |
| 5 | Plano Particular, depois abrir o calendário | Só horários da Desenvoar; se escolheu médico, só dele (com "Ver outros médicos") |
| 6 | Dados: nome da criança, nascimento, mãe, CPF | A IA pede os dados **da criança** e o celular do responsável; resumo para a atendente diz que o CPF é do responsável, se for o caso |
| 7 | Novo formulário com "+ Tenho outro filho(a)" (Pedro) e **Os dois juntos** | Ao terminar o Lucas, a faixa verde mostra "Agendar para Pedro"; ao tocar, o chat abre com "com o mesmo pedido de Lucas", o pedido vem copiado e o calendário já marca o horário **logo depois** do Lucas |
| 8 | Igual ao 7 com **Um de cada vez** | Pedro começa do zero (sem pedido copiado) |
| 9 | CSI + "Eu mesmo(a)" + "quero uma ressonância do joelho" | Vai ao mapa do corpo (não pergunta unidade); só exames da CSI |
| 10 | CSI RM/TC + pedir consulta | Explica que ali é ressonância e tomografia e oferece a CSI |
| 11 | "Ainda não sei" + "meu filho está com tosse" | A IA sugere a Desenvoar |
| 12 | Uma mãe que já é paciente (nome + telefone iguais a um cadastro) falando pelo filho | A IA **não** reaproveita CPF/endereço dela no pedido do filho |
| 13 | Atendente marca no Klingo a consulta do passo 5 | Em até ~15 s o status vira "Agendado" sozinho (Fase 3, ainda sem prova real) |

| 14 | Atendente assume uma conversa com pedido de exame e plano Particular e escreve um valor **muito diferente** do catálogo (ex.: metade) | Só no painel: selo "Conferir valor" na lista e faixa vermelha na conversa com o valor de referência. O chat do paciente **não** mostra nada |
| 15 | Na mesma conversa, escrever o valor certo (ou até 10% de diferença) | Nenhum alerta novo |
| 16 | Perguntar ao chat "quanto custa?" | A IA **não** diz valor: diz que o atendente informa |

Teste 12 e 13 são os mais importantes e os únicos sem prova em produção.

## Antes de abrir para pacientes de verdade

- [ ] **Dados de teste**: hoje há 4 contatos (9 conversas, 90 mensagens) que parecem testes da equipe (`71992641845`, `71988710544`, `71999999999`, `71988780134`). Confirme quais apagar e peça: apagar o contato apaga conversas, mensagens e pedidos (cascata). O Supabase pede confirmação para `delete`.
- [ ] **Preços** (agora só referência para o alerta): a auditoria achou 18 de 104 preços do catálogo a 10% ou mais do Klingo (aba Aprendizado > "Preço x Klingo"). A recepção revisa antes de divulgar.
- [ ] **n8n**: nó de IA sem repetição e sem aviso de erro, e dependente dos créditos do n8n. Recomendado: credencial Anthropic própria, `retryOnFail` e um workflow de erro que avise a equipe.
- [ ] **Segredo `ia_segredo`** digitado nos nós HTTP do n8n: mover para credencial Header Auth.
- [ ] **Supabase Auth**: ligar "Prevent use of leaked passwords"; conferir "Confirm email", "Allow new users to sign up" desligado depois de cadastrar a equipe, e as URLs de redirecionamento (`LEIAME.md`).
- [ ] **Klingo**: enviar o e-mail ao suporte (`docs/fase-0-email-suporte-klingo.md`), principalmente a pergunta sobre aviso/webhook de marcação.
- [ ] **Edge Function**: baixar a versão publicada e comparar com `supabase/functions/sync-catalogo-klingo/`.
- [ ] **Treinar a recepção**: três filhos da mesma mãe aparecem como três conversas ("Maria · Lucas", "Maria · Pedro"...).

## Como desfazer

- **Chat/painel**: reverter o merge no GitHub (o Pages republica). O painel antigo funciona sem as colunas novas.
- **n8n**: restaurar a versão `7bcf2009-34ff-4085-a17f-a931ff68188f`.
- **Banco**: as colunas e tabelas novas são aditivas e não atrapalham a versão antiga; a nova `chat_iniciar` aceita as mesmas chamadas antigas (testado com o chat antigo).

## Fora desta fase

- **Fila + assinatura biométrica** (PR #15): não está pronta. Faltam a tela do paciente, a aba da recepção, os fluxos do n8n e a migração. Veredito em `docs/auditoria-2026-10-30.md` (na branch do PR).
- **EEG e outros exames da Desenvoar** pelo calendário.
