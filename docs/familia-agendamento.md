# Agendamento da família (página nova `/agendamento/`)

Versão 1.1 — 14/11/2026 / Mudança: horário conferido ao vivo e livro-caixa (ninguém marca o mesmo horário), fila de espera por pressa, proteção contra abuso e chave de segurança para o primeiro uso com dados reais (seções novas abaixo). A 1.0 era a primeira versão. Escrita a partir das decisões do dono de 13/11/2026 (plano em `docs/plano-jornada-familia.md`). **Está pronta e testada com Klingo de mentira; NADA foi aplicado em produção ainda.** A página técnica anterior (todas as abas) foi para `/agendamento/completo/` (continua igual).

## O que o paciente vê (e por que é assim)

| Tela | Para quê |
|---|---|
| **Entrar (uma vez só)** | CPF + nascimento em três caixas (dia, mês, ano). Depois disso o celular lembra para sempre (código aleatório; **CPF e nascimento nunca ficam no celular**). |
| **Oi, Maria!** | Quem este celular acompanha (a pessoa e os filhos), avisos de acesso e três botões: marcar consulta, marcar exame, acompanhar. |
| **Quem vai ser atendido?** | Marca uma ou mais pessoas (até 4 por vez). Com 2 ou mais, a página só mostra **combinações para ir juntos**. |
| **Qual consulta / exame?** | Botões grandes; exame com busca e atalhos (Ultrassom, Mamografia…). O plano vem do cadastro, **não se pergunta**. A **unidade nunca é pergunta**: vem do médico ou do exame. |
| **Horários** | "O primeiro horário livre" em destaque; depois **todos os médicos, ordenados**: quem a família já consultou ("Você já foi"), depois os mais marcados pelos outros ("Mais procurado"). |
| **Confirmar → Pronto** | Frase simples, botão verde, depois calendário do celular (.ics com lembrete de 2 h), WhatsApp para a família e lista do que levar. |
| **Acompanhar** | "Rastreio" como o de uma entrega: Marcado → Confirmado → Você chegou → Atendimento feito → Resultado pronto, com a hora de cada passo, frase calma e previsão que aprende. **Atualiza sozinho a cada minuto** (só com a aba aberta). Cheguei, Mudar o horário, Não vou poder ir. |
| **Resultado** | Dentro da página, em moldura isolada. **Só em celular de nível 2.** |
| **Dar acesso a outra pessoa** | Código de 8 números (15 min, uso único) para pai, mãe, avó. Quem usa **não digita CPF nem nascimento**. |
| **Aparência (Aa)** | Letra Normal/Grande/Bem grande e cores Do celular/Claro/Escuro/Alto contraste, lembrados. |

## Regras de quem vê o quê

- **Nível 1** (entrou por CPF + nascimento): marca, remarca, cancela e acompanha. **Não abre laudo.**
- **Nível 2** (abre laudo): por **código de convite** de quem já abre, ou por **"Eu sei todos os dados"** (CPF, nascimento, nome completo e celular do cadastro, conferidos no Klingo). Se já há outro celular com acesso ao laudo, ele recebe um aviso e a liberação espera **24 h** (ou até alguém tocar em "Sim, liberar"); sem outro celular, abre na hora. 3 erros em 1 h travam só esta porta (os celulares já ligados continuam funcionando).
- **No máximo 3 celulares por pessoa** ("máximo entre aspas": a recepção muda em `config.familia_max_aparelhos`).
- **Cada celular desliga só a si mesmo.** Tirar outro celular é da recepção (ainda não há tela para isto).
- **Celular parado há 12 meses "dorme"** (`config.familia_dorme_meses`) e pede para entrar de novo.
- **Criança sem CPF usa o CPF do responsável** + o nascimento dela (decisão do dono, 13/11/2026). Isto **substitui** a regra antiga "nunca cadastrar o CPF do responsável na criança" de `pendencias-do-dono.md`. O cadastro da criança no Klingo é um pré-cadastro com o CPF do responsável; o id dele fica guardado e o login é sempre por id.
- **Cancelar** segue a regra de 24 h do chat: perto da hora a página manda falar com a recepção, com carinho.
- **Laudo nunca é guardado nem vai para log.** Cada abertura é registrada (quando, qual celular, qual marcação; sem conteúdo) e há freio de 5 aberturas por minuto por celular.

## Como a agenda é carregada (o "motor")

1. A busca lê o **cache** (`agenda_cache`): se tem e está fresco (90 s), usa; se está vencido há menos de 10 min, **mostra e manda atualizar** (a página diz "podem ter mudado"); se não tem, pergunta ao Klingo na hora.
2. A **fila lenta** (`agenda_fila`) faz as leituras sem pressa: **no máximo 3 por minuto**; se o Klingo responder 429, **larga o resto e tenta de novo** (nunca martela). Quem está na tela passa na frente (prioridade 1 e 2).
3. O rastreio vem do nosso banco. A rotina lê `/vouchers` de quem usou o celular na última hora e atualiza o status; marcação futura que **sumiu** da lista de ativas vira "cancelada".
4. **Ordem dos médicos:** histórico da família (`familia_marcacao`) → procura geral dos últimos 90 dias (`agenda_ocupacao`, que já vem dos relatórios #7 e #47, **sem dado de paciente**: não precisa de relatório novo) → primeiro horário livre.
5. **Previsão do laudo que aprende:** mediana de dias entre "Atendimento feito" e "Resultado pronto" por procedimento, só com 5 ou mais casos.

## Marcar mais de uma pessoa (tudo ou nada)

1. Abre a sessão de cada pessoa no Klingo. 2. **Reserva todos os horários.** Se um estiver tomado, solta os outros e mostra a pessoa que perdeu o horário. 3. Marca todos (`id_externo = pagina-<grupo>-<n>`). Se um falhar, **cancela os que já foram marcados**; se não conseguir desfazer, avisa com franqueza ("Marcamos só uma parte… fale com a recepção"). 4. Grava o rastreio e pede a leitura lenta.

## Garantia de que o horário é válido (14/11/2026, para usar com dados reais)

Nada é marcado por uma lista velha. A ordem dos passos de `fam_marcar` é de propósito:

1. **Chave de segurança** `config.familia_marcar_modo`: `desligado` (para tudo), `teste` (**o padrão**: só marcam os CPFs de `config.familia_teste_cpfs`, com ou sem pontos, separados por vírgula; filhos usam o CPF do responsável) ou `ligado`.
2. **Limites contra abuso** (seção abaixo).
3. **O horário é conferido ao vivo no Klingo** (sem cache). Se não estiver mais livre, a pessoa é avisada na hora e **já recebe 3 alternativas livres** (o mesmo médico no mesmo dia primeiro). Horário que começa em menos de 30 minutos também sai.
4. **A pessoa não pode ter outro atendimento ativo no mesmo horário** (menos de 30 min de diferença) **nem o mesmo atendimento duas vezes** (mesmo número de procedimento; para trocar de dia, "Mudar o horário").
5. **Livro-caixa** (`agenda_segura`, no banco): dois pedidos pelo mesmo horário **no mesmo milissegundo** (pela página ou pelo chat): só um ganha, o outro recebe "ocupado" + alternativas, **sem incomodar o Klingo**. Vale também para o mesmo médico, dia e hora com chave diferente. Todo registro dura poucos minutos (nunca fica preso) e cancelar ou remarcar solta o horário na hora.
6. **O Klingo reserva e marca** (ele continua sendo o juiz final); se algo falhar no meio, solta e desfaz tudo.
7. **Conferência depois de marcar**: se o Klingo gravou outro dia ou hora, a marcação é **desfeita na hora**, a pessoa é avisada e a equipe recebe um alerta.

**O chat e a página enxergam um ao outro.** `agenda_reservas_provisorias` (a função do chat que esconde horários que outra conversa está escolhendo) passou a juntar também os horários do livro-caixa; o corpo original ficou em `agenda_reservas_chat`, sem mudar nada. E a busca da página esconde o que o chat está segurando. A volta atrás está no fim de `supabase/familia-agendamento.sql`.

**O que isto NÃO cobre:** a marcação **automática** do chat (`klingo-executar`) não passa pelo livro-caixa; só as reservas provisórias dela são enxergadas. Se as duas tentarem o mesmo horário no mesmo instante, quem decide é o Klingo, e a página trata a recusa com alternativas.

## Fila de espera por pressa

- A pessoa escolhe **hoje**, **esta semana** ou **mais cedo, em qualquer dia**; quem **já tem** horário pode pedir para **adiantar** (o horário de agora continua dela até aceitar outro).
- Quando um horário abre (cancelou, remarcou, a agenda mudou), a rotina oferece **o mais cedo possível** ao primeiro da fila e o **segura por 15 minutos** (`config.familia_oferta_minutos`). Se a pessoa recusar ou o tempo acabar, passa ao próximo; **o mesmo horário não é oferecido de novo à mesma pessoa**.
- **Ordem justa:** hoje > esta semana > qualquer dia; quem ainda não tem horário antes de quem só quer adiantar; depois quem espera há mais tempo. Para adiantar, só vale horário **2 horas ou mais antes** do que a pessoa já tem.
- Cancelar ou remarcar pela página chama a fila **na hora**; fora isso a rotina olha a cada minuto (no máximo 3 leituras do Klingo por vez).
- **Previsão para a gestão:** `select public.agenda_previsao_espera(7);` devolve, só em números, quanta gente espera por necessidade e urgência, e quantas ofertas foram aceitas, recusadas ou venceram.
- **Limite honesto:** sem e-mail nem aviso no celular, a oferta só aparece **na página** (início e acompanhar, que se atualizam a cada minuto). Por isso a oferta dura 15 minutos. O aviso por e-mail é o próximo passo.

## Cuidado com abuso (sem acusar ninguém)

A página nunca diz que desconfia. Ela **limita com gentileza** ("a recepção confere junto com você") e **a equipe vê um alerta**:

| Hábito | Limite (em `config`) | Alerta |
|---|---|---|
| Muitas pessoas num celular, ou 3 acrescentadas em 24 h | `familia_max_dependentes` = 4 | `muitos_dependentes` |
| Muitas marcações por vir na família | `familia_max_marcacoes_familia` = 8 | `muitas_marcacoes` |
| Muitas marcações por vir para uma pessoa | `familia_max_por_pessoa` = 3 | `muitas_marcacoes_pessoa` |
| Dois atendimentos iguais ou no mesmo horário | sempre recusa | — |
| Klingo gravou hora diferente da pedida | desfaz | `divergencia_marcacao` |

Ver os alertas (ainda não há tela no painel): `select public.familia_alertas_abertos();` e fechar: `select public.familia_alerta_resolver(<id>, 'recepcao');`. Os números do hábito de um celular (cancelamentos em cima da hora, faltas) saem de `public.familia_risco(<aparelho>)`.

## Primeiro uso com dados reais (passo a passo seguro)

1. Aplicar o SQL e criar os secrets (seção acima). O modo já nasce em **`teste`** e a lista de CPFs está vazia: **ninguém marca** até você liberar.
2. Em `config`, preencher `familia_teste_cpfs` com **o CPF de um paciente que autorizou** (e o call center avisado). Esse CPF fica em texto na tabela `config` (que só o administrador lê): apague depois do teste.
3. Entrar na página com esse paciente, **marcar, ver o rastreio e cancelar logo em seguida**. Conferir no Klingo que a marcação e o cancelamento apareceram.
4. Testar **dois pedidos ao mesmo tempo** pelo mesmo horário (dois celulares, toque junto): só um pode marcar.
5. Só depois trocar `familia_marcar_modo` para `ligado`. Para pausar tudo na hora: `update public.config set valor = 'desligado' where chave = 'familia_marcar_modo';`

## O que precisa existir para ligar (passos do dono)

1. **Secrets** da função `klingo-agendamento` (https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions): `FAMILIA_CHAVE` (32 bytes aleatórios em base64; **guarde uma cópia fora do Supabase**: sem ela os dados cifrados não abrem) e `FAMILIA_SYNC_CHAVE` (texto longo, mínimo 20 caracteres). A chave pode ser gerada com `openssl rand -base64 32`; ela nunca vai para o repositório. Sem `FAMILIA_CHAVE`, toda ação `fam_*` responde "desligado" e o resto da função segue normal. Para abrir **resultado**, o secret antigo `AGENDAMENTO_RESULTADO=1`.
2. **Banco:** aplicar `supabase/familia-agendamento.sql` em **partes** (os blocos `PARTE 1` a `PARTE 11`, nesta ordem), medir, depois **refazer o retrato** (`supabase/producao/LEIAME.md`) e rodar `npm run test:retrato`.
3. **Rotina de 1 minuto** (depois de aplicar o banco e criar os secrets): `pg_cron` chamando a função com `{"acao":"fam_sincronizar","segredo":"<FAMILIA_SYNC_CHAVE>"}`. O segredo vai no Vault, como as outras rotinas; **não** em arquivo.
4. **Publicar a função** `klingo-agendamento` (versão 1.2) e a página (junta na `main`).
5. **Primeiro teste real** (com paciente que autorize): entrar, marcar, ver o rastreio, cancelar, e um **laudo pronto de verdade** (nunca foi testado).

## O que NÃO foi provado com o Klingo de verdade

- Cadastrar o pré-cadastro da criança com o CPF de um paciente que **já existe** (o Klingo aceitou duplicar CPF nos testes de 12/11, mas não com este caso).
- O login por id guardado (`/externo/login` com o id) para quem já tem cadastro definitivo.
- Os campos `contatos.celular` e `nome` do `/paciente` usados na porta "Eu sei todos os dados". **Nome da mãe não é conferido** porque o campo não foi visto na resposta.
- Check-in no dia, laudo pronto, `remarcacao` na marcação nova e a remarcação com a antiga saindo sozinha.
- Que `/vouchers` mostre `atendido`; se não mostrar, o rastreio não chega a "Atendimento feito" sozinho (o monitor da Jornada continuaria sendo a fonte).

## Ainda não existe (ficou para depois)

- **QR do balcão** (recepção liga o celular na hora do check-in) e tela da recepção para desligar celulares.
- E-mail (confirmação e aviso de resultado) e Web Push; hoje o aviso só aparece **na página**.
- Filtro de médico por **idade/sexo** do paciente (a API devolve as regras; falta usar).
- Marcar **exames diferentes** para pessoas diferentes numa mesma vez; "Avise-me" quando abrir horário.
- Cadastro de paciente novo **adulto** dentro da nova página (hoje leva à página completa).
- Telefone da clínica no botão "Falar com uma pessoa" (hoje abre o chat).

## Arquivos

`agendamento/index.html` (página) · `agendamento/completo/index.html` (a página técnica anterior) · `supabase/familia-agendamento.sql` (banco) · `supabase/functions/klingo-agendamento/{familia,ordenar,cripto}.ts` (função) · testes: `npm run test:familia-sql` (42), `npm run test:familia-funcao` (47), `npm run test:agendamento-familia` (24) e `npm run test:agendamento` (a página técnica, 20).
