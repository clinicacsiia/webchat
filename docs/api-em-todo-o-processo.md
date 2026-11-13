# A API do Klingo em todo o processo do chat (13/11/2026)

**Pedido do dono:** a API consulta em todo o processo, para carregar dados fiéis de todos os questionários e só mostrar o que ela disponibiliza.

## De onde vem cada pergunta hoje

| Passo | Fonte hoje | É a API? |
|---|---|---|
| Tipo de consulta | `klingo_especialidade`, preenchida **toda madrugada** pela API (`/agenda/especialidades` + `/agenda/consultas`); filtro `klingo_so_liberados = sim` (**ligado em 13/11/2026**) | **Sim** (cópia de até 24 h) |
| Exame | Catálogo local; some só se a API já foi consultada e **não tinha horário** nos últimos 7 dias (`klingo_proc_api`) | Parcial (aprende com o uso) |
| Médico | Grade local (`catalogo_agenda`) | **Não** |
| CPF e nascimento | `/paciente/cpf` (cadastro do Klingo) | **Sim**, ao vivo |
| Plano / convênio | Catálogo de planos, **com o que o Klingo não atende marcado como inativo** (`/convenios`, toda madrugada) | **Sim** (cópia de até 24 h) |
| Horário | `/agenda/horarios` ao vivo, só os que a API oferece | **Sim**, ao vivo |
| Marcar, cancelar, remarcar | API (`klingo-executar`) | **Sim** (chaves em `teste` valem para todos com o geral em `sim`) |

## O que a API oferece neste cadastro (medido em 13/11/2026)
Só **3 especialidades**: Pediatria (5 consultas), Neurologia (2) e Radiologia (1). Resultado do filtro ligado:
- **Desenvoar:** mostra 5 de 9 (Pediatria, Neuro Desenvolvimento, Neuropediatria, Pré-Natal, Teleconsulta). **Somem** Endocrinopediatria, Gastropediatria, Ortopediatra e Puericultura.
- **CSI:** mostra 1 de 9 (Radiologia). Somem Cardiologia, Cardiopediatria, Cirurgia Pediátrica, Clínica Médica, Ginecologia, Nutrição, Urologia e Ortopediatra.

Quem quer o que sumiu usa **"Falar com um atendente"**. Para a consulta voltar a aparecer, o Klingo precisa expor a especialidade na API; depois a sincronização da madrugada a inclui sozinha.

## Como desligar
`update public.config set valor = 'nao' where chave = 'klingo_so_liberados';` (volta a lista completa na hora).

## Lacunas para "API em todo o processo" (próximos passos)
1. **Médico:** hoje vem da grade. A API tem `GET /profissionais?especialidade=` e as ofertas de `/agenda/horarios` trazem o profissional. Falta testar com o token (a tela do chat não consegue, só a função `klingo-teste-api`, que exige login da equipe) e ligar na lista de médicos.
2. **Sincronização mais frequente:** convênios e especialidades são copiados só de madrugada; dá para repetir de 6 em 6 horas (cada rodada gasta ~30 chamadas da cota).
3. **Exames:** a API tem `GET /agenda/exames`; hoje o catálogo local manda e só some o que a API já mostrou vazio.
4. **Convênio por especialidade:** `GET /agenda/especialidades?id_plano=` diz quais especialidades atendem aquele plano; hoje o plano é perguntado depois da consulta.
5. **Se a API cair:** o chat não trava; mostra a última cópia e o aviso de "previsão". Isso vale para os passos acima.


---

## Atualização de 13/11/2026 (noite): catálogo da API preparado e correção da ordem

### Correção
A revisão `revisao-chat-ordem-e-agenda-2026-11-13.md` descreveu a ordem das perguntas a partir do retrato antigo do banco. **Na produção o CPF e a data de nascimento são a PRIMEIRA coisa da conversa** (função `fluxo_proximo`, regra "cpf-primeiro"): `CPF + nascimento → (conferência na API) → atalho "repetir pedido" → motivo → consulta/exame → médico → plano → horário → dados → confirmar`. A conclusão da revisão (CPF antes do plano e do horário) continua certa; a posição exata é que estava errada.

### O que a API entrega e já está guardado (só catálogo; nenhum dado de paciente)
| Dado | Fonte | Guardado em | Tamanho em 13/11/2026 |
|---|---|---|---|
| Profissionais, com especialidades (CBOS) e **idade máxima do paciente** | `GET /profissionais` | `klingo_profissional` | 69 (10 com limite de idade: 16, 17, 65, 84 ou 97 anos) |
| Unidades | `GET /unidades` | `klingo_unidade_api` | **1** (CSI). Desenvoar e RM/TC **não são unidades na API**, são catálogos do chat |
| Exames | `GET /agenda/exames` | `klingo_exame_api` | 760; 537 dos 584 exames do chat existem na API (274 dos 278 com demanda) |
| Convênios e especialidades | `GET /convenios`, `GET /agenda/especialidades` | `klingo_convenio`, `klingo_especialidade` (já existiam) | 3 especialidades |
| Recepções, regiões | `GET /recepcoes`, `GET /regiao_cd` | — | **403** (o token do chat não tem permissão) |

Atualização toda madrugada às 06:55 (rotina `klingo-catalogo-api`). A função nunca guarda CPF nem foto dos médicos.

### Médicos: já comparado, ainda não ligado
100% dos médicos da grade da Desenvoar existem na API (9 de 9 em Pediatria, 1 de 1 em Neuropediatria etc.). Filtrar a lista de médicos pela API **não muda nada hoje**; só passa a valer quando a grade e a API divergirem. Está pronto para ligar com segurança (se a cópia da API faltar ou estiver velha, mostra a lista de sempre).

### O que dá para extrair no passo do CPF (decisão do dono)
Hoje `GET /paciente/cpf` só devolve ao banco: **novo ou já cadastrado**, o id do Klingo, quais contatos faltam e o plano cadastrado (por id). O código foi feito para **não guardar nem devolver dado pessoal** (nome, mãe, telefones, e-mail).

| Dado possível | Uso | Cuidado |
|---|---|---|
| Idade (do nascimento digitado) | Esconder médicos com limite de idade menor que a do paciente (10 médicos têm limite) | Nenhum |
| Já cadastrado × novo | Pular perguntas de cadastro, ir direto ao pedido | Já existe |
| Plano cadastrado (id) | Perguntar "o convênio é o mesmo do cadastro?" | Mostrar o nome do plano é dado privado; só depois de confirmar quem é |
| Sexo | Pedir menos coisas | Precisa vir do paciente ou do cadastro |
| Nome, mãe, telefone, e-mail do cadastro | Preencher os campos sozinho | **Risco:** CPF + nascimento são fáceis de descobrir; mostrar dados pessoais devolve privacidade a quem só sabe esses dois números. Só com uma segunda confirmação (por exemplo, o nome da mãe digitado) |
| Atendimentos e vouchers futuros (precisa de sessão do paciente) | "Você já tem uma consulta marcada para…", "repetir o último médico" | Mesma prova de identidade; mais chamadas à API |

Recomendação: ligar **idade** e **plano cadastrado** primeiro (sem mostrar dado pessoal) e deixar o preenchimento automático de nome, telefone e e-mail para depois de uma segunda confirmação.
