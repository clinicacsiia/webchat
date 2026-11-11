-- public.jornada_conversa_do_card(p_card bigint)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_conversa_do_card(p_card bigint)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.jornada_card%rowtype;
  v_fone text;
  v_sal text;
  v_id uuid;
begin
  if auth.uid() is null or not public.jornada_pode() then return null; end if;
  select * into c from public.jornada_card where id = p_card;
  if not found then return null; end if;
  if c.conversa_id is not null then return c.conversa_id; end if;
  select fone_chave into v_fone from public.jornada_paciente where prontuario = c.paciente_chave;
  if v_fone is null then return null; end if;
  select valor into v_sal from public.config where chave = 'ia_segredo';
  select cv.id into v_id
  from public.conversas cv join public.contatos ct on ct.id = cv.contato_id
  where encode(sha256(convert_to(right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) || coalesce(v_sal, ''), 'UTF8')), 'hex') = v_fone
  order by cv.criado_em desc limit 1;
  return v_id;
end;
$function$;

