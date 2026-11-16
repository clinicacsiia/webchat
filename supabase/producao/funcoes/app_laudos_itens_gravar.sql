-- public.app_laudos_itens_gravar(p_pac uuid, p_pessoa text, p_itens jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_laudos_itens_gravar(p_pac uuid, p_pessoa text, p_itens jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p record; e jsonb; v_id text;
begin
  select x.* into p from public.app_laudos_pessoas(p_pac) x
    join public.app_laudo_pessoa lp on lp.paciente_id = p_pac and lp.pessoa = x.pessoa and lp.ident_hash = x.ih and lp.situacao = 'confere'
   where x.pessoa = p_pessoa;
  if not found or jsonb_typeof(p_itens) <> 'array' then return false; end if;
  for e in select * from jsonb_array_elements(p_itens) limit 200 loop
    v_id := e ->> 'id';
    if v_id is null or v_id !~ '^[0-9]{1,12}$' then continue; end if;
    insert into public.app_laudo as l (paciente_id, marcacao_id, pessoa, ident_hash, procedimento, data_exame, unidade)
    values (p_pac, v_id, p_pessoa, p.ih, left(e ->> 'procedimento', 200), public.fluxo_ler_data(e ->> 'data'), left(e ->> 'unidade', 120))
    on conflict (paciente_id, marcacao_id) do update set
      estado = case when l.ident_hash is distinct from excluded.ident_hash then 'aguardando' else l.estado end,
      checado_em = case when l.ident_hash is distinct from excluded.ident_hash then null else l.checado_em end,
      disponivel_em = case when l.ident_hash is distinct from excluded.ident_hash then null else l.disponivel_em end,
      retirado_em = case when l.ident_hash is distinct from excluded.ident_hash then null else l.retirado_em end,
      pessoa = excluded.pessoa, ident_hash = excluded.ident_hash, procedimento = excluded.procedimento, data_exame = excluded.data_exame, unidade = excluded.unidade, atualizado_em = now();
  end loop;
  update public.app_laudo_pessoa set voucher_em = now() where paciente_id = p_pac and pessoa = p_pessoa;
  return true;
end $function$;

