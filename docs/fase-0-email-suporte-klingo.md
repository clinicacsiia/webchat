Para: suporte@klingo.com.br
Assunto: Clínica CSI (clinicacsi.klingo.app): dúvidas sobre a API externa para um assistente de pré-cadastro

Olá, equipe Klingo.

Estamos montando um assistente de pré-cadastro para o chat da Clínica CSI. A marcação final continua sendo feita por uma atendente no Klingo. Poderiam nos ajudar com os pontos abaixo?

**Acesso**
1. A API externa de pacientes e horários (`/externo/register`, `/externo/login`, `/agenda/horarios`, `/agenda/horario`) ainda é a versão vigente? A coleção Postman pública é de 2020. Poderiam enviar a documentação atual, a baseUrl, o X-APP-TOKEN, e o login e a senha de integração?
2. Existe ambiente de testes (homologação) para validarmos o fluxo sem criar cadastros ou reservar horários reais?

**Cadastro de paciente**
3. Quais campos são obrigatórios no formulário de paciente novo (o que aparece depois do botão "Ocupar")?
4. Existe busca de paciente por CPF na API? Queremos evitar cadastro duplicado.
5. O CNS (Cartão SUS) e o nome social podem ser enviados pela API? Não constam na coleção.

**Pré-agendamento**
6. Existe reserva provisória ou pré-agendamento pela API? Hoje só vemos a marcação direta. A "Lista de Espera" está disponível por API?

**Valores e preparo**
7. Há endpoint para consultar o valor de um procedimento por plano e para Particular? O relatório de preços por operadora (#13983) não traz o valor Particular. Em qual tabela de preço ele está cadastrado?
8. Há endpoint para as instruções ao paciente (preparo) por procedimento e por plano?

**Relatórios por API**
9. Os relatórios criados no editor (#13981, #13983, #13984) podem ser lidos por `/api/info/relatorio` com o X-APP-TOKEN atual, de forma contínua? Existe limite de chamadas?
10. Os filtros do relatório aceitam operadora, procedimento e tabela pela URL (`:<id>=<valor>`)? Hoje, sem filtro, o #13983 responde "Excesso de registros".
11. Como o Klingo marca um plano ou convênio como bloqueado ou inativo? Existe coluna para isso nos relatórios de cadastro?
12. Existe aviso automático (webhook) quando uma marcação é criada, alterada ou cancelada? Hoje a única alternativa é consultar os relatórios de tempos em tempos.

Obrigado!
Clínica CSI
