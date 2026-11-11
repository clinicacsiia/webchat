-- public.pessoa_conversas_de(p_nome text, p_fone text, p_email text, p_conta uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pessoa_conversas_de(p_nome text, p_fone text, p_email text, p_conta uuid)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$;

