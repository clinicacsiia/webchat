-- public.medico_aviso_resolver(p_id bigint, p_acao text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.medico_aviso_resolver(p_id bigint, p_acao text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.medico_aviso; k record; r public.medico_regra; v_dias integer[]; v_ini text; v_fim text; v_status text;
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  if p_acao not in ('aceitar', 'manter') then raise exception 'Ação desconhecida.' using errcode = '22023'; end if;
  select * into a from public.medico_aviso where id = p_id for update;
  if not found or a.status <> 'pendente' then return jsonb_build_object('ok', true, 'ja_resolvido', true); end if;
  select * into k from public.medico_klingo() m where m.profissional = a.profissional and m.unidade = a.unidade;
  select * into r from public.medico_regra where profissional = a.profissional and unidade = a.unidade;

  if a.tipo = 'removido' or k.profissional is null then
    delete from public.medico_base where profissional = a.profissional and unidade = a.unidade;
    delete from public.medico_regra where profissional = a.profissional and unidade = a.unidade;
    delete from public.medico_turno where profissional = a.profissional and unidade = a.unidade;
  else
    insert into public.medico_base (profissional, unidade, dias, hora_ini, hora_fim, conferido_em) values (k.profissional, k.unidade, k.dias, k.hora_ini, k.hora_fim, now())
      on conflict (profissional, unidade) do update set dias = excluded.dias, hora_ini = excluded.hora_ini, hora_fim = excluded.hora_fim, conferido_em = now();
    if p_acao = 'aceitar' then
      if r.profissional is not null then perform public.medico_regra_gravar(k.profissional, k.unidade, null, null, null, r.nota); end if;
      delete from public.medico_turno where profissional = a.profissional and unidade = a.unidade;
    elsif a.tipo = 'novo' then
      insert into public.profissional_bloqueio (profissional, nome, motivo, bloqueado_em, bloqueado_por) values (public.norm_nome(k.profissional), k.profissional, 'Médico novo na agenda: não liberado pela equipe', now(), (select auth.uid()))
        on conflict (profissional) do nothing;
    elsif r.profissional is null then
      select array_agg(x::int) into v_dias from jsonb_array_elements_text(a.antes -> 'dias') x;
      v_ini := a.antes ->> 'hora_ini'; v_fim := a.antes ->> 'hora_fim';
      begin
        perform public.medico_regra_gravar(k.profissional, k.unidade, v_dias, v_ini, v_fim, null);
      exception when others then null;
      end;
    end if;
  end if;

  if a.tipo = 'novo' and k.profissional is not null then
    insert into public.medico_proc_base (profissional, procedimento_id) select p.profissional, p.procedimento_id from public.medico_procs_klingo() p
      where public.norm_nome(p.profissional) = public.norm_nome(a.profissional) on conflict do nothing;
  end if;
  v_status := case when p_acao = 'aceitar' then 'aceito' else 'mantido' end;
  update public.medico_aviso set status = v_status, resolvido_em = now(), resolvido_por = (select auth.uid()) where id = p_id;
  return jsonb_build_object('ok', true, 'status', v_status);
end $function$;

