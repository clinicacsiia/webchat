# Conformidade legal, acessibilidade e transparência (17 itens)

Atualizado em 02/11/2026. `[x]` = feito ou já estava em conformidade. `[ ]` = pendente. Textos jurídicos são **rascunho até a revisão do jurídico**.

- [x] 1. Política de privacidade: `privacidade.html` (quem trata, dados, base legal, terceiros, retenção, direitos, crianças). Link no chat, no menu e no Minha vez.
- [x] 2. Termos de serviço: `termos.html` (IA, previsão, emergência, uso, conta).
- [ ] 3. Aviso de cookies: o site não usa cookies de rastreamento; a política explica o armazenamento local. Falta decidir se entra banner informativo (ver pergunta 4 da análise).
- [x] 4. Reembolso: não se aplica (não há cobrança no site). Dito em `termos.html`, item 3.
- [x] 5. Consentimento LGPD: caixa do formulário e do cadastro com link para política e termos; texto próprio do responsável legal para criança (art. 14); autorização específica da foto do pedido (dado de saúde) antes de enviar a foto.
- [ ] 6. Só dados necessários: confirmar com a clínica se CPF, nascimento e endereço são obrigatórios no agendamento.
- [x] 7. Tracking: não há script de rastreamento (auditado). Se entrar analytics, deve ficar bloqueado até o aceite.
- [ ] 8. Marcação semântica: faltam `<main>` e `<h1>` no painel.
- [x] 9. `alt` nas imagens: conferido (decorativas com `alt=""`, logos com `alt`).
- [ ] 10. Contraste: texto já passa de 4,5:1; falta a borda dos campos (1,46:1, mínimo 3:1).
- [ ] 11. Teclado: foco visível e ESC ok; falta conferir retorno do foco e foco preso no modal.
- [x] 12. Avaliações falsas: não existem.
- [ ] 13. Promessas: revisado "guardada com segurança" da foto (trocado por texto exato). Falta revisão final da copy pela clínica.
- [ ] 14. Copyright: só há logo e ícones da CSI; a clínica confirma que é dona do logo.
- [ ] 15. Dados da empresa: rodapé tem endereço, telefone, responsável técnico e links; **falta o CNPJ** (hoje "a informar").
- [ ] 16. Exclusão LGPD: "Meus dados" explica o que sai e o que fica e dá o canal de pedido (WhatsApp). Falta decidir exclusão total e criar um canal registrado de pedidos.
- [ ] 17. Riscos jurídicos: ver bloqueios abaixo.

## Bloqueios antes de usar com paciente real
- **Leitura da foto por IA** (`ler-pedido`) e **biometria da fila**: não ligar sem revisão jurídica (consentimento, retenção, RIPD, contrato com o provedor). Ver `docs/pendencias-e-dependencias.md` A8, B3 e D7.
- Prazo de retenção de conversas e fotos: definir e escrever em `privacidade.html`, item 5.
- Confirmar região do Supabase e contratos de operador (art. 33 da LGPD).
- Preencher CNPJ e e-mail do encarregado nas duas páginas, no rodapé do chat e nos textos de "Meus dados".
