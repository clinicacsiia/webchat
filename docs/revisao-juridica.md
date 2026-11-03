# Pacote para revisão jurídica (LGPD e consumidor)

Preparado em 03/11/2026 a partir do que o código faz hoje. Não é parecer jurídico. Cada afirmação abaixo foi tirada do código e dos documentos do repositório; o que **não** foi possível verificar está marcado **[NÃO VERIFICADO]**.

Textos para aprovar: `privacidade.html`, `termos.html`, a caixa de aceite do formulário, a do cadastro da conta, a autorização da foto e a tela "Meus dados" (todos em `index.html`).

## 1. Perguntas que precisam de resposta do jurídico
| # | Pergunta | Onde pesa |
|---|---|---|
| 1 | Base legal correta para nome, telefone, e-mail e conversa: consentimento (art. 7º, I), execução de contrato/procedimento preliminar (art. 7º, V) ou tutela da saúde (art. 11, II, f)? Hoje a política cita as três em linhas diferentes. | Política, item 2 |
| 2 | A autorização da foto do pedido (dado de saúde) é consentimento específico suficiente (art. 11, I)? Ela é uma caixa marcada antes de enviar. | Foto do pedido |
| 3 | O aceite do responsável legal vale para dados de criança (art. 14, §1º)? Hoje é uma caixa de seleção, sem verificar quem é o responsável. | Formulário |
| 4 | Prazo de retenção de conversas, fotos e dados de contato. Para prontuário a política cita 20 anos (Lei 13.787/2018). **Conversa de agendamento é prontuário?** | Política, item 5 |
| 5 | A exclusão apaga só o login e mantém cadastro, pedidos e conversas. Isso é aceitável como base no art. 16, I? Precisa listar quais dados exatos ficam? | "Meus dados" |
| 6 | Transferência internacional (art. 33): quais fornecedores guardam dados fora do Brasil e qual salvaguarda usar? | Política, item 4 |
| 7 | Precisa de **encarregado (DPO)** nomeado e de e-mail próprio? Quem é? | Política, item 1 |
| 8 | Precisa de **RIPD** (relatório de impacto) para foto do pedido, IA e biometria? | Itens de bloqueio |
| 9 | Precisa de **contrato de operador** com Supabase, n8n, provedor de IA, Klingo e Cloudflare? | Fornecedores |
| 10 | O aviso de IA no chat ("assistente virtual... um atendente confirma") atende à exigência de transparência em decisões automatizadas (art. 20)? | Chat |
| 11 | Falta algo para o CDC: política de cancelamento/remarcação, prazo de resposta ao consumidor? O site não cobra, mas informa valores. | Termos, item 3 |
| 12 | A clínica precisa informar o CNPJ e o registro da clínica no CRM/CNES? | Rodapé |

## 2. Inventário de dados (de onde vem, para onde vai)
| Dado | Onde é pedido | Onde fica | Quem acessa |
|---|---|---|---|
| Nome, telefone, e-mail | Formulário inicial | `contatos` (Supabase) e `localStorage` do aparelho | Equipe (papéis admin/atendente) |
| Aceite LGPD (data) | Formulário | `contatos.aceitou_lgpd_em` | Equipe |
| Conversa e mensagens | Chat | `conversas`, `mensagens` | Equipe; o paciente vê a própria conversa por token |
| CPF, nascimento, endereço, carteirinha | Widgets do chat (conforme o passo) | `pacientes`, `pre_agendamentos` | Equipe |
| Nome da criança e dos irmãos | Formulário "Para meu filho(a)" | `conversas` / pré-agendamento | Equipe |
| Foto do pedido médico | Chat (tirar ou escolher foto) | Banco/Storage da clínica | Equipe; leitura automática por IA só quando for ligada |
| Conta (e-mail, senha) | Login opcional | Supabase Auth, `contas_paciente` | O próprio titular e a equipe técnica |
| Assinatura dinâmica (traço) | Fila de chegada (módulo biometria) | `registro_assinaturas` (série completa do traço) | A definir (item 8 de `docs/fila-biometria.md`) |
| Dados de aparelho para aviso (endpoint e chaves de notificação) | Permissão de notificação ao iniciar o chat | `chat_push_inscricao` | Sistema (sem acesso direto do paciente nem da equipe) |
| Eventos técnicos da Sentinela | Automático | Tabela de erros da Sentinela | Equipe técnica; não guarda texto da conversa, CPF, telefone nem e-mail |
| IP do aparelho | Automático (CDN, ViaCEP, Cloudflare, push) | Nos fornecedores | Fornecedores |

## 3. Terceiros e fluxos
- **Supabase** (projeto `nrvuynjwcgwpjdptkiay`): banco, login, funções. Região **[NÃO VERIFICADO]**.
- **GitHub Pages**: hospedagem do site.
- **Klingo**: sistema de agenda e cadastro da clínica (leitura por relatórios).
- **n8n + provedor de IA (Anthropic, por padrão)**: triagem e organização do atendimento. Segundo `docs/fase8-leitura-do-pedido.md`, a foto do pedido seria enviada à API da Anthropic, que age como operadora e por padrão não treina com dados da API. A função `ler-pedido` **ainda não está publicada**.
- **jsDelivr** (bibliotecas), **ViaCEP** (recebe o CEP digitado), **Cloudflare Turnstile** (só se houver chave configurada) e **serviço de notificação do navegador** (Google, Apple ou Mozilla).

## 4. O que o chat faz hoje que o jurídico deve conhecer
- Não há cookies de rastreamento nem analytics. Há `localStorage` essencial (conversa, perfil, sessão, tamanho da letra).
- Pergunta a permissão de notificação ao iniciar a conversa.
- O assistente se identifica como IA e diz que uma pessoa confirma data, horário e valor.
- Há tela de emergência (lista de sinais de alerta no fluxo do chat; ver `docs/plano-fase7-fluxo-sem-ia.md`, item 1).
- "Meus dados" baixa cópia (TXT e JSON) e apaga o login.

## 5. Pendências já registradas nos documentos
- Consentimento, retenção e RIPD de biometria: `docs/fila-biometria.md`, seção 8; `docs/pendencias-e-dependencias.md`, D7.
- Revisão do texto de "Meus dados", aviso de privacidade e retenção da foto: A8 e B3 do mesmo arquivo.
- Regra do dado de paciente do relatório #13825 (só em memória): `docs/quadro-nas-conversas.md`, item 4.

## 6. Lacunas conhecidas
- CNPJ e e-mail do encarregado: aparecem como "a informar".
- Quem da equipe tem acesso aos dados e se há registro de acesso **[NÃO VERIFICADO]**.
- Plano de resposta a incidente e prazo de comunicação à ANPD: não há documento.
- Registro das operações de tratamento (ROPA): não existe. Este arquivo serve de ponto de partida.
- Backups e prazo de eliminação nos backups **[NÃO VERIFICADO]**.
- Os testes automáticos não cobrem a caixa de autorização da foto nem o texto para criança.

## 7. Frases dos textos que fazem promessas (conferir se são verdadeiras)
1. "Este site não usa cookies de publicidade, estatística ou rastreamento." (verdadeiro hoje)
2. "Nenhum dado é vendido nem usado para propaganda." (sem uso no código)
3. "Respondemos em até 15 dias." (compromisso operacional da clínica)
4. "O banco limita o acesso por regras e a equipe só vê o que precisa." (RLS ativo; o recorte por função na equipe **[NÃO VERIFICADO]**)
5. "Alguns serviços podem guardar dados fora do Brasil... a clínica o faz conforme o art. 33." (depende da resposta à pergunta 6)
6. "Em caso de incidente... avisaremos você e a ANPD." (não há plano formal)
