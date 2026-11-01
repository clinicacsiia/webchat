# Pendências de UI — CSI

## 1. Logo oficial da CSI ausente
- **Arquivo/componente:** `painel/index.html`, `.marca` na `aside.lateral` (função `montarApp`).
- **Problema:** `/logo-csi-branca.svg` não existe no repositório. O único ícone é `icon-192.png` / `icon-512.png`, um balão de conversa genérico, que não é a logomarca da CSI.
- **Impedimento:** não se inventa logomarca; um `<img>` apontando para arquivo inexistente mostraria imagem quebrada.
- **Ação necessária:** colocar o SVG oficial branco em `/logo-csi-branca.svg` (ou informar o caminho real) e então trocar o texto "Atendimento" de `.marca` por `<img src="/logo-csi-branca.svg" alt="CSI - Clínica de Saúde e Imagem">`.
- **Prioridade:** alta.

## 2. Dados institucionais não aparecem no celular
- **Arquivo/componente:** `painel/index.html`, `.inst` (rodapé da sidebar), regra `@media (max-width: 860px)`.
- **Problema:** abaixo de 860 px a sidebar vira barra de navegação inferior, sem espaço para o bloco institucional; ele fica oculto (`display: none`).
- **Impedimento:** a barra inferior é o mecanismo mobile existente e não pode ser transformada em menu com rodapé sem criar nova lógica de abrir e fechar painel.
- **Ação necessária:** decidir um segundo ponto de exibição no celular (por exemplo, a tela de Configurações, que só o administrador vê, ou a tela de login) e inserir o mesmo bloco.
- **Prioridade:** média.

## 3. Aprovação dos tons complementares por contraste
- **Arquivo/componente:** `painel/index.html` e `index.html`, tokens `--csi-primary-strong` (`#006ba1`), `--csi-danger-strong` (`#b3261e`) e `--csi-success-strong` (`#167a43`).
- **Problema:** `#0088cc` com texto branco dá 3,89:1, `#e74c3c` sobre `#fdf2f0` dá 3,48:1 e `#7f8c8d` sobre branco dá 3,48:1, todos abaixo dos 4,5:1 do WCAG AA para texto pequeno. Os tokens obrigatórios foram mantidos exatos e são usados em bordas, foco, indicadores e alertas. Nos preenchimentos com texto branco (balão enviado, item ativo da sidebar, botões, filtro ativo) e nos textos de alerta entram os tons complementares.
- **Impedimento:** decisão visual que muda a aparência prevista (azul um pouco mais escuro nos preenchimentos com texto).
- **Ação necessária:** o responsável pela marca aprovar os tons, ou indicar outro par que cumpra 4,5:1.
- **Prioridade:** baixa.

## 4. ~~Painel de Atendimento sem cabeçalho de página e sem indicadores~~ (feito em 01/11/2026)
**Resolvido:** título, data e quatro cartões (Conversas hoje, Em espera, Encerradas hoje, Alertas), calculados do que o painel já carrega, sem consulta nova. Não há "variação vs. dia anterior" porque não há dado do dia anterior. Também entraram a barra de busca no topo (filtra a lista e o quadro por nome, telefone e última mensagem), o sino e o nome de quem está logado.

_Texto original:_
- **Arquivo/componente:** `painel/index.html`, `viewAtendimento()`.
- **Problema:** a aba Atendimento abre direto em lista, quadro e conversa, sem título "Painel de Atendimento" nem cartões de indicadores (Atendimentos Hoje, Em Espera, Concluídos, Alertas). Os cartões `.num` existem só em outras abas.
- **Impedimento:** criar o cabeçalho e os indicadores exige novo bloco de interface e novas consultas ou contagens, o que é lógica nova e está fora do escopo visual.
- **Ação necessária:** aprovar a evolução e definir a origem de cada número, que deve vir de dados reais.
- **Prioridade:** média.

## 5. ~~Menu da sidebar sem ícones~~ (feito em 01/11/2026)
**Resolvido:** ícones de traço (SVG embutido, sem biblioteca) antes de cada item; `data-aba`, `onclick` e os selos foram mantidos. Linhas da lista ganharam avatar com iniciais e etiquetas de status coloridas.

_Texto original:_
- **Arquivo/componente:** `painel/index.html`, `nav.nav button` (função `montarApp`).
- **Problema:** os itens têm só texto, sem os ícones uniformes da referência visual.
- **Impedimento:** o projeto não tem biblioteca de ícones, e incluir ícones exige alterar a estrutura interna dos botões que têm `onclick`, `data-aba` e selos de contagem usados por testes.
- **Ação necessária:** escolher um conjunto de ícones SVG e aprovar a alteração do conteúdo dos botões.
- **Prioridade:** baixa.

## 6. Portal "Minha vez" fora do design system
- **Arquivo/componente:** `minha-vez/index.html`.
- **Problema:** mantém a paleta antiga (`#1d5fb8`), fora das três áreas pedidas (sidebar, atendimento e chat).
- **Impedimento:** não foi incluído no escopo desta tarefa.
- **Ação necessária:** confirmar se o portal também deve receber os tokens `--csi-*`.
- **Prioridade:** baixa.

## 7. Fonte Inter não está carregada
- **Arquivo/componente:** `painel/index.html` e `index.html`, token `--font-family`.
- **Problema:** `Inter` só aparece em aparelhos que a tenham instalada; nos demais vale `system-ui`.
- **Impedimento:** carregar de CDN cria dependência externa, e hospedar localmente exige adicionar arquivos de fonte e ajustar o `sw.js`.
- **Ação necessária:** decidir se a fonte será hospedada no repositório.
- **Prioridade:** baixa.

## 8. Verificação visual parcial e sem imagem de referência
- **Arquivo/componente:** todas as telas do painel e do chat.
- **Problema:** foram inspecionadas a olho, em captura, só a aba Atendimento (lista, conversa e quadro) do painel em 1440, 1024, 768 e 390 px e o chat do paciente em 420 px, com dados simulados. Em 1920 e 1366 px (painel) e 1440 px (chat do paciente) só se verificou por script que não há rolagem horizontal; as capturas não foram vistas. Jornada, Fila, Contatos, Equipe, Catálogo, Aprendizado, Configurações, login, o formulário inicial do chat, as folhas, o calendário e o mapa do corpo só passaram nos testes de fumaça (sem exceção de JavaScript), sem conferência visual. Não havia imagem de referência anexada para comparação.
- **Impedimento:** essas telas dependem de dados do Supabase real ou de fluxos longos que os simulados dos testes não cobrem.
- **Ação necessária:** abrir cada aba e tela no ambiente real e conferir contraste, alinhamento e quebra de linha.
- **Prioridade:** média.

## 9. Testes Python não executados
- **Arquivo/componente:** `biometria/test_avaliar_assinatura.py` (`npm run test:python`).
- **Problema:** `pytest` não está instalado neste ambiente, então a cadeia `npm test` parou nessa etapa. As demais suítes foram executadas uma a uma e passaram.
- **Impedimento:** limitação do ambiente. A mudança não toca o módulo de biometria.
- **Ação necessária:** rodar `pip install pytest && npm test` na máquina de desenvolvimento.
- **Prioridade:** baixa.
