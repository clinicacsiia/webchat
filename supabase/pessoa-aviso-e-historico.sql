-- FLUXOGRAMA: entrada (conversas com mesmo nome + telefone + e-mail e datas de nascimento diferentes; paciente aberto no painel) -> validação (só equipe lê e age) -> lógica (atendente escolhe a data certa e as conversas unem, ou mantém separado; histórico junta os exames de todas as conversas do paciente) -> saída (cartão de aviso no alto da lista; bloco "Histórico do paciente" no chat)
-- DEPENDÊNCIAS: pessoa-unica.sql, pessoa-unica-correcao.sql (pessoa_sinais, pessoa_nasc_parecida, pessoa_confirmar, pessoa_separar, pessoa_membros, agendamento_fechamento)
-- ROLLBACK: drop function public.pessoa_avisos_data(), public.pessoa_corrigir_data(uuid, uuid, uuid[], date), public.pessoa_manter_separado(uuid[], uuid[]), public.paciente_linha_do_tempo(uuid);
-- Este arquivo documenta o que já foi aplicado no Supabase (migrações pessoa_aviso_data_a/b/c e paciente_centro_a). Aplicar de novo é seguro (create or replace).

create or replace function public.pessoa_avisos_data() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v jsonb;
begin
  perform public.pessoa_equipe();
  with f as materialized (select c.id, public.pessoa_ficha(c.id) as j from public.conversas c where c.criado_em > now() - interval '120 days'),
  par as (
    select a.id as a, b.id as b, a.j ->> 'nome' as nome, a.j ->> 'nasc' as na, b.j ->> 'nasc' as nb
      from f a join f b on a.id < b.id
     where a.j ->> 'nasc' is not null and b.j ->> 'nasc' is not null and a.j ->> 'nasc' <> b.j ->> 'nasc'
       and a.j ->> 'fone' is not null and a.j ->> 'fone' = b.j ->> 'fone'
       and a.j ->> 'email' is not null and a.j ->> 'email' = b.j ->> 'email'
       and a.j ->> 'tipo' = b.j ->> 'tipo' and public.nome_confere(a.j ->> 'nome', b.j ->> 'nome')
       and not exists (select 1 from public.conversa_grupo_recusa x where x.a = least(a.id, b.id) and x.b = greatest(a.id, b.id) and x.por is not null))
  select coalesce(jsonb_agg(jsonb_build_object('nome', q.nome, 'nasc_a', q.na, 'nasc_b', q.nb, 'parecida', public.pessoa_nasc_parecida(q.na, q.nb),
           'ids_a', q.ids_a, 'ids_b', q.ids_b) order by q.nome), '[]'::jsonb) into v
    from (select min(nome) as nome, na, nb, array_agg(distinct a) as ids_a, array_agg(distinct b) as ids_b from par group by na, nb) q;
  return v;
end $$;
revoke all on function public.pessoa_avisos_data() from public, anon;
grant execute on function public.pessoa_avisos_data() to authenticated;

create or replace function public.pessoa_corrigir_data(p_a uuid, p_b uuid, p_ids uuid[], p_data date) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  perform public.pessoa_equipe();
  if p_data is null or p_data > current_date or p_data < date '1900-01-01' then raise exception 'Data de nascimento inválida.' using errcode = '22023'; end if;
  update public.pre_agendamentos set paciente = jsonb_set(coalesce(paciente, '{}'::jsonb), '{dt_nasc}', to_jsonb(p_data::text))
   where conversa_id = any (p_ids);
  return public.pessoa_confirmar(p_a, p_b);
end $$;
revoke all on function public.pessoa_corrigir_data(uuid, uuid, uuid[], date) from public, anon;
grant execute on function public.pessoa_corrigir_data(uuid, uuid, uuid[], date) to authenticated;

create or replace function public.pessoa_manter_separado(p_ids_a uuid[], p_ids_b uuid[]) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare x uuid; y uuid;
begin
  perform public.pessoa_equipe();
  foreach x in array p_ids_a loop
    foreach y in array p_ids_b loop
      if x <> y then
        insert into public.conversa_grupo_recusa (a, b, por) values (least(x, y), greatest(x, y), (select auth.uid()))
          on conflict (a, b) do update set por = excluded.por, em = now();
      end if;
    end loop;
  end loop;
  foreach y in array p_ids_b loop perform public.pessoa_separar(y); end loop;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.pessoa_manter_separado(uuid[], uuid[]) from public, anon;
grant execute on function public.pessoa_manter_separado(uuid[], uuid[]) to authenticated;

-- Linha do tempo do paciente: todos os exames de todas as conversas dele, com o passo de cada um.
-- (corpo igual ao aplicado na migração paciente_centro_a_linha_do_tempo; ver o banco com pg_get_functiondef)
