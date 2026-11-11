-- public.fluxo_ler_data(p text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.fluxo_ler_data(p text)
 RETURNS date
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare t text := public.fluxo_norm(p); m text[]; d int; mm int; a int;
  meses text[] := array['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
begin
  if t ~ '^\d{4}-\d{2}-\d{2}$' then return t::date; end if;
  m := regexp_match(t, '(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{2,4})');
  if m is null then m := regexp_match(t, '^(\d{2})(\d{2})(\d{4})$'); end if;
  if m is null then
    m := regexp_match(t, '(\d{1,2}) de ([a-z]+) de (\d{4})');
    if m is not null then
      mm := array_position(meses, m[2]);
      if mm is null then return null; end if;
      m[2] := mm::text;
    end if;
  end if;
  if m is null then return null; end if;
  d := m[1]::int; mm := m[2]::int; a := m[3]::int;
  if a < 100 then a := case when a > extract(year from current_date)::int % 100 then 1900 + a else 2000 + a end; end if;
  if mm not between 1 and 12 or d not between 1 and 31 then return null; end if;
  begin return make_date(a, mm, d); exception when others then return null; end;
end $function$;

