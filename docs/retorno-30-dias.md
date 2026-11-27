# Consulta na mesma especialidade com menos de 30 dias: só com atendente (17/11/2026)

**Regra (pedido do dono):** se o paciente pede consulta numa especialidade em que já foi atendido há **menos de 30 dias**, o chat avisa que o atendimento tem menos de 30 dias, passa a conversa para a atendente e **não marca nada**.

Mensagem ao paciente: "Identifiquei que {você / nome da criança} foi atendido(a) em consulta de {Especialidade} há menos de 30 dias. Nesse caso, o agendamento é feito por uma atendente, que já vai falar com você por aqui. Nada foi marcado ainda." O texto não traz nome de médico nem a data (quem digitou CPF e nascimento de outra pessoa não vê o histórico dela). A atendente recebe a nota "RETORNO EM MENOS DE 30 DIAS: já atendido(a) em consulta de X há N dia(s) (data, pelo Klingo)".

## Como ligar e desligar (Configurações > "Retorno em menos de 30 dias")
- `retorno_dias_modo` = sim/nao. **Nasceu `sim`** (pedido direto do dono). `nao` volta tudo ao jeito de antes, na hora.
- `retorno_dias_limite` = 30 (dias). "Menos de 30" = 0 a 29 dias desde o atendimento; com 30 dias exatos já marca sozinho.
- Desligar: `update public.config set valor = 'nao' where chave = 'retorno_dias_modo';`

## Como decide (`retorno_recente_ok`)
1. Só vale para **consulta** (exame nunca) e não vale para **remarcar** uma consulta já marcada.
2. **Especialidade pedida:** a do cadastro dos médicos na agenda de consultas (`catalogo_agenda`) para o procedimento escolhido. Se o paciente escolheu um médico, vale a especialidade dele; no "tanto faz", a dos médicos oferecidos.
3. **Atendimento anterior:** `consulta_feita` (relatório #14637, ver `primeira-consulta.md`), achado pelo hash de CPF + nascimento ou pelo prontuário do vínculo. O relatório só traz o **profissional**: a especialidade do atendimento vem do cadastro desse profissional na agenda de consultas. Qualquer médico da mesma especialidade conta (não só o mesmo).
4. Duas travas, como na primeira consulta: `fluxo_proximo` (logo depois da escolha do médico: passo `retorno_recente`) e `klingo_pode_marcar` (segunda trava, motivo `retorno_recente`).

## O que NÃO cobre (limites do Klingo)
- Pelo relatório #14637 só vê atendimento **já feito** (Atendido) e só **desde 30/08/2026**. Desde 27/11/2026 há uma segunda fonte (seção abaixo): consulta **marcada** nos últimos 30 dias que o Klingo mostra no vínculo do paciente e que não consta como atendida também vai para a atendente.
- Atendimento com profissional que não está na agenda de consultas (exames, radiologia) não conta.
- 2 médicos têm duas especialidades na agenda (Clínica Médica + Radiologia/Urologia): atendimento com eles conta para as duas; na dúvida vai para a atendente.
- A leitura do #14637 roda a cada 10 min no expediente (anteontem, ontem, hoje): atendimento de hoje pode demorar para aparecer.
- O Klingo não diz se o convênio considera retorno; a atendente decide.

## Medido na produção (17/11/2026, só contagens)
347 conversas de consulta: 22 seriam encaminhadas (todas Pediatria), 192 sem atendimento recente, 131 sem CPF ainda, 2 sem consulta. Tempo ~9 ms por chamada (limite do chat: 3 s).

## Arquivos
`supabase/retorno-30-dias-parte1..4-*.sql` (fluxograma, versão e rollback no cabeçalho; aplicadas na produção em 17/11/2026 como `retorno_30_dias_parte1_regra`, `parte4_pode_marcar`, `parte3_fluxo_perguntar`, `parte2_fluxo_proximo`; as partes 2 e 3 foram aplicadas como remendo exato sobre a definição da produção, o resultado é o mesmo do arquivo), `testes/sql-retorno-30-dias.test.mjs` (`npm run test:retorno-30-dias`, 25 verificações), painel (grupo em Configurações; `painel/sw.js` v58). Nenhuma tela do chat mudou: o aviso é uma mensagem do motor.

## Rollback
Desligar pela chave acima. Para remover: recriar `fluxo_proximo`, `fluxo_perguntar` e `klingo_pode_marcar` pelas versões anteriores no git de `supabase/producao/funcoes/` e apagar `retorno_recente_ok` e `fluxo_retorno_equipe`.

## Relatório do Klingo
Nenhum relatório novo nem editado: usa só o #14637, já em uso. Se um dia o relatório trouxer a especialidade ou o procedimento do atendimento, a regra fica mais exata (hoje ela deduz pelo médico).


## Atualização de 27/11/2026: consulta marcada que não consta como atendida
**O que aconteceu:** um bebê tinha consulta em 25/11 (CSI Pediatria) que o Klingo não mostrava como Atendido; o chat marcou 21/12 sozinho (26 dias) e o convênio só autoriza com 30 dias. Outro caso igual em 18/11 (última consulta 16/11, chat marcou 11/12). Os dois já estão no arquivo entregue ao dono.

**Duas causas:**
1. A trava só olhava consulta **feita** (`consulta_feita`). Consulta que o Klingo não fecha como Atendido (ou fecha depois) passava batido.
2. A rotina `consulta-atendida-sync` (a cada 10 min) só relê anteontem, ontem e hoje. O que o Klingo fecha depois disso nunca entrava: em 27/11 a recarga de 14 dias achou **538 atendimentos que faltavam** (cerca de 27% desde 16/11).

**O que mudou** (`supabase/retorno-30-dias-parte5-marcacao-recente.sql` e `parte6-recarga-diaria.sql`; aplicadas como `retorno_30_dias_parte5a_marcacao_recente_regra`, `parte5b_marcacao_recente_aviso`, `parte6_recarga_diaria`):
- `retorno_recente_ok`: se não achou atendimento feito, olha a **última marcação ativa de consulta** do vínculo (`paciente_klingo_vinculo.historico`, relatório B, sem canceladas, até hoje). Se está dentro dos últimos 30 dias e aquele dia **não** consta em `consulta_feita` (se constasse em outra especialidade, não bloqueia), bloqueia com motivo `marcacao_recente`.
- `fluxo_retorno_equipe`: texto próprio ao paciente (`retorno_equipe_marcacao`: "teve uma consulta marcada há menos de 30 dias... a atendente agenda"; não diz "atendido") e nota para a equipe pedindo conferir se a consulta foi feita e se o convênio libera.
- Rotina nova `consulta-atendida-recarga` (03h10 de Brasília): relê os últimos 30 dias todo dia. Desfazer: `select cron.unschedule('consulta-atendida-recarga');`.

**Limites:** o vínculo guarda só a última marcação e o nome genérico "CONSULTA" (sem especialidade): sem prova de que foi outra especialidade, vai para a atendente. Quem faltou à consulta recente também vai para a atendente. Medido na produção (10 dias, 121 conversas de consulta com vínculo): 19 a mais iriam para a atendente (antes da recarga; a recarga reduz esse número).
**Testes:** `npm run test:retorno-30-dias` (37 verificações). **Rollback:** desligar tudo com `retorno_dias_modo = 'nao'`, ou recriar as duas funções pela versão anterior no git.
