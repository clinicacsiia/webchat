-- public.pmarc_enriquecer_lote(p_linhas jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_enriquecer_lote(p_linhas jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_lidas integer; v_ach integer; v_alt integer;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ligada', false, 'lidas', 0); end if;
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then raise exception 'O lote precisa ser uma lista.' using errcode = '22023'; end if;
  select count(*) into v_lidas from jsonb_array_elements(p_linhas);
  with linhas as (
    select c.paciente_chave as chave, public.pmarc_telefone(l.x ->> 'c') as celular, public.pmarc_telefone(l.x ->> 't') as telefone,
           case when lower(btrim(coalesce(l.x ->> 'e', ''))) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(l.x ->> 'e') <= 200 then lower(btrim(l.x ->> 'e')) end as email,
           case when coalesce(l.x ->> 'd', '') ~ '^\d{4}-\d{2}-\d{2}$' and (l.x ->> 'd')::date between date '1900-01-01' and current_date then (l.x ->> 'd')::date end as nascimento,
           coalesce((l.x ->> 'k')::boolean, false) as tem_cpf
    from jsonb_array_elements(p_linhas) l(x)
    join public.jornada_exame e on e.marcacao_id = 'm' || btrim(l.x ->> 'm')
    join public.jornada_card c on c.id = e.card_id),
  s as (
    -- uma pessoa aparece em várias linhas (uma por marcação): junta o que cada linha trouxe
    select chave, max(celular) as celular, max(telefone) as telefone, max(email) as email, max(nascimento) as nascimento, bool_or(tem_cpf) as tem_cpf
    from linhas group by chave),
  u as (
    update public.pmarc_pessoa pp set
      celular = coalesce(pp.celular, s.celular), telefone = coalesce(pp.telefone, s.telefone), email = coalesce(pp.email, s.email),
      nascimento = coalesce(pp.nascimento, s.nascimento), tem_cpf = pp.tem_cpf or s.tem_cpf, atualizado_em = now()
    from s
    where pp.chave = s.chave
      and (pp.celular, pp.telefone, pp.email, pp.nascimento, pp.tem_cpf) is distinct from
          (coalesce(pp.celular, s.celular), coalesce(pp.telefone, s.telefone), coalesce(pp.email, s.email), coalesce(pp.nascimento, s.nascimento), pp.tem_cpf or s.tem_cpf)
    returning 1)
  select (select count(*) from s), (select count(*) from u) into v_ach, v_alt;
  return jsonb_build_object('ligada', true, 'lidas', v_lidas, 'achadas', v_ach, 'alteradas', v_alt);
end $function$;

