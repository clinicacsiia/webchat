-- FLUXOGRAMA: entrada (conversas do chat e fila de chegada) -> validação (nome + 2 informações; erro de digitação na data de nascimento não separa) -> lógica (une grupos que já existem quando ninguém se contradiz; a fila acha TODAS as conversas da pessoa, com ou sem conta) -> saída (v_agendamento_aberto e lista de pedidos na identificação da fila)
-- DEPENDÊNCIAS: supabase/pessoa-unica.sql (conversa_grupo, conversa_grupo_recusa, pessoa_ficha, pessoa_sinais, pessoa_agrupar) e supabase/automacao-sistema.sql (fila_identificar_todos)
-- ROLLBACK: reaplicar pessoa-unica.sql e automacao-sistema.sql (restauram pessoa_sinais, pessoa_agrupar e fila_identificar_todos); drop function public.pessoa_nasc_parecida(text, text), public.pessoa_conversas_de(text, text, text, uuid);
-- Não apaga nem move nenhuma mensagem: só mexe nas ligações entre conversas (conversa_grupo) e nos bloqueios automáticos (conversa_grupo_recusa com por = null).

-- ======================================================================
-- 1. Data de nascimento com erro de digitação não separa a pessoa
--    (1997-05-11 contra 1996-05-11: um dígito só; ou dia e mês trocados). Nesse caso a data
--    não conta como informação batendo e também não conta como contradição.
-- ======================================================================
create or replace function public.pessoa_nasc_parecida(a text, b text) returns boolean
language sql immutable set search_path to '' as $$
  select a is not null and b is not null and a <> b and length(a) = 10 and length(b) = 10 and (
    (select count(*) from generate_series(1, 10) i where substr(a, i, 1) <> substr(b, i, 1)) = 1
    or (substr(a, 1, 4) = substr(b, 1, 4) and substr(a, 6, 2) = substr(b, 9, 2) and substr(a, 9, 2) = substr(b, 6, 2)))
$$;
revoke all on function public.pessoa_nasc_parecida(text, text) from public, anon, authenticated;

create or replace function public.pessoa_sinais(p_a uuid, p_b uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare a jsonb := public.pessoa_ficha(p_a); b jsonb := public.pessoa_ficha(p_b); s text[] := '{}'; k text[] := '{}'; v_aprox boolean := false;
begin
  if a is null or b is null or not public.nome_confere(a ->> 'nome', b ->> 'nome') then
    return jsonb_build_object('nome', false, 'sinais', '[]'::jsonb, 'conflitos', '[]'::jsonb, 'total', 0);
  end if;
  s := array['nome'];
  if a ->> 'fone' is not null and a ->> 'fone' = b ->> 'fone' then s := array_append(s, 'telefone'::text); end if;
  if a ->> 'email' is not null and a ->> 'email' = b ->> 'email' then s := array_append(s, 'email'::text); end if;
  if a ->> 'nasc' is not null and a ->> 'nasc' = b ->> 'nasc' then s := array_append(s, 'nascimento'::text); end if;
  if a ->> 'conta' is not null and a ->> 'conta' = b ->> 'conta' then s := array_append(s, 'conta'::text); end if;
  if a ->> 'nasc' is not null and b ->> 'nasc' is not null and a ->> 'nasc' <> b ->> 'nasc' then
    if public.pessoa_nasc_parecida(a ->> 'nasc', b ->> 'nasc') then v_aprox := true; else k := array_append(k, 'nascimento'::text); end if;
  end if;
  if a ->> 'conta' is not null and b ->> 'conta' is not null and a ->> 'conta' <> b ->> 'conta' then k := array_append(k, 'conta'::text); end if;
  if a ->> 'tipo' <> b ->> 'tipo' then k := array_append(k, 'tipo'::text); end if;
  return jsonb_build_object('nome', true, 'sinais', to_jsonb(s), 'conflitos', to_jsonb(k), 'total', cardinality(s), 'nascimento_parecido', v_aprox);
end $$;
revoke all on function public.pessoa_sinais(uuid, uuid) from public, anon, authenticated;

-- ======================================================================
-- 2. Agrupar: além de entrar num grupo, UNE dois grupos que já existem quando
--    nenhuma conversa de um contradiz nenhuma do outro e a equipe nunca disse "Não é".
-- ======================================================================
create or replace function public.pessoa_agrupar(p_conversa uuid) returns integer
language plpgsql security definer set search_path to '' as $$
declare
  f jsonb := public.pessoa_ficha(p_conversa); r record; v_grupo uuid; v_n integer := 0; v_choca boolean; v_choques uuid[]; v_resto integer;
begin
  if f is null or f ->> 'nome' is null then return 0; end if;
  select grupo_id into v_grupo from public.conversa_grupo where conversa_id = p_conversa;
  -- Uma informação que chega DEPOIS (a data de nascimento, por exemplo) pode contradizer o grupo: se isso acontecer, a conversa sai e o par fica recusado.
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
  -- Candidatas: dividem telefone, e-mail, conta ou nascimento. O nome sozinho nunca basta.
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
    if r.grupo is not null and v_grupo is not null then
      -- Dois grupos que já existem: junta sozinho só se NINGUÉM de um grupo contradiz ninguém do outro (nome, nascimento, conta, tipo) e a equipe nunca recusou o par.
      select exists (select 1 from public.conversa_grupo m1 join public.conversa_grupo m2 on m2.grupo_id = r.grupo
                      where m1.grupo_id = v_grupo
                        and (coalesce((public.pessoa_sinais(m1.conversa_id, m2.conversa_id) ->> 'nome')::boolean, false) is not true
                             or jsonb_array_length(public.pessoa_sinais(m1.conversa_id, m2.conversa_id) -> 'conflitos') > 0
                             or exists (select 1 from public.conversa_grupo_recusa x where x.a = least(m1.conversa_id, m2.conversa_id) and x.b = greatest(m1.conversa_id, m2.conversa_id))))
        into v_choca;
      if v_choca then continue; end if;
      update public.conversa_grupo set grupo_id = v_grupo where grupo_id = r.grupo;
      v_n := v_n + 1;
      continue;
    end if;
    -- A candidata (ou o grupo dela) não pode contradizer esta conversa em nenhum membro.
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
end $$;
revoke all on function public.pessoa_agrupar(uuid) from public, anon, authenticated;
grant execute on function public.pessoa_agrupar(uuid) to service_role;

-- ======================================================================
-- 3. Todas as conversas de uma pessoa, a partir de nome + telefone/e-mail/conta (não precisa de login).
--    Acha as conversas em que o nome confere e ao menos uma informação bate, e traz junto
--    todas as conversas dos grupos delas (assim o pedido feito de outro aparelho também entra).
-- ======================================================================
create or replace function public.pessoa_conversas_de(p_nome text, p_fone text, p_email text, p_conta uuid) returns uuid[]
language sql stable security definer set search_path to '' as $$
  with base as materialized (
    select c.id from public.conversas c join public.contatos ct on ct.id = c.contato_id
     where (public.fone_chave(p_fone) is not null and public.fone_chave(ct.telefone) = public.fone_chave(p_fone))
        or (nullif(btrim(p_email), '') is not null and lower(nullif(btrim(coalesce(nullif(btrim(c.email_informado), ''), ct.email)), '')) = lower(btrim(p_email)))
        or (p_conta is not null and c.conta_id = p_conta)
  ), sem as (
    select b.id from base b where public.nome_confere(public.pessoa_ficha(b.id) ->> 'nome', p_nome)
  )
  select coalesce(array_agg(distinct m), '{}'::uuid[]) from (
    select id as m from sem
    union
    select g2.conversa_id from public.conversa_grupo g1 join public.conversa_grupo g2 on g2.grupo_id = g1.grupo_id where g1.conversa_id in (select id from sem)
  ) x
$$;
revoke all on function public.pessoa_conversas_de(text, text, text, uuid) from public, anon, authenticated;

-- ======================================================================
-- 4. Fila: quem chegou é identificado com TODAS as conversas e TODOS os pedidos de exame da pessoa
--    (antes: só as 5 conversas mais recentes e só o exame marcado).
-- ======================================================================
create or replace function public.fila_identificar_todos() returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare r record; v_sal text; v_fh text; v_fone text; v_sit text; v_pac record; v_out jsonb := '[]'::jsonb; v_ids uuid[]; v_conv jsonb; v_aber jsonb; v_ped jsonb; v_kl jsonb;
begin
  perform public.fila_equipe_ok();
  select valor into v_sal from public.config where chave = 'ia_segredo';
  for r in
    select f.id, f.nome, f.email, f.telefone, f.conta_id, cp.nome as conta_nome, cp.telefone as conta_tel, cp.email as conta_email
      from public.fila_chegada f left join public.contas_paciente cp on cp.id = f.conta_id
     where f.status in ('aguardando', 'chamado') and public.fila_dia(f.chegou_em) = public.fila_dia(now())
  loop
    v_fone := public.fone_chave(coalesce(r.telefone, r.conta_tel));
    v_fh := case when v_fone is not null then encode(sha256(convert_to(right(regexp_replace(coalesce(r.telefone, r.conta_tel, ''), '\D', '', 'g'), 8) || coalesce(v_sal, ''), 'UTF8')), 'hex') end;
    v_pac := null; v_sit := 'novo';
    select p.id, p.nome, public.nome_confere(p.nome, coalesce(r.conta_nome, r.nome)) as nome_ok into v_pac
      from public.pacientes p
     where (v_fone is not null and v_fone = any (p.telefones)) or (coalesce(r.email, r.conta_email, '') <> '' and lower(p.email) = lower(coalesce(r.email, r.conta_email)))
     order by public.nome_confere(p.nome, coalesce(r.conta_nome, r.nome)) desc, p.ultima_visita_em desc limit 1;
    if v_pac.id is not null then v_sit := case when v_pac.nome_ok then 'cadastrado' else 'talvez' end; end if;

    v_ids := public.pessoa_conversas_de(coalesce(r.conta_nome, r.nome), coalesce(r.telefone, r.conta_tel), coalesce(r.email, r.conta_email), r.conta_id);
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'status', x.status) order by x.atualizado_em desc), '[]'::jsonb) into v_conv
      from (select cv.id, cv.status, cv.atualizado_em from public.conversas cv where cv.id = any (v_ids) order by cv.atualizado_em desc limit 100) x;
    select coalesce(jsonb_agg(jsonb_build_object('conversa_id', a.conversa_id, 'exames', a.exames, 'pendente', a.passou) order by a.quando), '[]'::jsonb) into v_aber
      from public.v_agendamento_aberto a where a.conversa_id = any (v_ids);
    select coalesce(jsonb_agg(jsonb_build_object('conversa_id', y.conversa_id, 'status', y.status, 'exames', y.exames) order by case y.status when 'agendado' then 0 when 'pronto' then 1 else 2 end, y.criado_em desc), '[]'::jsonb) into v_ped
      from (select pa.conversa_id, pa.status, pa.criado_em,
                   coalesce(nullif((select string_agg(coalesce(nullif(i.procedimento, ''), i.modalidade), ' + ' order by i.id) from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo), ''), nullif(pa.procedimento, '')) as exames
              from public.pre_agendamentos pa where pa.conversa_id = any (v_ids)) y
     where y.exames is not null;
    select coalesce(jsonb_agg(jsonb_build_object('nome', e.procedimento, 'status', e.status) order by e.id), '[]'::jsonb) into v_kl
      from public.jornada_card c join public.jornada_paciente jp on jp.prontuario = c.paciente_chave join public.jornada_exame e on e.card_id = c.id
     where c.arquivado_em is null and c.data_ref = public.fila_dia(now()) and c.paciente_chave not like 'conv:%' and c.paciente_chave not like 'manual:%'
       and v_fh is not null and jp.fone_chave = v_fh and public.nome_confere(jp.nome, coalesce(r.conta_nome, r.nome));
    v_out := v_out || jsonb_build_object('id', r.id, 'situacao', v_sit, 'paciente_nome', v_pac.nome, 'conversas', v_conv, 'abertos', v_aber, 'pedidos', v_ped, 'klingo', v_kl);
  end loop;
  return v_out;
end $$;
revoke all on function public.fila_identificar_todos() from public, anon;
grant execute on function public.fila_identificar_todos() to authenticated;

-- ======================================================================
-- 5. Conserto do que já está no banco
--    Tira os bloqueios automáticos (por = null) que só existiam por causa do erro de digitação na data
--    de nascimento e junta de novo. Bloqueio feito pela equipe ("Não é a mesma pessoa") nunca é tocado.
-- ======================================================================
delete from public.conversa_grupo_recusa
 where por is null and jsonb_array_length(public.pessoa_sinais(a, b) -> 'conflitos') = 0;
select sum(public.pessoa_agrupar(c.id)) as ligacoes_novas from public.conversas c;

-- ======================================================================
-- 6. COMO FOI APLICADO NO BANCO (em pedaços pequenos, sem delete dentro de função)
--    Em vez de trocar pessoa_agrupar (tem delete e o Supabase pede confirmação), a união de grupos virou uma função à parte:
--    public.pessoa_unir_grupos(uuid), chamada logo depois de pessoa_agrupar pelos dois gatilhos.
--    Também no banco: pessoa_pedidos_de(uuid[]), pessoa_resumo_de(uuid[]) e a nova fila_identificar_todos().
--    A seção 2 (pessoa_agrupar) deste arquivo NÃO precisa ser aplicada.
-- ======================================================================
