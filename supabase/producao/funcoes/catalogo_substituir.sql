-- public.catalogo_substituir(p_tipo text, p_linhas jsonb, p_anexar boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.catalogo_substituir(p_tipo text, p_linhas jsonb, p_anexar boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n integer;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' or jsonb_array_length(p_linhas) = 0 then
    raise exception 'Catálogo vazio: nada foi alterado.';
  end if;
  if p_tipo = 'procedimento' then
    if not p_anexar then delete from public.catalogo_procedimento where true; end if;
    insert into public.catalogo_procedimento (id, nome, tuss, especialidade, classe, idade_min, idade_max, sexo, preparo, busca)
    select x.id, x.nome, x.tuss, x.especialidade, x.classe, x.idade_min, x.idade_max, x.sexo, x.preparo,
           to_tsvector('portuguese', extensions.unaccent(coalesce(x.nome,'') || ' ' || coalesce(x.especialidade,'') || ' ' || coalesce(x.classe,'')))
    from jsonb_to_recordset(p_linhas) as x(id int, nome text, tuss text, especialidade text, classe text, idade_min int, idade_max int, sexo text, preparo text)
    on conflict (id) do nothing;
    select count(*) into n from public.catalogo_procedimento;
  elsif p_tipo = 'agenda' then
    if not p_anexar then delete from public.catalogo_agenda where true; end if;
    insert into public.catalogo_agenda (unidade, local, profissional_id, profissional, especialidade, procedimento_id, procedimento, dia_num, dia, hora_ini, hora_fim, duracao_min, operadoras, tele, vagas_extras, vig_ini, vig_fim)
    select x.unidade, x.local, x.profissional_id, x.profissional, x.especialidade, x.procedimento_id, x.procedimento, x.dia_num, x.dia, x.hora_ini, x.hora_fim, x.duracao_min, x.operadoras, x.tele, x.vagas_extras, x.vig_ini, x.vig_fim
    from jsonb_to_recordset(p_linhas) as x(unidade text, local text, profissional_id int, profissional text, especialidade text, procedimento_id int, procedimento text, dia_num int, dia text, hora_ini text, hora_fim text, duracao_min int, operadoras text, tele boolean, vagas_extras int, vig_ini date, vig_fim date);
    select count(*) into n from public.catalogo_agenda;
  elsif p_tipo = 'plano' then
    if not p_anexar then delete from public.catalogo_plano where true; end if;
    insert into public.catalogo_plano (operadora, plano, produto, busca)
    select x.operadora, x.plano, x.produto, to_tsvector('simple', extensions.unaccent(coalesce(x.operadora,'') || ' ' || coalesce(x.plano,'')))
    from jsonb_to_recordset(p_linhas) as x(operadora text, plano text, produto text);
    select count(*) into n from public.catalogo_plano;
  else
    raise exception 'Tipo desconhecido: %', p_tipo;
  end if;
  insert into public.catalogo_meta (tipo, linhas, atualizado_em) values (p_tipo, n, now())
    on conflict (tipo) do update set linhas = excluded.linhas, atualizado_em = excluded.atualizado_em;
  return n;
end $function$;

