-- public.painel_pmarc_lista(p_filtro text, p_busca text, p_limite integer, p_pular integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_pmarc_lista(p_filtro text DEFAULT 'todos'::text, p_busca text DEFAULT NULL::text, p_limite integer DEFAULT 50, p_pular integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;

