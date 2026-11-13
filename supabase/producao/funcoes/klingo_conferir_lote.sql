-- public.klingo_conferir_lote(p_linhas jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_conferir_lote(p_linhas jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_sal text := coalesce((select valor from public.config where chave = 'ia_segredo'), '');
  n integer := 0;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then
    raise exception 'O lote precisa ser uma lista.';
  end if;
  with
  l as materialized (
    select x ->> 'm' as m, (x ->> 'em')::date as em, public.data_ou_nula(x ->> 'para') as para,
           coalesce(nullif(btrim(x ->> 'o'), ''), 'sem_origem') as o, nullif(btrim(x ->> 's'), '') as s, x ->> 'u' as u, x ->> 'pl' as pl, nullif(btrim(x ->> 'n'), '') as n,
           nullif(x ->> 'fh', '') as fh, nullif(x ->> 'fh2', '') as fh2, public.data_ou_nula(x ->> 'nasc') as nasc,
           nullif(x ->> 'cpfh', '') as cpfh, nullif(x ->> 'emh', '') as emh,
           coalesce(array(select jsonb_array_elements_text(x -> 'vz')), '{}'::text[]) as vz
      from jsonb_array_elements(p_linhas) x
     where coalesce(x ->> 'm', '') ~ '^\d{1,12}$' and coalesce(x ->> 'em', '') ~ '^\d{4}-\d{2}-\d{2}$'),
  ch as materialized (
    select c.id, c.criado_em, coalesce(c.paciente_tipo, 'proprio') as tipo, public.pessoa_ficha(c.id) ->> 'nome' as nome,
           lower(nullif(btrim(coalesce(nullif(btrim(c.email_informado), ''), ct.email)), '')) as email_conv,
           case when length(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g')) >= 8
                then encode(sha256(convert_to(right(regexp_replace(ct.telefone, '\D', '', 'g'), 8) || v_sal, 'UTF8')), 'hex') end as fh_contato
      from public.conversas c join public.contatos ct on ct.id = c.contato_id
     where not c.teste),
  la as (
    select distinct on (l.m) l.m, pa.conversa_id, pa.paciente
      from l join public.pre_agendamentos pa on l.m = any (pa.klingo_marcacoes)
     order by l.m, pa.atualizado_em desc),
  lb as (
    select distinct on (l.m) l.m, ch.id as conversa_id
      from l join ch on ch.fh_contato is not null and ch.fh_contato in (coalesce(l.fh, '-'), coalesce(l.fh2, '-'))
     where not exists (select 1 from la where la.m = l.m)
       and public.nome_confere(l.n, ch.nome)
       and (ch.criado_em at time zone 'America/Sao_Paulo')::date <= l.em
     order by l.m, ch.criado_em desc),
  lk as (
    select la.m, la.conversa_id, 'pedido'::text as ligacao, la.paciente as pac from la
    union all
    select lb.m, lb.conversa_id, 'telefone_nome',
           coalesce((select p.paciente from public.pre_agendamentos p where p.conversa_id = lb.conversa_id order by p.atualizado_em desc limit 1), '{}'::jsonb) from lb),
  base as (
    select l.*, lk.conversa_id, lk.ligacao, coalesce(c.tipo, 'proprio') as tipo, lk.pac, c.nome as cnome_ficha, c.email_conv, c.fh_contato,
           case when lk.conversa_id is not null then (lk.pac ->> 'nome') end as cnome_pac,
           public.data_ou_nula(lk.pac ->> 'dt_nasc') as cnasc,
           case when length(regexp_replace(coalesce(lk.pac ->> 'cpf', ''), '\D', '', 'g')) = 11
                then encode(sha256(convert_to(regexp_replace(lk.pac ->> 'cpf', '\D', '', 'g') || v_sal, 'UTF8')), 'hex') end as ccpfh,
           lower(nullif(btrim(coalesce(nullif(btrim(lk.pac ->> 'email'), ''), c.email_conv)), '')) as cemail,
           array_remove(array[
             case when length(regexp_replace(coalesce(lk.pac ->> 'celular', ''), '\D', '', 'g')) >= 8
                  then encode(sha256(convert_to(right(regexp_replace(lk.pac ->> 'celular', '\D', '', 'g'), 8) || v_sal, 'UTF8')), 'hex') end,
             case when length(regexp_replace(coalesce(lk.pac ->> 'telefone', ''), '\D', '', 'g')) >= 8
                  then encode(sha256(convert_to(right(regexp_replace(lk.pac ->> 'telefone', '\D', '', 'g'), 8) || v_sal, 'UTF8')), 'hex') end,
             c.fh_contato], null) as ccel
      from l left join lk on lk.m = l.m left join ch c on c.id = lk.conversa_id),
  r as (
    select b.*,
           (b.tipo = 'filho') as filho,
           case when b.conversa_id is null then null
                when b.n is null or (b.cnome_pac is null and b.cnome_ficha is null) then 'sem_dado'
                when public.nome_confere(b.n, b.cnome_pac) or public.nome_confere(b.n, b.cnome_ficha) then 'igual' else 'diferente' end as r_nome,
           case when b.conversa_id is null then null when b.nasc is null or b.cnasc is null then 'sem_dado' when b.nasc = b.cnasc then 'igual' else 'diferente' end as r_nasc,
           case when b.conversa_id is null then null when b.cpfh is null or b.ccpfh is null then 'sem_dado' when b.cpfh = b.ccpfh then 'igual' else 'diferente' end as r_cpf,
           case when b.conversa_id is null then null when (b.fh is null and b.fh2 is null) or cardinality(b.ccel) = 0 then 'sem_dado'
                when (b.fh is not null and b.fh = any (b.ccel)) or (b.fh2 is not null and b.fh2 = any (b.ccel)) then 'igual' else 'diferente' end as r_cel,
           case when b.conversa_id is null then null when b.emh is null or b.cemail is null then 'sem_dado'
                when b.emh = encode(sha256(convert_to(b.cemail || v_sal, 'UTF8')), 'hex') then 'igual' else 'diferente' end as r_mail
      from base b)
  insert into public.klingo_conferencia as k (m, marcado_em, exame_em, origem, status_klingo, unidade, plano, conversa_id, ligacao, paciente_tipo, conflito, responsavel_diferente, falta_no_klingo, vazios, lido_em)
  select r.m, r.em, r.para, r.o, r.s, public.unidade_chave(r.u), case when coalesce(r.pl, '') ilike '%partic%' then 'particular' else 'convenio' end,
         r.conversa_id, r.ligacao, case when r.conversa_id is not null then r.tipo end,
         array_remove(array[case when r.r_nome = 'diferente' then 'nome' end, case when r.r_nasc = 'diferente' then 'nascimento' end,
                            case when not r.filho and r.r_cpf = 'diferente' then 'cpf' end, case when not r.filho and r.r_cel = 'diferente' then 'celular' end,
                            case when not r.filho and r.r_mail = 'diferente' then 'email' end]::text[], null),
         array_remove(array[case when r.filho and r.r_cpf = 'diferente' then 'cpf' end, case when r.filho and r.r_cel = 'diferente' then 'celular' end,
                            case when r.filho and r.r_mail = 'diferente' then 'email' end]::text[], null),
         case when r.conversa_id is null or r.filho then '{}'::text[] else array_remove(array[
              case when 'celular' = any (r.vz) and cardinality(r.ccel) > 0 then 'celular' end,
              case when 'email' = any (r.vz) and r.cemail is not null then 'email' end,
              case when 'cpf' = any (r.vz) and r.ccpfh is not null then 'cpf' end]::text[], null) end,
         r.vz, now()
    from r
  on conflict (m) do update set marcado_em = excluded.marcado_em, exame_em = excluded.exame_em, origem = excluded.origem, status_klingo = excluded.status_klingo,
      unidade = excluded.unidade, plano = excluded.plano, conversa_id = excluded.conversa_id, ligacao = excluded.ligacao, paciente_tipo = excluded.paciente_tipo,
      conflito = excluded.conflito, responsavel_diferente = excluded.responsavel_diferente, falta_no_klingo = excluded.falta_no_klingo, vazios = excluded.vazios, lido_em = now();
  get diagnostics n = row_count;
  return jsonb_build_object('lidas', n, 'recebidas', jsonb_array_length(p_linhas));
end $function$;

