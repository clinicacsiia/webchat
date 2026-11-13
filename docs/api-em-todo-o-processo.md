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
