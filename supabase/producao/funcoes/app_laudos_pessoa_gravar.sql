-- public.app_laudos_pessoa_gravar(p_pac uuid, p_pessoa text, p_situacao text, p_klingo_id text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_laudos_pessoa_gravar(p_pac uuid, p_pessoa text, p_situacao text, p_klingo_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p record;
begin
  if p_situacao not in ('confere', 'divergente', 'nao_encontrado', 'sem_cadastro', 'travado') then return; end if;
  select * into p from public.app_laudos_pessoas(p_pac) x where x.pessoa = p_pessoa;
  if not found or p.ih is null then return; end if;   -- pessoa removida ou sem CPF
  insert into public.app_laudo_pessoa as lp (paciente_id, pessoa, ident_hash, klingo_id, situacao, verificado_em)
  values (p_pac, p_pessoa, p.ih, case when p_situacao = 'confere' then p_klingo_id end, p_situacao, now())
  on conflict (paciente_id, pessoa) do update set
    klingo_id = case when excluded.situacao = 'confere' then excluded.klingo_id
                     when excluded.situacao = 'travado' and lp.ident_hash is not distinct from excluded.ident_hash then lp.klingo_id end,
    voucher_em = case when lp.ident_hash is not distinct from excluded.ident_hash and excluded.situacao in ('confere', 'travado') then lp.voucher_em end,
    ident_hash = excluded.ident_hash, situacao = excluded.situacao, verificado_em = now();
end $function$;

