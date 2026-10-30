# Fase 6: roteiro para testar e colocar em produção

Atualizado em 30/10/2026. Descrição da fase: `docs/fase6-unidade-e-medico.md`.

## Situação em 30/10/2026

| Item | Estado |
|---|---|
| Código (chat, painel, SQL, docs) | Pronto na branch `claude/bold-clarke-igv39k`, **sem PR aberto** |
| SQL no banco | **Não aplicado** (conferido: `unidade_config` não existe) |
| n8n | **Versão antiga publicada** (`7bcf2009-34ff-4085-a17f-a931ff68188f`) |
| PR #15 (Fila + assinatura biométrica) | Rascunho, **não mesclar**. Independente da Fase 6. Só conflita em `LEIAME.md` (texto) |
| PRs #1 a #14, #16, #17 | Todos mesclados |

## Passo a passo (nesta ordem)

1. **Banco**: Supabase > SQL Editor > rodar `supabase/fase6-unidade-e-medico.sql` inteiro (pode rodar de novo sem estragar nada). Conferir com:

```sql
select to_regclass('public.unidade_config') is not null as unidades,
  (select count(*) = 3 from public.unidade_config) as tres_unidades,
  (select count(*) = 2 from public.atendimento_tipo) as tipos,
  to_regprocedure('public.chat_irmao_iniciar(uuid,text)') is not null as irmao,
  to_regprocedure('public.chat_consulta_salvar(uuid,text,integer)') is not null as consulta,
  position('v_pref' in pg_get_functiondef('public.chat_horarios(uuid,text,integer,date,date,text,text,jsonb)'::regprocedure)) > 0 as horarios,
  position('v_uni' in pg_get_functiondef('public.ia_catalogo(text,uuid)'::regprocedure)) > 0 as catalogo,
  position('paciente_tipo' in pg_get_functiondef('public.paciente_conferir(uuid)'::regprocedure)) > 0 as identidade;
```
Tudo `true`. Se o script parar com "Trecho não encontrado", alguém mudou uma dessas funções: não force, chame o Claude.

2. **Limpeza da função antiga** (só depois do passo 1; o Supabase pede confirmação):
```sql
drop function public.chat_iniciar(text, text, text, text, boolean, text);
```
Sem isso o chat novo falha com "function is not unique".

3. **n8n** (fluxo `Triagem IA - Atendimento`): fazer as quatro mudanças de "Mudança no n8n" em `docs/fase6-unidade-e-medico.md` (mensagem do usuário, prompt, nó "Ler resposta da IA") e **publicar**. A versão atual é a `7bcf2009-34ff-4085-a17f-a931ff68188f`: se algo der errado, restaure-a no histórico de versões.

4. **Publicar o chat e o painel**: abrir o PR da branch `claude/bold-clarke-igv39k` para `main` e mesclar (o GitHub Pages publica sozinho em ~1 min). Se o PR #15 for mesclado depois, o único conflito é no `LEIAME.md`.

5. **Testar** (próxima seção). 6. **Limpar os dados de teste** e abrir ao público.

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

Teste 12 e 13 são os mais importantes e os únicos sem prova em produção.

## Antes de abrir para pacientes de verdade

- [ ] **Dados de teste**: hoje há 4 contatos (9 conversas, 90 mensagens) que parecem testes da equipe (`71992641845`, `71988710544`, `71999999999`, `71988780134`). Confirme quais apagar e peça: apagar o contato apaga conversas, mensagens e pedidos (cascata). O Supabase pede confirmação para `delete`.
- [ ] **Preços**: a auditoria achou 18 de 104 preços do catálogo a 10% ou mais do Klingo (aba Aprendizado > "Preço x Klingo"). A recepção revisa antes de divulgar.
- [ ] **n8n**: nó de IA sem repetição e sem aviso de erro, e dependente dos créditos do n8n. Recomendado: credencial Anthropic própria, `retryOnFail` e um workflow de erro que avise a equipe.
- [ ] **Segredo `ia_segredo`** digitado nos nós HTTP do n8n: mover para credencial Header Auth.
- [ ] **Supabase Auth**: ligar "Prevent use of leaked passwords"; conferir "Confirm email", "Allow new users to sign up" desligado depois de cadastrar a equipe, e as URLs de redirecionamento (`LEIAME.md`).
- [ ] **Função provisória**: remover `agenda_conferir_pre_agendamentos()` e `agenda_conferencia_iniciar(boolean)` (comando no fim de `supabase/fase3-conferencia-automatica.sql`).
- [ ] **Klingo**: enviar o e-mail ao suporte (`docs/fase-0-email-suporte-klingo.md`), principalmente a pergunta sobre aviso/webhook de marcação.
- [ ] **Edge Function**: baixar a versão publicada e comparar com `supabase/functions/sync-catalogo-klingo/`.
- [ ] **Treinar a recepção**: três filhos da mesma mãe aparecem como três conversas ("Maria · Lucas", "Maria · Pedro"...).

## Como desfazer

- **Chat/painel**: reverter o merge no GitHub (o Pages republica). O painel antigo funciona sem as colunas novas.
- **n8n**: restaurar a versão `7bcf2009-34ff-4085-a17f-a931ff68188f`.
- **Banco**: as colunas e tabelas novas são aditivas e não atrapalham a versão antiga; a única mudança incompatível é o `drop` da `chat_iniciar` antiga (a nova aceita as mesmas chamadas antigas, então o chat antigo continua funcionando).

## Fora desta fase

- **Fila + assinatura biométrica** (PR #15): não está pronta. Faltam a tela do paciente, a aba da recepção, os fluxos do n8n e a migração. Veredito em `docs/auditoria-2026-10-30.md` (na branch do PR).
- **EEG e outros exames da Desenvoar** pelo calendário.
