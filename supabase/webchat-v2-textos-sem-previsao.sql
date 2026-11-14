-- 14/11/2026 — Textos sem a palavra "previsão".
-- Os horários agora vêm da agenda real do Klingo; só o que o chat NÃO consegue marcar vira "pedido" para a equipe.
-- Fluxograma: paciente escolhe horário -> chat tenta marcar -> (marcou: confirma na tela) | (não marcou: pedido vai para a equipe, texto abaixo).
-- Versão: 1. Rollback: reaplicar os textos antigos (guardados no fim deste arquivo).
update public.fluxo_texto set texto = 'Não consegui concluir o agendamento sozinho. O horário que você escolheu ainda não está confirmado e já passei tudo para a nossa equipe: uma pessoa confirma com você em instantes.' where chave = 'marcar_equipe';
update public.fluxo_texto set texto = 'O sistema da clínica demorou a responder. O seu horário ainda não está confirmado até a equipe conferir a marcação. Você não precisa repetir nada.' where chave = 'marcar_incerto';
update public.fluxo_texto set texto = 'Não consegui agendar pelo convênio {plano} agora. O seu horário ainda não está confirmado. Já passei para a equipe, que resolve com você e confirma.' where chave = 'marcar_plano';
update public.fluxo_texto set texto = 'Pronto, {nome}! Recebemos tudo e já está com a nossa equipe. 💚 No momento não estamos online, mas assim que possível um atendente (uma pessoa) vai conferir e te enviar aqui a confirmação de data, horário e valor. O horário que você escolheu ainda não está confirmado. Você pode escrever a qualquer momento.' where chave = 'pronto_offline';
update public.fluxo_texto set texto = 'Pronto, {nome}! Recebemos tudo e já está com a nossa equipe. 💚 O horário que você escolheu ainda não está confirmado: um atendente (uma pessoa) vai conferir, marcar no sistema e te enviar aqui a confirmação de data, horário e valor, assim que possível. Se quiser falar com a gente, é só escrever a qualquer momento.' where chave = 'pronto_online';
-- Rollback (textos antigos): trocar "ainda não está confirmado" de volta por "é uma previsão e ainda não está confirmado" nas 5 chaves acima.
