-- public.jornada_pessoas()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_pessoas()
 RETURNS TABLE(card_id bigint, pessoa text, conversa_id uuid, sugestao uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_sal text;
begin
  if auth.uid() is null or not public.jornada_pode() then return; end if;
  select valor into v_sal from public.config where chave = 'ia_segredo';
  return query
  with conv as (
    select cv.id, coalesce(g.grupo_id, cv.id) as gid, public.pessoa_ficha(cv.id) ->> 'nome' as nome, cv.atualizado_em,
           encode(sha256(convert_to(right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) || coalesce(v_sal, ''), 'UTF8')), 'hex') as fh
      from public.conversas cv join public.contatos ct on ct.id = cv.contato_id left join public.conversa_grupo g on g.conversa_id = cv.id
  ), rep as (
    select distinct on (gid) gid, id as rep_id from conv order by gid, atualizado_em desc
  ), kl as (
    select c.id as card_id, c.paciente_chave, c.data_ref, p.nome, p.fone_chave
      from public.jornada_card c join public.jornada_paciente p on p.prontuario = c.paciente_chave
     where c.arquivado_em is null and c.conversa_id is null and c.paciente_chave not like 'conv:%' and c.paciente_chave not like 'manual:%'
  ), lig as (
    select kl.card_id, kl.paciente_chave, conv.gid,
           exists (select 1 from public.pessoa_klingo_vinculo v where v.prontuario = kl.paciente_chave and v.conversa_id = conv.id) as confirmado,
           exists (select 1 from public.pre_agendamentos pa, jsonb_array_elements(case when jsonb_typeof(pa.escolha_horario) = 'array' then pa.escolha_horario else '[]'::jsonb end) e
                    where pa.conversa_id = conv.id and e ->> 'data' = kl.data_ref::text) as mesmo_dia
      from kl join conv on conv.fh = kl.fone_chave and public.nome_confere(kl.nome, conv.nome)
  ), melhor as (
    select distinct on (l.card_id) l.card_id, l.gid, (l.confirmado or l.mesmo_dia) as junta
      from lig l order by l.card_id, (l.confirmado or l.mesmo_dia) desc, l.gid
  )
  select c.id, 'g:' || coalesce(g.grupo_id, c.conversa_id)::text, r.rep_id, null::uuid
    from public.jornada_card c
    left join public.conversa_grupo g on g.conversa_id = c.conversa_id
    join rep r on r.gid = coalesce(g.grupo_id, c.conversa_id)
   where c.arquivado_em is null and c.conversa_id is not null
  union all
  select k.card_id, case when m.junta then 'g:' || m.gid::text else 'k:' || k.paciente_chave end, case when m.junta then r.rep_id end, case when m.card_id is not null and not m.junta then r.rep_id end
    from kl k left join melhor m on m.card_id = k.card_id left join rep r on r.gid = m.gid;
end $function$;

