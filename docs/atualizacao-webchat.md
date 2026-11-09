# Atualização do WebChat: lista para não esquecer (09/11/2026)

Planilha de origem: `Backlog_Atualizacao_WebChat` (ajustada ao programa). Esta lista é o **controle**: cada item tem quem faz e o link de onde. Marque aqui quando terminar.

Projeto Supabase: `nrvuynjwcgwpjdptkiay`. Editor de SQL: https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/sql/new

## Decisões tomadas

| Nº | Decisão |
|---|---|
| D1 | Motivos de encerramento (5): **Agendado**, **Apenas informações**, **Não respondido** (automático), **Paciente desistiu**, **Outro motivo** |
| D2 | **Agendado** pode encerrar mesmo com exame futuro; os outros motivos continuam bloqueados por exame em aberto |
| D3 | 24 h **corridas**; só conta mensagem de pessoa da equipe (não do assistente); pessoa com várias conversas só fecha se todas estiverem vencidas |
| D4 | Despedida vazia = frase de hoje; avaliação em todo fechamento com despedida, **menos Não respondido** |
| D5 | Avaliação sem nome nem telefone; texto de privacidade passa pelo jurídico |
| D6 | "Reconhecido" = pré-agendamento com status `agendado` |

## O que eu faço e o que é seu

Legenda: **[Claude]** eu faço no repositório; **[Você]** só você consegue.

| # | Etapa | Quem | Estado |
|---|---|---|---|
| 0 | Diagnóstico WC-01 (`docs/wc01-diagnostico.md`) | Claude | **Feito** |
| 1 | **[Você]** Escolher 1 ou 2 pacientes já marcados no Klingo que aparecem como `pronto` no painel (com autorização) para fechar o WC-02 | Você | Pendente |
| 2 | **[Você]** Criar no Klingo o relatório **"Jornada do Paciente - Marcações por Data do Exame"** (duplicar o #13825; trocar o filtro de período para *Data Agendado Para*; anotar o número). Depois me passe o número para gravar em `config.jornada_relatorio_id` e `jornada_relatorio_filtro = 'exame'`. Passos completos na tabela `jornada_pendencia`, chave `relatorio_por_data_exame` | Você | Pendente |
| 3 | WC-03 Motivo no encerramento: código, SQL e testes | Claude | Em andamento |
| 4 | **[Você]** Aplicar `supabase/encerramento-motivo.sql` no Supabase (editor de SQL, uma parte por vez; tudo começa **desligado**) | Você | Depois do passo 3 |
| 5 | WC-04 Agendado com validação da agenda | Claude | Depois do 3 |
| 6 | WC-05/06 Despedida configurável e publicada | Claude | Depois do 3 |
| 7 | WC-07 Cabeçalho mais baixo | Claude | Independente |
| 8 | WC-08 Autoencerramento 24 h (começa em **simulação**) | Claude | Depois do 3 e do 6 |
| 9 | WC-09/10 Avaliação opcional | Claude | Depois do 3 e do 6 |
| 10 | WC-02 Correção do reconhecimento | Claude | Depois dos passos 1 e 2 |

## Ordem para ligar (sempre uma chave por vez, com um dia de uso entre elas)

1. Publicar o site (GitHub Pages) com o painel e o chat novos. Nada muda enquanto as chaves estiverem desligadas.
2. `config.encerramento_exige_motivo = 'sim'` (WC-03).
3. `config.encerramento_valida_agendado = 'sim'` (WC-04).
4. `config.despedida_configurada = 'sim'` (WC-06).
5. `config.autoencerrar_modo = 'simulacao'`, olhar a contagem por alguns dias, depois `'ligado'` (WC-08).
6. `config.avaliacao_ativa = 'sim'` (WC-10), **só depois** do jurídico revisar `privacidade.html`.

Para desfazer qualquer uma: volte a chave para `nao` (ou `desligado`). Efeito imediato, sem publicar nada.

## Para não esquecer depois

- [ ] Jurídico revisar a página `privacidade.html` (avaliação é dado novo) antes do passo 6.
- [ ] Testar no celular depois de cada publicação (GitHub Pages).
- [ ] Depois de ligar o WC-03, conferir a aba **Indicadores** e o **quadro** (contagens iguais).
- [ ] Rodar `cd testes && npm test` antes de cada publicação.
- [ ] Atualizar o `LEIAME.md` a cada etapa concluída.
