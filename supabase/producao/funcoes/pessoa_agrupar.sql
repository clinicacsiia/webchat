-- public.pessoa_agrupar(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pessoa_agrupar(p_conversa uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  f jsonb := public.pessoa_ficha(p_conversa); r record; v_grupo uuid; v_n integer := 0; v_choca boolean; v_choques uuid[]; v_resto integer;
  begin
    if f is null or f ->> 'nome' is null then return 0; end if;
      select grupo_id into v_grupo from public.conversa_grupo where conversa_id = p_conversa;
        if v_grupo is not null and (select origem from public.conversa_grupo where conversa_id = p_conversa) = 'auto' then
            v_choques := array(select g.conversa_id from public.conversa_grupo g where g.grupo_id = v_grupo and g.conversa_id <> p_conversa
                                    and jsonb_array_length(public.pessoa_sinais(p_conversa, g.conversa_id) -> 'conflitos') > 0);
                                        if cardinality(v_choques) > 0 then
                                              insert into public.conversa_grupo_recusa (a, b) select least(p_conversa, x), greatest(p_conversa, x) from unnest(v_choques) x on conflict do nothing;
                                                    delete from public.conversa_grupo where conversa_id = p_conversa;
                                                          select count(*) into v_resto from public.conversa_grupo where grupo_id = v_grupo;
                                                                if v_resto < 2 then delete from public.conversa_grupo where grupo_id = v_grupo; end if;
                                                                      v_grupo := null;
                                                                          end if;
                                                                            end if;
                                                                              for r in
                                                                                  select c2.id, g.grupo_id as grupo, public.pessoa_sinais(p_conversa, c2.id) as s
                                                                                      from public.conversas c2
                                                                                          join public.contatos ct2 on ct2.id = c2.contato_id
                                                                                              left join public.pre_agendamentos pa2 on pa2.conversa_id = c2.id
                                                                                                  left join public.conversa_grupo g on g.conversa_id = c2.id
                                                                                                      where c2.id <> p_conversa
                                                                                                            and (v_grupo is null or g.grupo_id is distinct from v_grupo)
                                                                                                                  and (public.fone_chave(ct2.telefone) = f ->> 'fone'
                                                                                                                             or lower(nullif(btrim(coalesce(nullif(btrim(c2.email_informado), ''), ct2.email)), '')) = f ->> 'email'
                                                                                                                                        or (f ->> 'conta' is not null and c2.conta_id::text = f ->> 'conta')
                                                                                                                                                   or (f ->> 'nasc' is not null and public.data_ou_nula(pa2.paciente ->> 'dt_nasc')::text = f ->> 'nasc'))
                                                                                                                                                         and not exists (select 1 from public.conversa_grupo_recusa x where x.a = least(p_conversa, c2.id) and x.b = greatest(p_conversa, c2.id))
                                                                                                                                                             order by c2.atualizado_em desc
                                                                                                                                                               loop
                                                                                                                                                                   if (r.s ->> 'total')::int < 3 or jsonb_array_length(r.s -> 'conflitos') > 0 then continue; end if;
                                                                                                                                                                       if r.grupo is not null and v_grupo is not null then continue; end if;
                                                                                                                                                                           select exists (select 1 from public.conversa_grupo m
                                                                                                                                                                                               where m.grupo_id = coalesce(r.grupo, v_grupo) and m.conversa_id <> p_conversa
                                                                                                                                                                                                                     and jsonb_array_length(public.pessoa_sinais(p_conversa, m.conversa_id) -> 'conflitos') > 0)
                                                                                                                                                                                                                           into v_choca;
                                                                                                                                                                                                                               if v_choca then continue; end if;
                                                                                                                                                                                                                                   if v_grupo is null then
                                                                                                                                                                                                                                         v_grupo := coalesce(r.grupo, gen_random_uuid());
                                                                                                                                                                                                                                               insert into public.conversa_grupo (conversa_id, grupo_id, sinais, origem) values (p_conversa, v_grupo, array(select jsonb_array_elements_text(r.s -> 'sinais')), 'auto')
                                                                                                                                                                                                                                                       on conflict (conversa_id) do nothing;
                                                                                                                                                                                                                                                             v_n := v_n + 1;
                                                                                                                                                                                                                                                                 end if;
                                                                                                                                                                                                                                                                     if r.grupo is null then
                                                                                                                                                                                                                                                                           insert into public.conversa_grupo (conversa_id, grupo_id, sinais, origem) values (r.id, v_grupo, array(select jsonb_array_elements_text(r.s -> 'sinais')), 'auto')
                                                                                                                                                                                                                                                                                   on conflict (conversa_id) do nothing;
                                                                                                                                                                                                                                                                                         v_n := v_n + 1;
                                                                                                                                                                                                                                                                                             end if;
                                                                                                                                                                                                                                                                                               end loop;
                                                                                                                                                                                                                                                                                                 return v_n;
                                                                                                                                                                                                                                                                                                 end $function$;

