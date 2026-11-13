# Análise por três especialistas: IA, software e UX/acessibilidade (13/11/2026)

Uma única pessoa fez as três leituras (orquestração de IA, engenharia de software, UX e acessibilidade) sobre os dados reais das conversas (302 conversas, 5 dias úteis) e sobre o código do repositório. **A parte de acessibilidade é leitura do código, não auditoria com leitor de tela ou ferramenta automática**: ela diz onde há risco, e a confirmação precisa de teste no celular com TalkBack/VoiceOver. Nenhuma mudança de banco ou de tela foi aplicada por este documento.

## Resumo em 10 linhas

1. O chat é um **motor de regras no banco** (bom: previsível, barato, auditável). A IA só lê a foto do pedido (`ler-pedido`).
2. O funil perde mais no **horário**: 39% saem depois dele, 12% deixam a pergunta sem resposta, 27 pedidos de atendente.
3. **81 de 299 conversas (27%) pedem atendente.** Cada uma custa tempo da equipe (mediana de 1,7 min, cauda de 16 min).
4. A **ordem das opções** não segue o uso: com popularidade suavizada a posição média do plano cai de 5,1 para 3,7 em teste fora da amostra.
5. Os textos novos de acolhimento estão prontos, **mas só valem depois de aplicados** (`supabase/textos-acolhimento*.sql`).
6. O código do chat é **um arquivo de 3.284 linhas** com a biblioteca do Supabase carregada **sem versão fixa** de uma CDN.
7. Há **boa base de teste** (60+ testes de banco e de navegador), mas o teste de navegador precisa de preparo manual para rodar.
8. Acessibilidade tem acertos (rótulos, foco, botões de 48 px, letra ajustável, `lang="pt"`), e lacunas (leitura de novas mensagens, modo escuro, texto do mapa do corpo em 11 a 12 px).
9. Para "a máquina aprender", o caminho certo é **aprender a ordenar e a prever**, não treinar um modelo de linguagem com 6.709 mensagens.
10. Toda coleta de texto para aprendizado precisa de **anonimização e aviso na política de privacidade** antes de começar.

---

## 1. Engenheiro de orquestração de IA

### Como está hoje
- Quem conduz a conversa é o banco (`fluxo_*`, ~480 funções em `supabase/producao/funcoes`). A IA entra em um ponto: a foto do pedido, via Claude (`OCR_MODELO`, padrão `claude-opus-5-5`, com o Tesseract no celular em paralelo).
- A conversa tem estados claros (`motivo → consulta → médico → plano → horário → identificação → confirmar`), e o passo atual fica salvo em `conversa_fluxo`. Isso é a melhor base possível para orquestrar IA, porque a IA nunca precisa "adivinhar onde está".

### O que os dados pedem (em ordem de retorno)
| # | Melhoria | Por que (dado) | Risco |
|---|---|---|---|
| 1 | **Reordenar opções por uso** (motivo, plano, assunto) | Plano: posição média 5,09 → 3,66 fora da amostra. Motivo: 2,0 → 1,1 | Baixo; só muda a ordem, nunca esconde |
| 2 | **Entender texto livre dentro do passo** ("Bradesco" digitado vira o botão certo) | 10% digitam fora dos botões no plano; 11% no médico | Médio; usar só como sugestão com confirmação ("Você quis dizer Bradesco Saúde?") |
| 3 | **Ajuda no passo do horário** antes de o paciente sumir | 11,9% sem resposta; 27 pedidos de atendente | Baixo; é um texto/ação a mais, não decide nada |
| 4 | **Resumo para a atendente** quando ela entra | 275 de 302 conversas passam por uma pessoa | Baixo; só lê, não escreve ao paciente |
| 5 | **Sugestão de resposta** com as frases da casa | 10 frases se repetem à mão | Baixo; a atendente aprova antes de enviar |
| 6 | **Previsão de volume e de abandono** (modelo simples, sem IA generativa) | 55 a 80 conversas/dia, pico às 10h | Baixo |

### Desenho recomendado (camadas)
1. **Regras primeiro** (o que existe): rápido, grátis, previsível.
2. **Modelo estatístico leve** (ordenação, abandono, volume): roda no banco ou em uma função agendada. Dados já existem.
3. **Modelo de linguagem só como ajudante restrito**: interpretar texto livre dentro de um passo e propor um botão; nunca confirmar data, horário ou valor; nunca orientar clinicamente (já há o texto `clinico`).
4. **Pessoa sempre à mão**: o botão de atendente já existe e 27% o usam; isso é o termômetro de que a automação está falhando.

### Guardas obrigatórias antes de qualquer IA nova
- **Anonimizar antes de sair do banco**: nomes completos de crianças e responsáveis aparecem repetidos nas mensagens.
- **Resposta estruturada** (o modelo devolve só "opção sugerida" e "confiança"), nunca texto livre ao paciente.
- **Limiar de confiança + confirmação**: abaixo de 0,8, cai em "não entendi" com os botões.
- **Registro de cada decisão** (`klingo_decisao` já faz isso para a automação; copiar o padrão).
- **Conjunto de avaliação fixo**: guardar ~100 conversas anonimizadas e medir toda mudança contra ele (acerto, % de pedidos de atendente).
- **Teto de custo** e **modelo de contingência**: se a IA cair, o chat segue por botões (já é assim).

### "Aprendizado de máquina" na prática, com honestidade
Com 6.709 mensagens em 5 dias úteis, **não há dados para treinar ou ajustar um modelo de linguagem**. Há dados suficientes para: ordenar opções, prever abandono, prever volume por hora. Isso **já é aprendizado de máquina** e sustenta a frase "este espaço aprende com o jeito que as pessoas o usam" — **desde que a ordenação seja aplicada**. Sem ela, o texto novo da tela inicial promete algo que ainda não acontece.

---

## 2. Engenheiro de software

### Pontos fortes
- **Segurança por desenho**: o paciente nunca lê tabela; toda função `chat_*` confere o token da conversa; testes provam isso (`retrato.test.mjs`, `sql-ponta-a-ponta.test.mjs`).
- **Banco como fonte da verdade**, com retrato da produção e teste que acusa função ou parâmetro inexistente.
- **Sem `innerHTML`** em `index.html` (0 ocorrências): o texto do paciente não vira HTML. Bom contra XSS.
- **Monitor próprio** (`sentinela.js`) com código de suporte e sem texto de mensagem.
- Muitos testes (60+ arquivos em `testes/`), migrações com fluxograma, versão e rollback.

### Riscos e melhorias
| # | Achado | Impacto | Sugestão | Esforço |
|---|---|---|---|---|
| 1 | `supabase-js` vem de `cdn.jsdelivr.net/npm/@supabase/supabase-js@2`, **sem versão fixa** e sem verificação de integridade | Uma versão nova da biblioteca pode quebrar o chat sem ninguém ter mexido; se a CDN cair, o chat não abre | Fixar a versão exata (`@2.x.y`), colocar `integrity` + `crossorigin`, e guardar uma cópia local no cache do `sw.js` | Pequeno |
| 2 | `index.html` tem **3.284 linhas** (HTML, CSS e JS juntos); `painel/index.html` tem 4.549 | Difícil de revisar, de testar por partes e de achar regressão | Separar em `chat.css`, `chat.js`, `pedido.js`, `calendario.js` **sem trocar de tecnologia** (sem build); o `sw.js` já lista arquivos | Médio |
| 3 | Textos para o paciente estão **em dois lugares**: `fluxo_texto` (banco) e dentro do `index.html` | A palavra "previsão" ficava em 9 pontos; uma troca esquece um deles | Tudo o que o paciente lê vai para `fluxo_texto`/`config`, o HTML só mostra | Médio |
| 4 | Teste de navegador exige `npm install` e browsers do Playwright na versão certa | Quem for rodar pela primeira vez perde tempo (aconteceu hoje) | Documentar em `testes/README.md` e fixar a versão do Playwright | Pequeno |
| 5 | Ordem das opções **fixa no código SQL** (`fluxo_perguntar`: Exame antes de Consulta, Particular antes de convênios, médicos em ordem alfabética) | Não acompanha o uso | Tabela `fluxo_opcao_uso(passo, opcao, cliques, exibicoes, janela)` recalculada à noite por rotina (como `previsao-vigia`); a função só ordena | Médio |
| 6 | 86 conversas terminam "não respondido" e 134 pedidos ficam em rascunho | Perda de pedido; poluição da fila | Lembrete único e gentil após X minutos de silêncio **dentro do horário de atendimento**; hoje só há "Chamar no WhatsApp" após 24 h | Médio |
| 7 | Mensagens do mesmo paciente em pedaços (389) chegam como várias linhas | Atendente e futura IA leem fragmentado | Agrupar por janela de ~20 s na leitura (visualização e treino), sem mexer no que está gravado | Pequeno |
| 8 | `docs/` e `supabase/*.sql` têm histórico que pode estar diferente do banco | Risco de aplicar versão velha | Já mitigado pelo retrato; manter a regra de partir de `producao/funcoes` | Contínuo |

### Ordem sugerida de trabalho
1. Fixar `supabase-js` + cache no `sw.js` (hora de trabalho, risco quase zero).
2. Aplicar a migração de textos (já pronta) e medir o funil no horário por 1 semana.
3. Tabela de uso das opções + rotina noturna + ordenação por popularidade suavizada (motivo, plano, assunto; **médico não**, para não concentrar demanda).
4. Lembrete gentil de silêncio.
5. Dividir o `index.html` em arquivos.

---

## 3. Especialista em UX e acessibilidade

### O que já está bom (verificado no código)
- `lang="pt-BR"`, `viewport` sem bloqueio de zoom, rótulos `aria-label` em 36 pontos, `aria-live="polite"` na lista de mensagens, `role="alert"` no erro do formulário.
- Botões de opção com **altura mínima de 48 px**; tamanho de letra ajustável (17 px padrão, 20 px no modo maior, guardado no aparelho).
- Foco visível (`:focus-visible`) e respeito a `prefers-reduced-motion` (5 usos).
- `autocomplete` e `inputmode` nos campos principais.
- Mensagens de erro com tom acolhedor e código de suporte.

### Lacunas e sugestões (da mais importante para a menos)
| # | Achado | Quem sofre | Sugestão |
|---|---|---|---|
| 1 | **Passo do horário é onde mais se perde** (39% saem depois; 12% sem resposta; 27 pedidos de atendente) | Todos, em especial quem tem pouca prática com calendário | Mostrar já na primeira linha o **horário mais próximo livre** com botão "Quero este"; calendário completo vira "Ver outros dias". Texto novo (`horario`) já prepara isso |
| 2 | `aria-live="polite"` direto em `<main id="msgs">` sem `role="log"` | Leitor de tela pode ler tudo de novo ou perder a nova pergunta | Usar `role="log"` e mandar o foco para a nova pergunta ou para o primeiro botão quando ela chega |
| 3 | **Sem `aria-describedby`** (0 usos) nos campos com regra (CPF, data, telefone, CEP) | Leitor de tela e quem erra o formato | Ligar a dica e o erro ao campo; mostrar o exemplo ("25/03/1980") **antes** do erro |
| 4 | **Sem modo escuro** (`prefers-color-scheme`: 0) | Quem usa o celular à noite ou tem sensibilidade à luz | Variáveis de cor em `:root` já existem (`--verde`, `--texto`); acrescentar o bloco escuro. Só 5% das mensagens chegam depois das 18h, então é prioridade média |
| 5 | Mapa do corpo com **texto SVG de 11 e 12 px** (não acompanha o tamanho de letra) | Baixa visão, idosos | Escalar com a variável de tamanho usada no resto e manter a **lista** como caminho equivalente (já existe) |
| 6 | 3 telas de confirmação seguidas repetem a ideia "pessoa da equipe confirma" | Cansa e confunde | Dizer uma vez no começo, uma no fim (já reescrito) |
| 7 | Pedido de **CPF e nascimento** logo no começo (desde 12/11) | Quem tem receio de dar dado | Texto já explica "ficam protegidos"; acrescentar **por que agora** e **o que acontece se não quiser dar** (falar com atendente) |
| 8 | 81 pessoas pedem atendente: o botão aparece em todo passo? | Quem trava | Manter **sempre visível**; ao apertar, dizer a fila e o tempo típico (**1,7 min mediana**) em vez de esperar sem informação |
| 9 | Texto do botão de plano em ordem do catálogo (31 a 35 itens, Hapvida em 13º, Planserv em 27º) | Quem tem convênio fora do topo | Ordenar por uso + caixa de busca (já há `filtro`) e **lembrar o último convênio** de quem volta |
| 10 | Listas de médicos em ordem alfabética | Todos | Manter "Tanto faz" em 1º (29% dos cliques); mostrar o **próximo horário livre** ao lado do nome |

### Tom e linguagem
- Textos novos usam "você", frases curtas, 💚, e dizem a verdade: não está confirmado até uma pessoa confirmar.
- Evitar palavras de sistema ("previsão", "rascunho", "passo"). Preferir "pedido", "sugestão", "lista de espera".
- Para o público pediátrico: tratar o responsável pelo nome e o paciente pelo nome da criança (já existe `ola_filho`).

### Teste que falta (importante)
- **Teste com 5 pessoas reais** (idosa, mãe com criança no colo, pessoa com baixa visão, pessoa que nunca usou o chat, atendente) fazendo "marcar consulta de pediatria". É o que mais ensina.
- **TalkBack (Android) e VoiceOver (iPhone)** em: formulário inicial, uma pergunta com botões, calendário, tela de pedido pronto.
- **Contraste**: medir o verde dos botões e o cinza do texto de apoio contra o fundo (mínimo 4,5:1 para texto normal).

---

## Plano conjunto (4 semanas)

| Semana | Entrega | Responsável natural | Como medir |
|---|---|---|---|
| 1 | Fixar `supabase-js`; aplicar textos de acolhimento; documentar rodada de teste | Software | Chat abre sem CDN nova; textos sem "previsão" |
| 1 | Nova tela do horário (primeiro horário livre) | UX + Software | Queda dos 39% de saída; menos pedidos de atendente no horário |
| 2 | Tabela de uso + ordenação (motivo, plano, assunto) | IA + Software | Posição média do clique no plano ≤ 4; % de cliques entre as 5 primeiras ≥ 79% |
| 2 | `role="log"`, `aria-describedby`, foco na nova pergunta | UX | Passa no teste com TalkBack |
| 3 | Lembrete gentil de silêncio; respostas rápidas para atendentes | Software + UX | Queda dos 28% "não respondido" |
| 3 | Modo escuro e mapa do corpo com texto escalável | UX | Revisão visual nos dois temas |
| 4 | Exportação anonimizada + conjunto de avaliação | IA | Revisão por amostra: zero nome ou CPF |
| 4 | Primeira previsão de volume por hora (média móvel) | IA | Erro < 20% contra a semana seguinte |

## Cuidados que valem para tudo
1. **LGPD**: a política de privacidade ainda é rascunho; use de conversas para melhorar o serviço precisa estar escrito e revisado por advogado.
2. **Dados de crianças**: tratamento com consentimento de responsável (art. 14); a anonimização não pode ser só "tirar o nome" (data de nascimento + unidade já identifica).
3. **Medir antes e depois** de cada mudança; os números deste relatório são de 5 dias úteis e **mudam**.
4. **Uma mudança por vez** nas telas que mais perdem pedido (horário), para saber o que funcionou.

*Dados de 13/11/2026. Documentos relacionados: `analise-conversas-2026-11-13.md`, `revisao-textos-e-ordenacao-2026-11-13.md`.*
