# Outro assunto: o chat resolve sozinho o que dá (31/10/2026)

Arquivo `supabase/assuntos-resolvidos.sql` (**ainda não aplicado** no Supabase; rodar depois de `fase7-motor.sql`, `fase4-paciente-que-volta.sql` e `correcao-convenio-quem-volta.sql`; pode rodar de novo sem problema).

| Opção do paciente | Antes | Agora |
|---|---|---|
| **Cancelar um horário** | "Conte em poucas palavras", o atendente lê | Se a data de nascimento foi conferida e há exame marcado para o futuro: lista os horários, pede "Sim, cancelar" e entrega à equipe "Cancelar Ultrassom (ambos) de 20/11/2026". O atendente só cancela e confirma |
| **Remarcar um horário** | Idem | Mesma lista. Escolhendo o horário mais recente, o exame é copiado e o paciente segue sozinho pelo convênio e pelo calendário; a equipe recebe a nota "REMARCAÇÃO de ...: cancelar o horário antigo e marcar o novo". Outro horário da lista vai para a equipe já dizendo qual |
| **Resultado de exame** | Atendente | Mostra os links dos dois portais (`fluxo_texto.resultado_orientacao`) com "Resolveu, obrigado" e "Preciso de um atendente". **Texto vazio = continua indo para o atendente** |
| Dúvida, Reclamação, Outro assunto | Atendente | Sem mudança (decisão de 31/10/2026) |

Sem cadastro conferido, sem exame marcado no futuro ou se o exame não puder ser copiado, tudo cai no "Conte em poucas palavras", como antes. A lista só aparece depois da conferência da data de nascimento (mesma regra do histórico).

## Resultado de exame: portais já cadastrados

O texto padrão já traz os dois portais: exames até 31/08/2026 em `resultados.mezzow.com` e a partir de 01/09/2026 em `portal-clinicacsi.klingo.app`. Para mudar (inclusive esvaziar e voltar ao atendente):

```sql
update public.fluxo_texto set texto = 'novo texto' where chave = 'resultado_orientacao';
```

Os outros textos novos (`assunto_qual_remarcar`, `assunto_qual_cancelar`, `assunto_confirma`, `assunto_remarcar_ok`, `assunto_fim`) também podem ser editados em `fluxo_texto`.

## Limites conhecidos

- O site só conhece os horários que o Klingo já sincronizou no histórico (`paciente_historico`, campo `futuro`); consultas ainda não aparecem nessa lista.
- Remarcar copia o exame só do horário mais recente (é o que `pre_reaproveitar` faz hoje).
- Cancelar e remarcar continuam sendo confirmados por um atendente no Klingo; o chat só tira o trabalho de perguntar.
- Não testado contra o Supabase real: `npm run test:assuntos` (21 verificações) usa o Postgres embutido com as funções reais do motor.
