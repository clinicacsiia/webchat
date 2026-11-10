# Pendências (atualizado em 11/11/2026)

Lista para continuar em outra conversa. Leia junto com `docs/aplicacao-2026-11-10.md` (o que está no ar, como desligar e como conferir) e `docs/planejamento-auditoria-2026-11-10.md` (decisões e conflitos).

**Estado em 11/11/2026 (conferido no banco):** tudo das Etapas 0, A, C1, B, D e E está aplicado no Supabase; as duas branches (PR #118 e PR #119) já estão na `main`. Congelamento dos indicadores ligado (`indicadores_fechar = sim`, 12 dias fechados); `permissao_modo = observacao`; `reabrir_dias = 2`; `vinculo_manual_quem = equipe`; autoria do agendamento aplicada; 30 conversas de teste do passado marcadas.

## 1. Só você consegue

| # | O quê |
|---|---|
| V1 | **Teste de ponta a ponta no celular e no painel** (roteiro dado na conversa de 11/11/2026) |
| V2 | **Dados da Etapa B:** e-mails de Juliana e Luzia (para criar as contas); autorização para mudar o papel da Carla Adrielle (administradora → supervisora); unidade das equipes de Carla Adrielle e Juliana; quem atende em cada equipe (hoje "Atendente 1 a 4") |
| V3 | **Código do caso do nome corrigido** (AGE-01), para testar o reconhecimento |
| V4 | **Aprovar os 3 textos** (inatividade, previsão, convênio suspenso) — estão no ar com a redação proposta, editáveis em `config` |
| V5 | **Dados pessoais no histórico do Git:** os arquivos atuais já foram mascarados, mas o histórico guarda os originais. Decidir: reescrever o histórico e/ou tornar o repositório privado |
| V6 | Confirmar que "Tasy" = Klingo |

## 2. Com o suporte do Klingo
Nenhum relatório novo a editar ou criar. Pendente: onde fica o **preço Particular** (hoje o cardápio mostra "Sob consulta"); campo de **convênio inativado**; **última atualização do cadastro**; **hora real do atendimento**. Texto em `docs/fase-0-email-suporte-klingo.md`.

## 3. Falta fazer (Claude)
1. Convênio **esmaecido** na lista do chat, com o aviso entre parênteses (hoje o convênio suspenso some da lista).
2. Aplicar a regra de unidade também a `pacientes`, `pre_agendamentos` e `contatos`; tirar o `update` direto de `conversas` pelo navegador.
3. **Ligar `permissao_modo`** — só depois do V2 e de conferir a simulação (hoje Carla Fernandes veria 8 de 31 conversas e Aimê Brito 22, porque ninguém está ligado a equipe/unidade).
4. MON-04 (travamento por atendente, sem reprodução); histórico completo da pessoa (CONV-04); separar "ao vivo" × "histórico" (CONV-05).
5. Cardápio: ao receber a resposta do Klingo sobre o preço Particular, trocar "Sob consulta" pelos valores.
6. Atualizar `LEIAME.md` e `docs/` a cada etapa concluída.

## 4. Cuidados que continuam valendo
- Responder em português do Brasil, linguagem simples; nunca criar PR sem pedido; enviar só para a branch de trabalho.
- Segredo, telefone e e-mail da TI nunca no repositório.
- Migrações do Supabase: `create or replace`, partes pequenas, evitar `drop trigger`. Se uma pergunta de confirmação ficar sem resposta, parar e avisar.
- Avisar sobre relatórios do Klingo pendentes antes de tarefas que dependam deles.
- Testes: `cd testes && CHROMIUM_PATH=/opt/pw-browsers/chromium npm test` (`test:python` não roda neste ambiente por falta do `pytest`).
