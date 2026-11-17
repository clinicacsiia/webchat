-- FLUXOGRAMA: entrada (o painel chama estas funções logado como admin ou atendente) -> validação (papel_atual() = admin ou atendente; senão erro 42501) -> lógica (lista de quem tem marcação aberta com o que respondeu; abrir a conversa; marcar que o link foi enviado)
--   -> saída (jsonb; o código do link só sai para a equipe) | ROLLBACK: previsao-marcacao-rollback.sql
-- Versão 1.0 — 17/11/2026 / Mudança: primeira versão (botão "Previsão" no painel).

-- Contagens do topo da janela. Conta só quem tem marcação aberta agora, ou chegou sozinho, ou já tem conversa.
create or replace function public.painel_pmarc_resumo() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê a previsão.' using errcode = '42501'; end if;
  return (
    select jsonb_build_object(
      'ligado', public.pmarc_ligada(),
      'total', count(*), 'sem_celular', count(*) filter (where x.sem_cel),
      'link_enviado', count(*) filter (where x.link_enviado_em is not null),
      'abriram', count(*) filter (where x.primeiro_acesso_em is not null),
      'responderam', count(*) filter (where x.resposta is not null),
      'nao_sei', count(*) filter (where x.resposta = 'nao_sei'),
      'com_conversa', count(*) filter (where x.conversa_id is not null))
    from (
      select p.*, (public.pmarc_telefone(p.celular) is null and public.pmarc_telefone(p.telefone) is null and public.pmarc_telefone(p.informado ->> 'celular') is null) as sem_cel
      from public.pmarc_pessoa p
      where p.origem = 'espontaneo' or p.conversa_id is not null
         or exists (select 1 from public.jornada_card c join public.jornada_exame e on e.card_id = c.id
                     where c.paciente_chave = p.chave and e.status in ('agendado', 'confirmado') and e.agendado_para >= now() - interval '3 hours')
    ) x);
end $$;

-- A lista. p_filtro: todos | sem_link | sem_resposta | respondeu | nao_sei | conversa. Mais urgente primeiro (a marcação que chega antes).
create or replace function public.painel_pmarc_lista(p_filtro text default 'todos', p_busca text default null, p_limite integer default 50, p_pular integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_busca text := nullif(btrim(coalesce(p_busca, '')), ''); v_dig text := regexp_replace(coalesce(p_busca, ''), '\D', '', 'g');
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê a previsão.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(q.l_json order by q.proximo_em nulls last, q.nome)
    from (
      select jsonb_build_object(
        'id', x.id, 'codigo', x.codigo,
        'nome', coalesce(nullif(btrim(x.informado ->> 'nome'), ''), nullif(btrim(x.nome), ''), '(sem nome)'),
        'celular', coalesce(public.pmarc_telefone(x.informado ->> 'celular'), public.pmarc_telefone(x.celular), public.pmarc_telefone(x.telefone)),
        'email', coalesce(nullif(btrim(x.informado ->> 'email'), ''), x.email),
        'nascimento', x.nascimento, 'tem_cpf', x.tem_cpf, 'cpf_informado', coalesce(x.informado ->> 'cpf', '') <> '',
        'primeira_vez', x.primeira_vez, 'origem', x.origem,
        'resposta', x.resposta, 'respondeu_em', x.respondeu_em, 'primeiro_acesso_em', x.primeiro_acesso_em, 'ultimo_acesso_em', x.ultimo_acesso_em,
        'link_enviado_em', x.link_enviado_em, 'conversa_id', x.conversa_id,
        'observacao', x.informado ->> 'observacao',
        'revisar', coalesce((x.informado ->> 'email_revisar')::boolean, false) or coalesce((x.informado ->> 'cpf_revisar')::boolean, false)
                   or coalesce((x.informado ->> 'celular_revisar')::boolean, false) or coalesce((x.informado ->> 'nascimento_revisar')::boolean, false),
        'n_itens', jsonb_array_length(it), 'itens', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(it) e limit 6) q),
        'proximo_em', (it -> 0 ->> 'quando')) as l_json,
        (it -> 0 ->> 'quando')::timestamptz as proximo_em, coalesce(nullif(btrim(x.informado ->> 'nome'), ''), x.nome, '') as nome
      from public.pmarc_pessoa x
      cross join lateral (select public.pmarc_itens(x.chave) as it) i
      where (x.origem = 'espontaneo' or x.conversa_id is not null or jsonb_array_length(it) > 0)
        and case coalesce(p_filtro, 'todos')
              when 'sem_link' then x.link_enviado_em is null and x.primeiro_acesso_em is null
              when 'sem_resposta' then x.resposta is null
              when 'respondeu' then x.resposta is not null
              when 'nao_sei' then x.resposta = 'nao_sei'
              when 'conversa' then x.conversa_id is not null
              else true end
        and (v_busca is null
             or lower(coalesce(x.nome, '') || ' ' || coalesce(x.informado ->> 'nome', '')) like '%' || lower(v_busca) || '%'
             or (char_length(v_dig) >= 4 and (coalesce(x.celular, '') like '%' || v_dig || '%' or coalesce(x.telefone, '') like '%' || v_dig || '%' or coalesce(x.informado ->> 'celular', '') like '%' || v_dig || '%'
                                              or x.chave = v_dig)))
      order by 2 nulls last, 3
      limit greatest(1, least(coalesce(p_limite, 50), 200)) offset greatest(0, coalesce(p_pular, 0))
    ) q
  ), '[]'::jsonb);
end $$;

-- Abrir (ou criar) a conversa da pessoa. A atendente que abre fica com ela; o paciente ainda não escreveu, então ninguém está "esperando".
create or replace function public.painel_pmarc_conversa(p_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_conv uuid;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe abre a conversa.' using errcode = '42501'; end if;
  if not exists (select 1 from public.pmarc_pessoa where id = p_id) then raise exception 'Pessoa não encontrada.' using errcode = 'P0002'; end if;
  v_conv := public.pmarc_conversa_garantir(p_id, (select auth.uid()));
  if v_conv is null then raise exception 'Sem celular para abrir a conversa. Anote o celular com a pessoa por telefone.' using errcode = '22023'; end if;
  return v_conv;
end $$;

-- A atendente copiou/enviou o link (WhatsApp, e-mail ou à mão): fica marcado para não mandar duas vezes.
create or replace function public.painel_pmarc_link_enviado(p_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe marca o envio do link.' using errcode = '42501'; end if;
  update public.pmarc_pessoa set link_enviado_em = now(), link_enviado_por = (select auth.uid()), atualizado_em = now() where id = p_id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

do $$
declare f text;
begin
  foreach f in array array['painel_pmarc_resumo()', 'painel_pmarc_lista(text, text, integer, integer)', 'painel_pmarc_conversa(uuid)', 'painel_pmarc_link_enviado(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
