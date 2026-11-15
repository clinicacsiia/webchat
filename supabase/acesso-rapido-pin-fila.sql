-- FLUXOGRAMA: entrada (a minha-vez nova já publicada: ela manda o aparelho no cabeçalho x-acesso e leva quem não tem PIN à página de acesso) -> validação (app_pin_exigir_leitura de acesso-rapido-pin-total.sql; só vale com app_acesso_modo, app_pin_obrigatorio e app_pin_servidor = sim) -> lógica (checkin_publico, fila_cheguei, fila_minha_vez, paciente_jornada e fila_push_salvar passam a recusar quem não tem aparelho com PIN; a equipe e o link da fila emitido pela clínica não são afetados) -> saída (o check-in e a fila também são só para quem tem PIN)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (fase 2 da auditoria de 15/11/2026).
--
-- QUANDO APLICAR: SÓ DEPOIS de a minha-vez nova (PR da auditoria) estar publicada. A minha-vez antiga não manda o aparelho: com estas 5 funções protegidas o check-in dela é recusado (aconteceu por alguns minutos em 15/11/2026; foi recuado na hora). Confira antes: curl -s https://clinicacsiia.github.io/webchat/minha-vez/ | grep -c fetchComAparelho  (tem de dar 1 ou mais).
-- ROLLBACK (na hora, sem mexer no resto): refazer as 5 funções sem a linha "perform public.app_pin_exigir_leitura();" (o conector aceita este bloco):
--   do $x$ declare r record; v text; n text; begin for r in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname in ('checkin_publico','fila_cheguei','fila_minha_vez','paciente_jornada','fila_push_salvar') loop v := pg_get_functiondef(r.oid); n := regexp_replace(v, E'\n  perform public\\.app_pin_exigir_leitura\\(\\);[^\n]*', ''); if n <> v then execute n; end if; end loop; end $x$;

do $mig$
declare r record; v_def text; v_novo text;
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('checkin_publico', 'fila_cheguei', 'fila_minha_vez', 'paciente_jornada', 'fila_push_salvar') order by p.proname loop
    v_def := pg_get_functiondef(r.oid);
    if position('app_pin_exigir' in v_def) > 0 then continue; end if;   -- já aplicada
    v_novo := regexp_replace(v_def, E'(AS \\$function\\$.*?\\n[ \\t]*begin[ \\t]*\\n)', E'\\1  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)\n');
    if v_novo = v_def then raise exception 'não achei o begin principal de %', r.proname; end if;
    execute v_novo;
  end loop;
end $mig$;
