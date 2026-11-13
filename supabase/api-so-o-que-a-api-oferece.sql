-- FLUXOGRAMA: entrada (o paciente chega ao passo "tipo de consulta") -> validação (klingo_so_liberados = sim E a API de horários ligada para a conversa) -> lógica (klingo_liberado deixa passar só
--   as consultas das especialidades que a API do Klingo oferece, tabela klingo_especialidade, atualizada toda madrugada por klingo-sincronizar) -> saída (a lista mostra só o que a API oferece).
-- Versão 1.0 — 13/11/2026 / Mudança: pedido do dono ("só mostrar o que a API disponibilizar"). (1) klingo_liberado passa a seguir a API de HORÁRIOS (antes seguia a chave de marcação, que o dono pode desligar
--   sem querer); (2) config klingo_so_liberados = sim. Escolha do dono em 13/11/2026: aceitar esconder o que a API não oferece.
-- Efeito medido em 13/11/2026: Desenvoar mostra 5 de 9 consultas (somem Endocrinopediatria, Gastropediatria, Ortopediatra e Puericultura); CSI mostra 1 de 9 (só Radiologia).
-- ROLLBACK: update public.config set valor = 'nao' where chave = 'klingo_so_liberados';   (volta a lista completa na hora; a função pode ficar como está)
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.klingo_liberado(uuid,integer,text)'::regprocedure);
  if position('klingo_api_horarios' in d) > 0 then return; end if;
  if position('''klingo_api_marcar''' in d) = 0 then raise exception 'ponto de troca não encontrado'; end if;
  execute replace(replace(d, '''klingo_api_marcar''', '''klingo_api_horarios'''), '-- fora do autoatendimento a lista é a de sempre', '-- o filtro acompanha a API de HORÁRIOS (não a marcação): fora dela a lista é a de sempre');
end $do$;
update public.config set valor = 'sim' where chave = 'klingo_so_liberados';
