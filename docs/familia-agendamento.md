# Agendamento da família (página nova `/agendamento/`)

Versão 1.0 — 13/11/2026 / Mudança: primeira versão. Escrita a partir das decisões do dono de 13/11/2026 (plano em `docs/plano-jornada-familia.md`). **Está pronta e testada com Klingo de mentira; NADA foi aplicado em produção ainda.** A página técnica anterior (todas as abas) foi para `/agendamento/completo/` (continua igual).

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

## O que precisa existir para ligar (passos do dono)

1. **Secrets** da função `klingo-agendamento` (https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/functions): `FAMILIA_CHAVE` (32 bytes aleatórios em base64; **guarde uma cópia fora do Supabase**: sem ela os dados cifrados não abrem) e `FAMILIA_SYNC_CHAVE` (texto longo, mínimo 20 caracteres). A chave pode ser gerada com `openssl rand -base64 32`; ela nunca vai para o repositório. Sem `FAMILIA_CHAVE`, toda ação `fam_*` responde "desligado" e o resto da função segue normal. Para abrir **resultado**, o secret antigo `AGENDAMENTO_RESULTADO=1`.
2. **Banco:** aplicar `supabase/familia-agendamento.sql` em **partes** (os blocos `PARTE 1` a `PARTE 7`, nesta ordem), medir, depois **refazer o retrato** (`supabase/producao/LEIAME.md`) e rodar `npm run test:retrato`.
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

`agendamento/index.html` (página) · `agendamento/completo/index.html` (a página técnica anterior) · `supabase/familia-agendamento.sql` (banco) · `supabase/functions/klingo-agendamento/{familia,ordenar,cripto}.ts` (função) · testes: `npm run test:familia-sql` (28), `npm run test:familia-funcao` (36), `npm run test:agendamento-familia` (20) e `npm run test:agendamento` (a página técnica, 20).
