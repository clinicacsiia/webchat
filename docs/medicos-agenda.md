# Aba Médicos (05/11/2026)

Aba só do administrador no painel. Mostra cada médico por unidade com a agenda do Klingo (relatório #13984, já sincronizado) **já preenchida**, e deixa limitar dias e horário (ex.: só segunda e quarta; só das 8h às 12h).

- **Regra = filtro sobre a grade do Klingo.** Só reduz: o chat nunca oferece horário que o Klingo não tem. O atendimento precisa terminar até a hora final. Sem regra, vale o Klingo. Tabela `medico_regra` (a sincronização não apaga).
- **Atende / Bloqueado no chat:** usa o bloqueio que já existe (`profissional_bloqueio`, `supabase/agenda-medica-bloqueio.sql`, PR #69). Bloquear avisa quem já tinha escolhido o médico.
- **Aviso de mudança:** ao fim de cada sincronização da agenda, o banco compara com a grade que a equipe conferiu por último (`medico_base`). Mudou, médico novo ou médico que saiu → aviso pendente + selo vermelho no menu "Médicos".
  - *Aceitar e atualizar a agenda:* vale a grade nova (a regra de dias/horas do médico sai; a observação fica).
  - *Manter como estava:* a grade anterior vira regra, e o chat segue oferecendo só o que valia. Em médico novo, "Não liberar" bloqueia no chat.
  - O primeiro uso só guarda a base: nenhum aviso falso para a agenda de hoje.
- Salas e equipamentos (RM, TC, RX, ultrassom, mamografia…) ficam escondidos e não geram aviso.
- Não depende dos relatórios pendentes do Klingo (usa só o #13984, que já existia).

## Como aplicar (SQL Editor ou migração em partes; o arquivo não tem `drop`)
1. `supabase/agenda-medica-bloqueio.sql` (as partes 1, 2 e 3a já estão no banco; falta a **3b**: `profissional_bloquear` e `profissional_liberar`).
2. `supabase/medicos-regras.sql`, seções 1, 2, 3 e 4, nessa ordem.
3. Publicar o painel (`painel/index.html`).

Testes: `npm run test:medicos-sql` (29 casos, banco embutido) e `npm run test:medicos` (5 casos, navegador).
