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
- Só vê atendimento **já feito** (Atendido) e só **desde 30/08/2026** (o histórico do relatório começa aí). Consulta marcada e ainda não feita não conta.
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
