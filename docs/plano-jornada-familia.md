# Plano: a jornada da família, da marcação ao laudo (tudo na página, tudo automático)

Versão 1.1 — 13/11/2026 / Mudança: acrescenta o outro responsável e outros aparelhos (3 portas para o nível 2, seção 3.1). A 1.0 era a primeira versão, escrita a partir das decisões do dono de 13/11/2026. **É um plano: nada disto está no ar.** Página atual: `agendamento/index.html` (ver `docs/agendamento-pagina.md`).

## 1. Decisões do dono (13/11/2026)

1. **O resultado é 100% automático e fica dentro da página.** Sem link e sem senha: o laudo aparece sozinho. Isto **substitui** a decisão de 03/11/2026 ("link e senha do resultado são passados pela equipe") e o `AGENDAMENTO_RESULTADO` desligado.
2. **Nunca pedir de novo** o que o sistema já sabe (cadastro, plano, filhos). **A unidade não é escolha do paciente**: ela vem do médico ou do exame.
3. **Entrar sem digitar** CPF e nascimento, e o celular **fica lembrado para sempre**.
4. **Marcar do melhor jeito que a API permite**, para uma pessoa e para a família.
5. **Acompanhamento inteligente**, com a tela se atualizando **a cada 1 minuto**.

## 2. O que já existe (fatos conferidos no repositório)

| Fato | Onde está |
|---|---|
| A API devolve o **laudo como arquivo** (HTML e PDF em base64) com só a chave da clínica: `GET /resultado/{id_marcacao}`. Não existe link nem senha. | `docs/klingo-api-externa/GUIA-COMPLETO.md` 2.6 |
| **Nunca foi testado um laudo pronto de verdade.** Só se viu que marcação sem laudo responde 403 com página HTML. | idem |
| Uma chamada de horários (`/agenda/horarios`) já traz **todos os médicos e dias** da especialidade ou do exame, com a unidade de cada horário. | idem 2.1 |
| Unidades: CSI (1), DESENVOAR/PEDIATRIA (2) e "CSI - 2" (3, ressonância). A neurologia atende na PEDIATRIA; exames, na CSI. Ou seja, **a unidade segue o médico/exame**. | idem 3 |
| Os médicos têm **regras de idade e sexo** (`/profissional` → `regras`; `/profissionais` → `paciente_idade_maxima`). A busca de horários aceita `nascimento` e `sexo`. | idem 2.1 e 3 |
| Limite: perto de 14 chamadas seguidas gera 429. A função já pede ficha na cota global e espera pouco. | idem 3.1 |
| **O banco lê o Klingo todo minuto** (6h30 às 18h30, seg a sáb) e fecha o ciclo da jornada: Pedido, Agendado, Confirmado, Chegou, Em atendimento, Exame feito, Laudo. | `docs/jornada-monitoramento.md` |
| O "Minha vez" já mostra 6 passos por exame e atualiza a cada 15 s. | `docs/jornada-paciente.md` |
| O receptor do **webhook** do Klingo está pronto (`klingo-webhook`), mas o Klingo ainda **não cadastrou** a URL. | `GUIA-COMPLETO.md` 2.7 |
| Já existe **Web Push** para aparelhos da conta (`fila-avisar`, chaves VAPID) e e-mail pelo Resend (`fila-emitir-link`). | `supabase/functions/` |
| O plano antigo manda deixar o resultado com a equipe até haver **segundo fator** (código por SMS/e-mail), que a clínica não tem. | `docs/klingo-autoatendimento.md` e `pendencias-do-dono.md` 2.8 |
| Cadastro do filho: hoje digitado a cada vez; dependentes "ficam para a próxima etapa". Regra do projeto: **nunca pôr o CPF do responsável na criança**. | `docs/login-paciente-passo-a-passo.md`, `pendencias-do-dono.md` |

## 3. Entrar sem digitar e lembrar para sempre: o "celular de confiança"

**Ideia central.** Quem vai ver laudo precisa ter ido à clínica. Então **a ligação do celular é feita no balcão, no check-in, sem digitar nada.** Isso é o segundo fator que o plano antigo esperava, sem precisar de SMS.

### Dois níveis

| Nível | Como o celular chega aqui | O que pode |
|---|---|---|
| **1. Conhecido** | Digitou CPF + nascimento **uma vez** (como hoje). O servidor guarda um **código do aparelho** e passa a reconhecer o celular. | Marcar, remarcar, cancelar, ver as próprias marcações e o acompanhamento. **Não vê laudo.** |
| **2. De confiança** | Leu o **QR do balcão** no check-in (ou a recepção liberou o celular no painel). | Tudo do nível 1 **e os laudos** das pessoas ligadas àquela visita. |

### Como funciona o QR do balcão
1. No check-in, a recepção abre o cartão da visita no painel e toca em **"Ligar o celular do paciente"**. Aparece um **QR de uso único**, válido por 10 minutos e preso àquela visita.
2. O responsável lê com a câmera. A página abre e diz: "Pronto. Este celular agora acompanha a Ana e o João. Você nunca mais precisa digitar nada."
3. **Família:** a recepção marca na tela todos que vieram juntos (a Ana e o João). **Um QR liga os dois.**
4. Quem marcou pela página já foi nível 1; ao ler o QR, sobe para o nível 2 **sem repetir nada**.

### Regras do código do aparelho
- É um número aleatório de 256 bits. **No banco fica só o hash.** No celular fica em `localStorage`. Nunca guarda CPF nem nascimento no aparelho (a regra de `docs/agendamento-pagina.md` continua valendo).
- **"Para sempre" = enquanto o celular for usado.** Ele passa a "dormir" se ficar **12 meses sem abrir** (volta pelo QR). Isso protege celular antigo ou vendido.
- **Desligar:** botão "Desligar este celular" na página; "Aparelhos conectados" lista e revoga; a recepção pode **desligar todos os celulares de uma família** (perdeu ou trocou de celular).
- Para chamar o Klingo, a função precisa fazer o login do paciente (CPF + nascimento). Por isso esses dois dados ficam **cifrados no banco** (a chave só no secret da função), nunca no celular, nunca em log. **Decisão do dono e revisão jurídica**: é o primeiro dado de saúde guardado por esta página.
- Fica pendente a pergunta ao Klingo de como identificar **criança sem CPF** (seção 8).

### 3.1 Outro responsável e outro aparelho (acrescentado em 13/11/2026)

**Regra do dono:** o outro responsável (pai, mãe, avó, quem cuida) que **sabe todos os dados** também pode ver o resultado, **no celular dele**. Quem trocou ou perdeu o celular também. Por isso há **três portas** para um aparelho chegar ao nível 2. Todas valem para **um paciente de cada vez** e nenhuma depende de o primeiro celular estar à mão.

| Porta | Quem usa | O que a pessoa faz | Espera |
|---|---|---|---|
| **1. QR do balcão** | Quem está na clínica | Lê o QR no check-in | Nenhuma |
| **2. Convite de quem já está ligado** | Pai e mãe, avó, o próprio paciente com celular novo | No celular já ligado: toca "Dar acesso a outra pessoa", aparece um **QR e um código de 6 números (15 min, uso único)**. A outra pessoa lê o QR ou digita **só os 6 números**. | Nenhuma |
| **3. "Eu sei todos os dados"** | O outro responsável, **sem ninguém por perto** | Informa **CPF do paciente, nascimento, nome da mãe e celular do cadastro** (os quatro precisam bater com o Klingo; conferido pela função, nada mostrado) | Veja abaixo |

**Como a porta 3 se protege** (porque saber os dados é uma prova mais fraca que estar na clínica):
- **Aviso aos celulares já ligados.** Chega Web Push e aviso na página: "Alguém quer acompanhar a Ana. Foi você que autorizou? [Sim, liberar agora] [Não, bloquear]".
- **Espera de 24 horas** se já existe celular ligado e ninguém respondeu. **Quem aprova no aviso libera na hora.** Se **não existe** nenhum celular ligado, ou se o paciente tem menos de 18 anos e quem pede é o responsável, a espera cai para **0** (não há quem avisar). Enquanto espera, a pessoa já marca, remarca e vê o acompanhamento, só não abre o laudo.
- **3 tentativas erradas** travam **aquele paciente na porta 3 por 1 hora**. **Os celulares já ligados não são afetados**, ao contrário de hoje, em que erro de nascimento tranca o CPF até para o dono.
- **Tudo registrado** sem conteúdo (R5): quando, qual aparelho, qual porta.
- A recepção vê no painel quem entrou pela porta 3 e pode **desligar** qualquer aparelho.

**Pai e mãe são iguais.** Cada pessoa **desliga só o seu próprio celular**. **Quem tira outra pessoa é só a recepção** (evita briga entre pais separados e dá um ponto de decisão humana). Na lista "Aparelhos conectados" cada celular aparece com o apelido que a pessoa escolheu ("Celular do Pedro") e a data da última vez que abriu.

**Paciente adulto.** Por escolha do dono, quem sabe todos os dados também vê o laudo de um adulto. **Risco assumido:** um parente ou ex-parceiro que conheça CPF, nascimento, mãe e celular vê o laudo depois da espera de 24 h, a menos que o próprio paciente bloqueie no aviso. Há um interruptor (`config`, valor sugerido `acesso_por_dados_adultos`, padrão `sim`) para exigir QR ou convite só para adultos, se um dia for preciso.

## 4. Marcar: o melhor jeito com a API

**Regra: o paciente diz o que precisa; o sistema resolve o resto.**

1. **Uma chamada para tudo.** `GET /agenda/horarios` traz todos os médicos, dias e unidades. A página **não pergunta médico nem unidade**: mostra os **3 primeiros horários livres** e o **local de cada um** ("Onde: DESENVOAR, Rua…, com a Dra. X").
2. **Janela de 10 dias primeiro**; só amplia (até 31) se vier vazio. Menos chamadas e mais rápido.
3. **Idade resolve o médico.** Manda-se `nascimento` e `sexo` do paciente à busca, e a lista já vem só com quem atende aquela idade (consulta de pediatria ou neuropediatria sem o pai escolher). **Confirmar com as médicas antes de ligar.**
4. **Plano vem do cadastro.** `/paciente` já devolve convênio e plano. A tela pergunta só "Continua com a Unimed?" (um toque). Quem não tem plano usa PARTICULAR (plano 1).
5. **Segurar o horário em silêncio.** A reserva de 10 min (`/agenda/reservar`) continua, **sem relógio na tela**. Se vencer, a página reserva de novo sozinha ao confirmar.
6. **Resposta perdida.** Mantém-se `id_externo` (`pagina-…`) em cada marcação e a conferência pelas marcações ativas, sem repetir.
7. **Pedido médico:** a foto do pedido vira a lista de exames (função `ler-pedido` do chat). Havendo mais de um exame, procura-se **o mesmo dia e a mesma unidade, em horários seguidos**.
8. **Sem horário:** o paciente toca "Avise-me". O banco confere a mesma busca de vez em quando (1 chamada por necessidade, **agrupando pessoas iguais**) e avisa por Web Push quando abrir.

### Família: marcar de uma vez (tudo ou nada)
1. "Quem vai?" mostra os cartões de pessoas da família com caixinhas. A Carla marca a Ana e o João.
2. Faz-se **uma busca de horários** (a mesma resposta serve aos dois) e o sistema monta combinações: **mesmo médico em horários seguidos**, ou **dois médicos no mesmo turno e na mesma unidade**. Mostra as 3 melhores. Se não houver, diz com franqueza e oferece dias diferentes.
3. **Reservar cada um** com a sessão de cada paciente. Se qualquer reserva falhar, **solta as outras** e oferece a próxima combinação (nunca deixa um filho marcado e o outro não).
4. **Confirmar** cada marcação com `id_externo = pagina-<grupo>-<n>`. Uma confirmação só para a família e **uma mensagem** com os dois.
5. Custo de chamadas para 2 pessoas: cerca de 7 (1 busca, 2 logins, 2 reservas, 2 marcações), com pausa de 0,8 s: ~6 s, com texto "Marcando a Ana… Marcando o João…".

## 5. Acompanhamento inteligente, a cada 1 minuto

- A página consulta **o nosso banco**, não o Klingo, **a cada 60 s enquanto a aba está aberta**, e **para quando a aba fica escondida**. Mostra "atualizado agora há pouco".
- O banco já se atualiza do Klingo **todo minuto no expediente** (fora dele, 15 min, 30 min ou 2 h). Quando o Klingo cadastrar o webhook, a mudança chega **na hora**.
- **Linha do tempo por pessoa:** Marcado → Confirmado → Cheguei → Em atendimento → Exame feito → Laudo sendo feito → **Laudo pronto**. Cada passo tem uma frase calma ("Tudo certo! Falta só você chegar").
- **Previsão que aprende.** O prazo mostrado ("costuma ficar pronto em cerca de 2 dias úteis") vem da **mediana do que já aconteceu** nesse tipo de exame (do histórico de "Exame feito" até "Laudo"), não de um número inventado. Nas primeiras semanas usa o histórico da equipe; depois, o dos laudos detectados automaticamente.
- **Inteligente no ritmo:** exame hoje ou laudo esperado, 60 s; sem nada pendente, a página nem consulta.
- **Aviso fora da página:** Web Push ("O resultado da Ana está pronto", **sem conteúdo nenhum**), reaproveitando `fila-avisar`. WhatsApp ou SMS só quando a clínica tiver canal e consentimento.

## 6. Resultado automático: as regras (R1 a R10)

**Como o laudo chega à página.** Quando o banco vê uma marcação como "atendido", uma rotina pergunta ao Klingo (`GET /resultado/{id}`), com pausa de 0,8 s entre chamadas e freio na cota global. Tenta de 5 em 5 min na primeira hora, de 30 em 30 até 1 dia, de 2 em 2 h depois, **até `pronto = true`**. Quando fica pronto, só marca **"Laudo pronto"** e dispara o Web Push. **O laudo em si não é guardado**: é buscado ao vivo quando o paciente abre.

| # | Regra |
|---|---|
| R1 | **Só celular de confiança (nível 2)** vê laudo, por qualquer das **3 portas** da seção 3.1. Celular nível 1 vê "Seu laudo está pronto. Para abrir, leia o QR na recepção, peça um convite a quem já acompanha ou entre com todos os dados", **nunca** o arquivo. |
| R2 | **Só as pessoas daquele vínculo.** O laudo de um filho só aparece nos celulares ligados a esse filho. Pai, mãe e outros responsáveis ligam cada um o seu (portas 1, 2 ou 3). |
| R3 | **Só com `pronto = true`**, nunca laudo parcial. Se for refeito, aparece "Atualizado em dd/mm" (como o laudo é lido ao vivo, vale sempre o último). |
| R4 | **Sem guardar o arquivo.** A função lê, entrega e esquece. **Nada do conteúdo vai para log**, e o erro 403 com página HTML é tratado como "ainda não está pronto". |
| R5 | **Todo acesso é registrado sem conteúdo**: data, hora, aparelho e exame. Serve para auditoria e para o paciente ver "quem abriu". |
| R6 | **Freios:** no máximo 5 aberturas por minuto por celular; se o mesmo celular tentar laudos de pessoas fora do vínculo, suspende e avisa a recepção. |
| R7 | **Aparelho desligado, laudo some do celular.** O PDF baixado pelo paciente é dele, o sistema não controla. |
| R8 | **Resultado a ser entregue em conversa.** A equipe pode marcar um exame como "entregar pessoalmente" (por exame, no painel). A página mostra "Nossa equipe quer conversar com você antes. Toque para falar com a gente". **Por padrão tudo abre sozinho**; esta chave existe para o caso raro e é decisão do responsável médico. |
| R9 | **Tudo numa tela só:** o PDF abre na própria página; ainda há "Baixar", "Enviar para o meu médico" (compartilhar do celular) e, depois que abrir, "Marcar retorno". O histórico fica na lista "Resultados da família" (mais novos primeiro). |
| R10 | **Exame de imagem sem número de acesso.** Hoje a página pede um "número de acesso". Isso some: o laudo aparece no cartão do exame. **O laudo de imagem só entra depois do primeiro teste real** (seção 8). |

## 7. Palavras e telas (resumo; detalhes na conversa de 13/11/2026)
- Tela inicial: "Marcar consulta", "Marcar exame", "Minhas marcações e resultados" e **"Falar com uma pessoa"** fixo.
- Linguagem calma; "plano de saúde", "onde", "número do agendamento"; nada de "Klingo", "não testado", "voucher".
- Aba **Equipe**, **Consultar a clínica** e **Sobre a API** saem do paciente.
- Qualquer erro termina com "Falar com a recepção".

## 8. O que ainda não foi provado e as perguntas

**Antes de ligar o resultado automático, é obrigatório um teste real**, com um paciente que autorize: ver `GET /resultado/{id}` de um exame **de fato pronto** (formato, tamanho, tempo de resposta, se o PDF vem em base64 e se há acento no HTML), em **consulta, laboratório e imagem**. O `GUIA-COMPLETO.md` diz que isso **nunca foi feito**.

Perguntas ao suporte do Klingo (juntar às de `roteiro-reuniao-suporte.md`):
1. Como identificar **criança sem CPF** (login e `/paciente`)? Aceita id + nascimento?
2. O `id_marcacao` das marcações **atendidas** aparece no relatório que o banco já lê (#13825/#14359) ou só em `/vouchers`? O banco precisa dele sem entrar como paciente.
3. O número de acesso de imagem (`accession`) aparece em algum lugar da API, para a página não pedir ao paciente?
4. Cadastrar a URL do **webhook** (`.../functions/v1/klingo-webhook`) e mandar os eventos `FIM-ATENDIMENTO` e `STATUS-MARCACAO`.
5. Existe aviso de "laudo liberado" (evento) ou só se descobre perguntando?
6. Limite exato de chamadas por minuto.

## 9. Fases (cada uma com teste com 5 pessoas reais antes de ligar)

| Fase | O quê | Mexe no banco? |
|---|---|---|
| **A** | Palavras, telas calmas, fim do "não testado", botão "Falar com uma pessoa", nascimento em 3 caixas, esconder abas técnicas, tela final com calendário e WhatsApp, 3 primeiros horários sem perguntar médico/unidade, plano do cadastro | Não (só página e função) |
| **B** | **Minha família:** pessoas ligadas ao celular, "Quem vai?", criança sem CPF | Sim |
| **C** | **Celular de confiança** (nível 1), **QR do balcão**, **convite** e **"Eu sei todos os dados"** com aviso e espera (nível 2), e "Aparelhos conectados" | Sim |
| **D** | **Marcar a família** de uma vez (tudo ou nada) e "Avise-me" | Sim |
| **E** | **Acompanhamento de 1 min** com previsão aprendida e Web Push | Sim |
| **F** | **Laudo automático** (R1 a R10), depois do teste real da seção 8 | Sim |

Cada mudança de banco segue o procedimento do `CLAUDE.md`: arquivo novo em `supabase/` (com fluxograma, versão e volta), teste no clone, aplicar em partes, medir, refazer o retrato (`supabase/producao/`), `npm run test:retrato`. Cada mudança de tela troca `VERSAO_APP` e as `VERSAO` dos `sw.js`.

## 10. Riscos que o dono aceita ao escolher este caminho
- **Dado de saúde guardado:** CPF e nascimento cifrados no banco (necessário para entrar no Klingo por quem já está ligado). Precisa de revisão jurídica e atualização de `privacidade.html`.
- **Celular perdido ou emprestado:** quem tem o celular ligado vê os laudos até alguém desligá-lo. Mitigação: botão de desligar, 12 meses sem uso e desligamento pela recepção. Opção futura: pedir a **digital ou senha do próprio celular** antes de abrir um laudo (nível de proteção do aparelho, sem digitar nada no site).
- **Pai e mãe separados:** cada um liga o seu celular por uma das 3 portas. Ninguém tira o outro; só a recepção.
- **Porta 3 (todos os dados):** é a mais fraca. Foi aceita pelo dono em 13/11/2026 com aviso aos celulares ligados e espera de 24 h. Para os campos nome da mãe e celular, **conferir os nomes reais no retorno do `/paciente`** (nada foi testado).
- **Laudo sensível visto sem aviso humano:** a chave R8 existe para isso, mas é opcional.
