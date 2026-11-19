# LGPD no WebChat: o que foi feito, como pedir eliminação e o que ainda falta

Versão 1.0 — 19/11/2026 / Mudança: primeira versão (decisões do dono de 19/11/2026: tirar o CSV, apagar leitura por IA e biometria, eliminação a pedido, CNPJ e e-mail do encarregado).

Este arquivo **não é parecer jurídico**. É o retrato técnico para o advogado conferir.

## 1. Decisões do dono (19/11/2026) e o estado de cada uma
| Decisão | Estado |
|---|---|
| Retirar o botão **Exportar CSV** dos contatos | Feito (painel `v76`). Ninguém exporta a lista; o painel só mostra. O perfil Marketing continua vendo nome, telefone e e-mail dos contatos na tela (decida se mantém). |
| **Leitura da foto por IA**: apagar do código | Feito. Saíram a função `ler-pedido` (nunca esteve publicada) e a chamada no chat. **Fica** a leitura no próprio celular (Tesseract): nada vai a terceiros. |
| **Assinatura biométrica**: apagar | Feito no código **e no banco** (tabelas vazias, 0 linhas). Ver `supabase/lgpd-remover-biometria.sql`. |
| **CNPJ e e-mail do encarregado** | Feito em `privacidade.html` e `termos.html` (CNPJ 23.628.657/0001-01; clinicacsiia@gmail.com). |
| **Previsão de marcação**: texto da política | Feito: diz que o site não envia WhatsApp/SMS, que os dados só servem para conferência e podem ser apagados a pedido. |
| **Eliminação conforme o art. 18** | Feito: botão **Pedido de eliminação (LGPD)** em Contatos (só administrador). Ver seção 2. |
| **Repositório particular** (GitHub Pro) | **Com você.** Passo a passo na seção 4. |
| Proteção da `klingo-agendamento` | **Já estava no ar** (conferido em 19/11/2026): tabela `klingo_agendamento_evento`, funções `klingo_agendamento_passar` e `_resultado`, as 6 chaves `agendamento_*` e a versão 1.1 da função. Nada a publicar. |

## 2. Como atender um pedido de eliminação (passo a passo para a equipe)
1. O titular (ou o responsável, no caso de criança) pede por **clinicacsiia@gmail.com**, telefone ou WhatsApp. **Confirme quem é** (nome, nascimento e um dado que só a pessoa saiba). Responda em até **15 dias**.
2. No painel (entre como administrador): **Contatos > Pedido de eliminação (LGPD)**.
3. Preencha o telefone, o CPF e/ou o e-mail de quem pediu (quanto mais dados, mais completo; use os três quando tiver).
4. Toque em **Conferir o que existe**. Nada é apagado nesse passo: aparece a lista do que seria apagado.
5. Se estiver certo, toque em **Apagar tudo isso** e confirme. **Não tem volta.**
6. O sistema grava o pedido em `lgpd_pedido` **só com contagens e códigos embaralhados** (nunca o telefone, CPF ou e-mail). Isso prova que o pedido foi atendido.
7. Responda ao titular dizendo **o que foi apagado** e **o que a lei manda manter** (a tela mostra o texto pronto).

**O que a função apaga:** conta de login do chat, contatos, conversas, mensagens, fotos e arquivos, pedidos de agendamento, acesso rápido (celular, PIN, aparelhos, registros de acesso com IP e localização, laudos, marcações, resultados), filhos, pessoas de confiança, códigos por e-mail, pré-cadastro da previsão, chegadas na fila e o cadastro de paciente do chat que nunca teve atendimento registrado.

**O que NÃO apaga (e por quê):**
- Cadastro e agendamentos **no Klingo**: prontuário e registros de saúde (LGPD art. 16, I; Lei 13.787/2018). Isso só pode ser tratado no próprio Klingo, com a regra de guarda da clínica.
- A **cópia da agenda no painel** (Jornada): é refeita a partir do Klingo a cada 30 segundos; apagar aqui não adianta enquanto o Klingo mantiver o registro.
- Indicadores já somados, sem identificação da pessoa.
- O registro do pedido (só códigos embaralhados).

**Limite que você precisa saber:** a **previsão de marcação** é refeita a partir do Klingo para quem tem marcação **em aberto**. Se a pessoa for apagada e ainda tiver marcação aberta no Klingo, ela volta ao pré-cadastro na próxima leitura (10 minutos). Para vedar de vez, diga "bloqueie a pessoa na previsão" e eu crio a lista de bloqueio (por código embaralhado).

## 3. Resposta a incidente (rascunho para o advogado revisar)
Incidente = acesso, perda, vazamento ou alteração indevida de dado pessoal (ex.: alguém marcou ou cancelou exame de outra pessoa; chave exposta; conta de equipe invadida).
1. **Conter (em minutos):** desligar o que for preciso. Chaves prontas: `agendamento_externo_modo` (`leitura` ou `nao`), `app_acesso_modo`, `previsao_marcacao_modo`, `app_laudos`, `login_paciente`. Trocar a senha ou o segredo envolvido. Para desligar: `update public.config set valor = 'nao' where chave = '<chave>';` ([editor SQL](https://supabase.com/dashboard/project/nrvuynjwcgwpjdptkiay/sql/new)).
2. **Registrar:** anotar data e hora, o que aconteceu, quais dados e de quantas pessoas, e quem descobriu. O Supabase guarda os registros técnicos (sem texto de mensagem).
3. **Avaliar o risco:** dado de saúde ou de criança é risco alto por padrão.
4. **Avisar** (prazo razoável; a ANPD considera **3 dias úteis**): a **ANPD** (https://www.gov.br/anpd) e os **titulares** atingidos, com o que aconteceu, quais dados, o que foi feito e como se proteger. Quem decide e assina é o controlador (a clínica) com o advogado.
5. **Corrigir e aprender:** causa, correção, teste que prova que não repete (`testes/`) e atualização de `docs/`.

## 4. Repositório particular (você faz, 5 minutos)
1. Assine o **GitHub Pro**: https://github.com/settings/billing/plans
2. **Confirme** que o Pages continua funcionando em repositório particular no seu plano: https://docs.github.com/pages/getting-started-with-github-pages/changing-the-visibility-of-your-github-pages-site
3. Torne o repositório particular: https://github.com/clinicacsiia/webchat/settings (rolar até **Danger Zone > Change visibility**).
4. Abra o chat e o painel e confira que carregam: https://clinicacsiia.github.io/webchat/ e https://clinicacsiia.github.io/webchat/painel/
5. **Limite:** tornar particular não apaga o que já foi copiado por alguém (clones, buscadores). O telefone de teste e o CPF do dono que estão em commits antigos continuam no histórico. Trocar o telefone de teste em `klingo_api_telefones_teste` resolve o risco prático (`docs/reestruturacao-2026-11-14/08-limpeza-do-telefone-no-github.md`).

## 5. RIPD resumido (relatório de impacto: base para o advogado)
- **Quem é o controlador:** CSI - Clínica de Saúde e Imagem, CNPJ 23.628.657/0001-01. **Encarregado:** clinicacsiia@gmail.com.
- **Dados tratados:** identificação e contato; **dado de saúde** (pedidos de exames, foto do pedido, laudos, resultados); **dado de criança** (filhos, com o responsável); CPF; IP, aparelho e localização aproximada (opcional) no acesso rápido; pré-cadastro da previsão.
- **Finalidade:** agendar e acompanhar atendimento; confirmar que a pessoa é ela mesma; avisar sobre a agenda.
- **Operadores:** Supabase (banco e funções), GitHub Pages (hospedagem), Klingo (agenda e prontuário), Google/Gmail (e-mail do código), jsDelivr, ViaCEP e Cloudflare Turnstile (bibliotecas, CEP e robôs). **Sem** provedor de IA e **sem** biometria.
- **Riscos principais e controles:** (1) alguém agir em nome de outro com CPF + nascimento: limites por IP e por CPF na `klingo-agendamento`, PIN no servidor no acesso rápido; (2) vazamento por conta de equipe: papéis (admin, atendente, marketing) e RLS ligada em todas as 150 tabelas; (3) uso para outra finalidade: exportação de contatos retirada; (4) dado guardado sem fim: limpeza de 180 dias do registro de acessos, código por e-mail em 3 dias, eliminação a pedido; (5) repositório público: virar particular (seção 4).
- **O que falta definir (decisão de quem manda, com o advogado):** prazo máximo de guarda das conversas e fotos sem pedido de eliminação; se o perfil Marketing continua vendo nome, telefone e e-mail; contrato (cláusulas LGPD) com Supabase, Klingo e Google; onde o Supabase guarda os dados (região).

## 6. O que continua pendente (precisa de você ou do jurídico)
- Revisão do advogado em `privacidade.html` e `termos.html` (o aviso "texto-base em revisão jurídica" continua no topo de propósito até lá).
- Prazo de guarda das conversas e fotos (hoje: até o titular pedir; os pedidos que o paciente apaga saem da lista dele em 30 dias).
- Assinar/arquivar os contratos com os operadores.
- Repositório particular (seção 4).
- CPF obrigatório no acesso rápido: manter ou deixar opcional (princípio da necessidade, art. 6º, III).
