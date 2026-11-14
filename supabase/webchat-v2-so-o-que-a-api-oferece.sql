-- FLUXOGRAMA: o paciente chega ao passo "tipo de consulta"/"exame" (CPF e nascimento já informados)
--   -> validação (config klingo_so_liberados = sim) -> lógica (klingo_liberado deixa passar só o que a API do Klingo oferece
--   E que vale para ESTE paciente: idade/sexo do procedimento e idade aceita por algum médico da especialidade) -> saída (lista do chat).
-- Versão 2.1 — 14/11/2026. Motivo: a reestruturação v2 (webchat-v2-parte1-modos.sql) trocou klingo_liberado por "select true" e o chat voltou a
--   oferecer o que a API não tem; o dono pediu "mostrar só o que a API disponibiliza". Também aplica as regras de idade que causavam o 403 do Klingo
--   (ex.: Pediatria, procedimento 1132, idade_max 17, oferecida a adulto).
-- Regras usadas (todas já no banco): klingo_especialidade.liberada_api (via klingo_automatizavel); catalogo_procedimento.idade_min/idade_max/sexo;
--   klingo_profissional.idade_max (por CBOS). Sem nascimento/sexo informado, a regra correspondente não filtra.
-- ROLLBACK: update public.config set valor = 'nao' where chave = 'klingo_so_liberados';   (volta a oferecer tudo, na hora)
create or replace function public.klingo_liberado(p_conversa uuid, p_proc integer, p_tipo text) returns boolean
  language plpgsql stable security definer set search_path to ''
as $function$
declare d jsonb; v_nasc date; v_idade integer; v_sexo text; pr record; v_cbos text;
begin
  if public.klingo_cfg('klingo_so_liberados', 'nao') <> 'sim' then return true; end if;
  if p_proc is null or not public.klingo_automatizavel(p_proc, p_tipo) then return false; end if;
  d := public.klingo_dados_conversa(p_conversa);
  v_nasc := nullif(d ->> 'nascimento', '')::date;
  v_idade := case when v_nasc is null then null else extract(year from age((now() at time zone 'America/Bahia')::date, v_nasc))::integer end;
  v_sexo := upper(left(coalesce(d ->> 'sexo', ''), 1));
  select idade_min, idade_max, sexo into pr from public.catalogo_procedimento where id = p_proc;
  if v_idade is not null and (v_idade < coalesce(pr.idade_min, 0) or v_idade > coalesce(pr.idade_max, 999)) then return false; end if;
  if coalesce(pr.sexo, '') <> '' and v_sexo in ('M', 'F') and upper(left(pr.sexo, 1)) <> v_sexo then return false; end if;
  if p_tipo = 'consulta' and v_idade is not null then
    select e.cbos into v_cbos from public.klingo_especialidade e where e.liberada_api and p_proc = any (e.procedimentos) limit 1;
    if v_cbos is not null and exists (select 1 from public.klingo_profissional m where v_cbos = any (m.cbos))
       and not exists (select 1 from public.klingo_profissional m where v_cbos = any (m.cbos) and (m.idade_max is null or m.idade_max >= v_idade)) then
      return false;
    end if;
  end if;
  return true;
end $function$;
update public.config set valor = 'sim' where chave = 'klingo_so_liberados';
