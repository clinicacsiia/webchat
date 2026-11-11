-- FLUXOGRAMA: entrada (agendador a cada 10 min) -> validação (conversa dos últimos 30 dias, sem vínculo com o Klingo e sem nenhum aviso klingo_ligado/klingo_varios) -> lógica (roda paciente_klingo_ligar; liga só se achar UM prontuário real) -> saída (vínculo automático + aviso "Paciente ligado ao Klingo")
-- DEPENDÊNCIAS: paciente-aviso.sql, paciente-klingo-ligar-correcao-n.sql, pg_cron
-- ROLLBACK: select cron.unschedule('klingo-ligar-pendentes'); e remover a função public.paciente_klingo_ligar_pendentes()
-- MOTIVO (11/11/2026): o gatilho só roda quando a conversa nasce ou muda nome/e-mail/conta. Se o paciente aparece no Klingo (ou o cadastro muda) depois, nada religava sozinho.
-- Conversas que já tiveram aviso (ligado ou "mais de um", mesmo resolvido) NÃO são refeitas: evita reabrir aviso que a equipe já conferiu.
create or replace function public.paciente_klingo_ligar_pendentes()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare r record; v_n integer := 0;
begin
  for r in select c.id from public.conversas c
            where c.criado_em > now() - interval '30 days'
              and not exists (select 1 from public.pessoa_klingo_vinculo v where v.conversa_id = any (public.pessoa_membros(c.id)))
              and not exists (select 1 from public.paciente_aviso a where a.conversa_id = c.id and a.tipo in ('klingo_ligado', 'klingo_varios'))
            order by c.criado_em desc limit 200 loop
    begin v_n := v_n + public.paciente_klingo_ligar(r.id); exception when others then null; end;
  end loop;
  return v_n;
end $function$;

select cron.schedule('klingo-ligar-pendentes', '4-59/10 * * * *', 'select public.paciente_klingo_ligar_pendentes()');
