-- FLUXOGRAMA: entrada (paciente logado abre o chat; JWT do Supabase Auth; itens {id, token} das conversas guardadas neste aparelho) -> validação (só conta de paciente; a conversa só é adotada com o TOKEN dela e quando o e-mail ou o telefone da conversa é o da conta; nunca toma conversa que já tem dona) -> lógica (adotar grava conversas.conta_id; listar devolve as conversas da conta, com o token, em qualquer aparelho) -> saída (conta_paciente_adotar_conversas devolve quantas entraram na conta; conta_paciente_conversas devolve a lista para "Conversas anteriores")
-- Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
--
-- DEPENDE de supabase/contas-paciente.sql, login-paciente.sql (conversas.conta_id) e pacientes.sql (fone_chave).
--
-- POR QUE: "Conversas anteriores" do chat só lia o armazenamento do aparelho (apagado em "Sair" e inexistente em outro celular), e as conversas feitas
-- ANTES de entrar na conta nunca eram da conta. Agora, quem está logado vê as conversas da conta em qualquer aparelho, e as conversas deste aparelho
-- (que o aparelho prova ter pelo token) entram na conta quando o e-mail ou o telefone da conversa é o da conta (aparelho compartilhado não passa conversa de outra pessoa).
-- ROLLBACK: drop function public.conta_paciente_conversas(), public.conta_paciente_adotar_conversas(jsonb); (conversas.conta_id já gravado pode ficar).
-- Nenhum comando destrutivo neste arquivo. Pode ser aplicado mais de uma vez.

create or replace function public.conta_paciente_conversas() returns jsonb
language sql stable security definer set search_path to '' as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'token', s.token, 'criado_em', (extract(epoch from c.criado_em) * 1000)::bigint,
      'tipo', coalesce(c.paciente_tipo, 'proprio'), 'nomeCrianca', case when c.paciente_tipo = 'filho' then coalesce(c.paciente_nome, '') else '' end,
      'ultima', left(coalesce(c.ultima_mensagem, ''), 120)) order by c.criado_em desc)
    from (select x.* from public.conversas x where x.conta_id = (select auth.uid()) order by x.criado_em desc limit 30) c
    join public.conversa_segredo s on s.conversa_id = c.id
    where exists (select 1 from public.contas_paciente cp where cp.id = (select auth.uid()))), '[]'::jsonb)
$$;

create or replace function public.conta_paciente_adotar_conversas(p_itens jsonb) returns int
language plpgsql security definer set search_path to '' as $$
declare v_uid uuid := (select auth.uid()); v_cp record; v_email text; v_tel text; v_n int := 0; it jsonb; v_id uuid;
begin
  select * into v_cp from public.contas_paciente where id = v_uid;
  if v_uid is null or not found then raise exception 'Entre na sua conta para guardar as conversas.' using errcode = '42501'; end if;
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' then return 0; end if;
  select lower(btrim(u.email)), public.fone_chave(coalesce(nullif(btrim(v_cp.telefone), ''), u.raw_user_meta_data ->> 'telefone')) into v_email, v_tel from auth.users u where u.id = v_uid;
  for it in select * from jsonb_array_elements(p_itens) limit 30 loop
    begin v_id := (it ->> 'id')::uuid; exception when others then continue; end;
    update public.conversas c set conta_id = v_uid
      from public.conversa_segredo s, public.contatos ct
     where c.id = v_id and s.conversa_id = c.id and s.token = (it ->> 'token') and ct.id = c.contato_id and c.conta_id is null
       and ((v_email is not null and v_email <> '' and (lower(btrim(coalesce(c.email_informado, ''))) = v_email or lower(btrim(coalesce(ct.email, ''))) = v_email))
            or (v_tel is not null and public.fone_chave(ct.telefone) = v_tel));
    if found then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $$;
revoke all on function public.conta_paciente_conversas(), public.conta_paciente_adotar_conversas(jsonb) from public, anon;
grant execute on function public.conta_paciente_conversas(), public.conta_paciente_adotar_conversas(jsonb) to authenticated;
