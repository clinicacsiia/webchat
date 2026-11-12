-- FLUXOGRAMA: entrada (todo dia, depois da sincronização do Klingo, a rotina "convenio-seguir-klingo"; lê klingo_plano_map, que vem da lista de planos da API) -> validação (só roda se config.convenio_seguir_klingo = 'sim'; nunca apaga linha, só liga/desliga "ativo") -> lógica (convênio que o Klingo não lista ou não atende = inativo no chat; convênio que o Klingo lista e atende = ativo; o chat é uma cópia do Klingo; mensagens e avisos escritos pela equipe ficam como estão) -> saída (convenio_config atualizado; a gestão é avisada de cada convênio que mudou; o paciente vê a mensagem de convênio inativo logo ao escolher o convênio, como já acontece)
-- Versão 1.0 — 12/11/2026 / Mudança: decisão do dono em 12/11/2026 ("o Klingo é sempre a verdade; o chat é uma cópia").
-- ROLLBACK: update public.config set valor = 'nao' where chave = 'convenio_seguir_klingo'; select cron.unschedule('convenio-seguir-klingo'); drop function public.convenio_seguir_klingo();
-- Efeito esperado na produção de 12/11/2026: GEAP e SELECT (hoje inativos no chat, mas ativos no Klingo) voltam a ser aceitos; ASSEFAZ e PF Saúde continuam inativos. A gestão recebe um aviso por convênio que mudar.

insert into public.config (chave, valor) values ('convenio_seguir_klingo', 'sim') on conflict (chave) do nothing;

CREATE OR REPLACE FUNCTION public.convenio_seguir_klingo()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; v_off int := 0; v_on int := 0;
begin
  if public.klingo_cfg('convenio_seguir_klingo', 'sim') <> 'sim' then return jsonb_build_object('ligada', false); end if;
  -- o Klingo não lista / não atende: inativo no chat
  for r in select public.convenio_chave(m.operadora) as chave, m.operadora from public.klingo_plano_map m where m.origem = 'nao_atende' and nullif(btrim(m.operadora), '') is not null loop
    if not exists (select 1 from public.convenio_config c where c.operadora = r.chave) then
      insert into public.convenio_config (operadora, ativo, motivo, atualizado_em) values (r.chave, false, 'Klingo: não consta como convênio atendido', now());
      v_off := v_off + 1;
      perform public.klingo_avisar_gestao('O convênio ' || initcap(lower(r.operadora)) || ' foi marcado como NÃO atendido no chat porque o Klingo não o lista como ativo.', jsonb_build_object('convenio', r.chave, 'para', 'inativo'));
    elsif exists (select 1 from public.convenio_config c where c.operadora = r.chave and c.ativo) then
      update public.convenio_config set ativo = false, motivo = coalesce(nullif(motivo, ''), 'Klingo: não consta como convênio atendido'), atualizado_em = now() where operadora = r.chave;
      v_off := v_off + 1;
      perform public.klingo_avisar_gestao('O convênio ' || initcap(lower(r.operadora)) || ' foi marcado como NÃO atendido no chat porque o Klingo não o lista como ativo.', jsonb_build_object('convenio', r.chave, 'para', 'inativo'));
    end if;
  end loop;
  -- o Klingo lista e atende: ativo no chat (a suspensão temporária da equipe, em suspenso_em, não é mexida)
  for r in select c.operadora as chave, m.operadora from public.convenio_config c join public.klingo_plano_map m on public.convenio_chave(m.operadora) = c.operadora
            where not c.ativo and m.plano_id is not null and m.origem <> 'nao_atende' loop
    update public.convenio_config set ativo = true, atualizado_em = now() where operadora = r.chave;
    v_on := v_on + 1;
    perform public.klingo_avisar_gestao('O convênio ' || initcap(lower(r.operadora)) || ' voltou a ser aceito no chat porque o Klingo o lista como ativo.', jsonb_build_object('convenio', r.chave, 'para', 'ativo'));
  end loop;
  return jsonb_build_object('ligada', true, 'desativados', v_off, 'ativados', v_on);
end $function$;
REVOKE ALL ON FUNCTION public.convenio_seguir_klingo() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.convenio_seguir_klingo() TO service_role;

select cron.schedule('convenio-seguir-klingo', '10 7 * * *', 'select public.convenio_seguir_klingo()');
