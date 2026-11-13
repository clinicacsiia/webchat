# Revisão do chat: o que pode quebrar, ordem das perguntas e uso da API de agenda (13/11/2026)

Feita sobre o código da branch `ccr-9adf6e2b-p1p009` e a produção (só estrutura, contagens e configuração; nenhum texto de paciente).

## 1. Resposta curta

| Pergunta | Resposta |
|---|---|
| Algo vai quebrar com as mudanças de texto? | **Não encontrei quebra.** Todas as suítes de banco passaram; o teste novo dos textos passou (19 de 19). Os 27 testes de tela também passaram. |
| A ordem das perguntas está perfeita? | **A ordem está correta para o que o sistema precisa**, com 3 ajustes pequenos (seção 3). Não vale inverter CPF e horário: a API exige CPF, nascimento e plano **antes** de mostrar horários. |
| Tudo consulta a API de agenda? | **Não. Hoje quase nada consulta a API de horários.** A API de horários nunca gravou uma oferta (0 linhas em `klingo_oferta`) e está limitada ao telefone de teste. A tela mostra a agenda "ao vivo" pelos relatórios do Klingo. Detalhes e como ligar de forma segura na seção 4. |

## 2. O que pode quebrar: testes

| Grupo | Resultado |
|---|---|
| Retrato do banco (`test:retrato`) | 10 de 10 |
| Banco: 40+ suítes (fila, pessoa, encerramento, agendado, voltar, ao vivo, klingo-auto 69/69, ponta a ponta 19/19, produção 29/29...) | **todas passaram** |
| Textos novos (`sql-textos-acolhimento.test.mjs`, criado hoje) | **19 de 19**: marcadores `{nome}` `{paciente}` `{plano}` `{itens}` `{total}` `{resumo}` preservados; texto editado pela equipe não é sobrescrito; rodar duas vezes não muda nada; nenhum texto novo do paciente contém "previsão"; o valor `lista` do botão continua igual |
| Navegador do chat (`sentinela.navegador`) | 19 de 19, incluindo a tela inicial nova e a mensagem final |
| Edge functions (`test:edge`) | passou |
| `test:python` (biometria) | **não rodou aqui**: falta `pytest` no ambiente. Não tem relação com o chat |
| Navegador do painel e demais telas | **27 de 27 suítes passaram** |

**Testes de tela (27 suítes de navegador): todas passaram**, incluindo chat (corrida, voltar, encerramento, despedida, avaliação, agenda ao vivo, equipe assume, histórico, login, foto do pedido), painel (quadro, jornada, indicadores, convênios, catálogo, médicos, recarga, equipe agora) e o monitor do chat (19/19). Os arquivos de teste de navegador do chat rodaram com a tela nova de 13/11/2026.

### Riscos que encontrei no código
1. **`supabase-js@2` sem versão fixa e sem integridade**, carregado de CDN (`index.html:644`). Uma versão nova pode quebrar o chat sem ninguém mexer. Fixar a versão exata e guardar no cache do `sw.js`.
2. **Textos em dois lugares** (banco e `index.html`). Hoje estão alinhados, mas o teste novo só cobre o banco; o texto da tela é coberto pelo teste de navegador.
3. **Se aplicar só uma das partes** (banco ou tela), o paciente vê textos misturados. Aplicar as duas juntas.
4. **Nenhuma mudança de texto mexe em lógica**: os passos (`motivo`, `consulta`, `plano`...) e os valores dos botões não mudaram.

## 3. Ordem das perguntas

> **Correção de 13/11/2026:** a ordem real na produção é **CPF e nascimento primeiro**, antes do menu (ver `api-em-todo-o-processo.md`). O texto abaixo partiu do retrato antigo do banco; a conclusão (CPF antes de plano e horário) continua valendo.

Ordem real (`fluxo_proximo`):

`identidade (só quem já tem cadastro) → atalho (repetir pedido anterior) → motivo → consulta/exame → médico (só se houver mais de um) → CPF e nascimento → plano → horário → "mudou?" (só cadastro antigo) → identificação → contato → confirmar → pronto`

### O que está certo e deve ficar
- **CPF e nascimento antes de plano e horário**: a API de horários exige os dois (`dados_incompletos` se faltar CPF, nascimento ou plano). Inverter faria o chat mostrar horário sem poder conferir na API.
- **Plano antes do horário**: o horário só existe para aquele convênio.
- **Médico antes do horário**: a agenda é por médico.
- **Identificação e contato depois do horário**: o paciente já viu valor (o horário) antes de dar mais dados. É a ordem que menos desiste.
- **Confirmar por último**, com resumo e botão único "Está tudo certo" (82% dos cliques).

### Ajustes que recomendo (nenhum quebra nada)
1. **Motivo**: hoje "Exame" aparece antes de "Consulta", mas 93% escolhem consulta. Colocar **Consulta primeiro** (posição média do clique cai de 2,0 para 1,1).
2. **Plano**: ordenar por uso (SulAmérica, Bradesco, Unimed vêm antes de "Particular"). Posição média 5,09 → 3,66 em teste fora da amostra.
3. **Assunto**: colocar "Outro assunto" mais acima (foi o mais escolhido, 5 de 9). Amostra pequena; rever na próxima rodada.
4. **Explicar o porquê do CPF no momento certo**: o texto `cpf_nasc` já diz que "ficam protegidos". Acrescentar "para mostrar só os horários que existem de verdade para você" liga o pedido ao benefício. Dos 12 pacientes que viram o passo desde 12/11, os 12 seguiram em frente, e 3 pediram atendente depois. Amostra pequena: **medir de novo em 2 semanas**.

### O que não mexer ainda
- **Médicos**: manter "Tanto faz" primeiro e ordem alfabética. Ordenar por popularidade concentraria a demanda em poucos médicos.

## 4. A API de agenda: o que consulta o quê

### Como o horário chega ao paciente hoje
1. Ao chegar no passo, o chat chama duas coisas em paralelo (`index.html`, `carregarHorarios`):
   - **`chat-agenda-ao-vivo`**: lê o Klingo **agora** (relatórios) e atualiza a ocupação no banco. Config `agenda_ao_vivo = sim`, até 14 dias. **Está ligada para todos.**
   - **`chat-agenda-api`**: pede à **API do Klingo** os horários reais. É ela que o plano chama de "API de agenda".
2. Depois o chat pede a lista ao banco (`chat_horarios`), que já enxerga a ocupação de agora.

### O estado real da API de horários
| Item | Valor hoje | Significa |
|---|---|---|
| `klingo_auto` (chave mestra) | `teste` | A API só vale para o telefone de teste da lista `klingo_api_telefones_teste` (1 número) |
| `klingo_api_horarios` | `sombra` | Pensado para medir sem mostrar. **Mas** com a chave mestra em `teste`, o código troca para modo `sim` e só deixa passar o telefone de teste, então **a medição em sombra não acontece para os pacientes reais** |
| `klingo_oferta` (horários da API gravados) | **0 linhas, nunca** | A API de horários **nunca rodou** para nenhum paciente |
| `klingo_medida` dos últimos 8 dias | só conferência de identidade (44 confere, 15 divergente, 65 não encontrado em 12/11) | Não há nenhuma medida de horário (`horarios_api_ok`, `horarios_ms_*`) |
| `klingo_especialidade` com `liberada_api` | 3 de 3 | Só 3 especialidades estão liberadas para a API; o resto cai na grade |
| `klingo_proc_api` | 325 procedimentos, 322 com horário | A tabela de aprendizado de exames já foi preenchida |
| `klingo_plano_map` | 36 operadoras traduzidas | A tradução convênio → plano do Klingo existe |

**Conclusão:** o "autogestor" (`klingo_autogestao = sim`) espera 30+ consultas boas na API para subir de `sombra` para `sim`, mas **nenhuma consulta de horários acontece** com a chave mestra em `teste`. Ele **nunca vai subir sozinho** neste estado.

### Para a API de agenda valer para todos (caminho seguro)
1. **Medir primeiro, sem mostrar**: colocar `klingo_auto = 'legado'` (usa só a chave `klingo_api_horarios = sombra`) por 3 a 5 dias úteis. Cada paciente que chega ao horário gera 1 consulta à API (precisa de CPF e nascimento válidos; a resposta é gravada em `klingo_oferta` e comparada com a grade, **o paciente não vê diferença**). Atenção ao limite de chamadas (`klingo_cota`).
2. **Conferir os números** contra os critérios do plano (`docs/klingo-autoatendimento.md`): 30+ consultas, ≤ 5% de erro, ≤ 5% mais lentas que 3 s, 200+ horários comparados, ≥ 85% dos horários da API também na grade.
3. **Passar para `sim`** quando os números permitirem: o calendário passa a mostrar só o que a API também oferece. O autogestor faz isso sozinho.
4. **Exames**: só entram quando a especialidade/procedimento estiver liberado (`liberada_api`); hoje o chat é 98% consultas, então o ganho está nelas.
5. **Se a API falhar** (limite, lentidão, convênio sem tradução): o chat **já cai na grade ao vivo** e nunca trava (`chat-agenda-api` devolve `ok:false` e o chat segue). Isso foi desenhado assim e funciona.

### O que não é possível dizer hoje
- **"Tudo consulta a API de agenda"**: não é verdade, nem seria seguro dizer. O passo seguro é medir em sombra e ligar por critério. Marcar (`klingo_api_marcar`), cancelar/remarcar (`klingo_api_pos`) e pré-cadastro (`klingo_api_pre_cadastro`) estão em `teste` pelo mesmo motivo.

## 5. O que fazer, em ordem

1. **Aplicar juntos** os textos de acolhimento (`supabase/textos-acolhimento.sql` e `...-botao.sql`) e a tela nova (`index.html` `2026.11.13-2`). *Precisa do seu "sim".*
2. **Fixar a versão do `supabase-js`** e guardar no cache do `sw.js`.
3. **Colocar Consulta primeiro** e ordenar o plano por uso (migração em `fluxo_perguntar`, com teste no clone).
4. **Ligar a medição da API de horários** (`klingo_auto = 'legado'` + `sombra`) por uma semana. *Mudança de configuração em produção que chama a API externa para pacientes reais: precisa do seu "sim".*
5. **Rever em 2 semanas**: CPF depois dos textos novos, funil do horário, pedidos de atendente.

*Dados de 13/11/2026; mudam todo dia.*
