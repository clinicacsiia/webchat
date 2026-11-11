-- Consultas oferecidas no chat: a equipe escolhe, em Configurações, quais consultas aparecem para o paciente e com que nome.
-- Caso de origem: "Consulta Com Pediatra (Neuro Desenvolvimento)" (id 2128) se confundia com "Consulta Neuropediatria" (id 1472).
-- Aplicado em 3 partes (a ferramenta de migração expira em 60 s). Idempotente.

-- ===== Parte 1: tabela =====
create table if not exists public.consulta_config (
  procedimento_id integer primary key,      -- catalogo_procedimento.id
  oculta boolean not null default false,    -- true: não aparece no chat
  rotulo text,                              -- nome que o paciente vê (vazio = nome automático)
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid
);
alter table public.consulta_config enable row level security;
comment on table public.consulta_config is 'Ajustes por consulta: esconder do chat e/ou renomear. Sem policy: só as funções security definer acessam.';

-- ===== Parte 2: a lista de consultas do chat respeita os ajustes =====
-- Mesma função de agenda-medica-bloqueio.sql, com: consulta oculta some; rótulo personalizado vence o automático.
create or replace function public.consultas_da_unidade(p_catalogo text)
returns table (id integer, rotulo text, profissionais integer, medicos text[])
language sql stable security definer set search_path to '' as $$
  with base as (
    select p.id, p.nome, string_agg(distinct initcap(lower(a.especialidade)), ' / ') as esp, array_agg(distinct a.profissional) as meds
    from public.catalogo_procedimento p join public.catalogo_agenda a on a.procedimento_id = p.id
    where p.ativo and p.classe = 'CONSULTAS' and a.vig_fim >= current_date
      and a.profissional !~* '(teste|^eletro)' and not public.profissional_bloqueado(a.profissional) and coalesce(a.especialidade, '') !~* 'anestesi'
      and (p_catalogo is null or a.unidade = p_catalogo)
      and not exists (select 1 from public.consulta_config cc where cc.procedimento_id = p.id and cc.oculta)
    group by p.id, p.nome),
  rot as (
    select b.*, (b.nome ~* '^consulta( medica| médica)?$') as generica,
      coalesce(nullif(btrim((select cc.rotulo from public.consulta_config cc where cc.procedimento_id = b.id)), ''), case
        when b.nome ~* '^consulta( medica| médica)?$' then 'Consulta de ' || coalesce(b.esp, 'clínica médica')
        when b.nome ~* 'teleconsulta' then 'Teleconsulta de ' || coalesce(b.esp, 'clínica médica')
        when b.nome ~* '^atendimento ambulatorial em ' then initcap(lower(regexp_replace(b.nome, '^atendimento ambulatorial em ', '', 'i')))
        else initcap(lower(b.nome)) end) as rotulo
    from base b)
  select distinct on (r.rotulo) r.id, r.rotulo, cardinality(r.meds), r.meds
  from rot r
  where not (r.generica and exists (select 1 from rot s where not s.generica and r.meds <@ s.meds))
  order by r.rotulo, cardinality(r.meds) desc, r.id;
$$;
revoke all on function public.consultas_da_unidade(text) from public, anon, authenticated;

-- ===== Parte 3: funções da tela de Configurações (só administrador) =====
create or replace function public.consultas_config_listar() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'nome_klingo', x.nome, 'rotulo_automatico', x.auto, 'rotulo', x.rotulo,
      'oculta', x.oculta, 'unidades', x.unidades, 'medicos', x.meds) order by x.oculta, x.auto)
    from (
      select p.id, p.nome,
        case when p.nome ~* '^consulta( medica| médica)?$' then 'Consulta de ' || coalesce(string_agg(distinct initcap(lower(a.especialidade)), ' / '), 'clínica médica')
             when p.nome ~* 'teleconsulta' then 'Teleconsulta de ' || coalesce(string_agg(distinct initcap(lower(a.especialidade)), ' / '), 'clínica médica')
             when p.nome ~* '^atendimento ambulatorial em ' then initcap(lower(regexp_replace(p.nome, '^atendimento ambulatorial em ', '', 'i')))
             else initcap(lower(p.nome)) end as auto,
        cc.rotulo, coalesce(cc.oculta, false) as oculta,
        array_agg(distinct a.unidade) as unidades, array_agg(distinct a.profissional) as meds
      from public.catalogo_procedimento p
      join public.catalogo_agenda a on a.procedimento_id = p.id
      left join public.consulta_config cc on cc.procedimento_id = p.id
      where p.ativo and p.classe = 'CONSULTAS' and a.vig_fim >= current_date
        and a.profissional !~* '(teste|^eletro)' and not public.profissional_bloqueado(a.profissional) and coalesce(a.especialidade, '') !~* 'anestesi'
      group by p.id, p.nome, cc.rotulo, cc.oculta) x), '[]'::jsonb);
end $$;
grant execute on function public.consultas_config_listar() to authenticated;

create or replace function public.consulta_config_salvar(p_id integer, p_oculta boolean, p_rotulo text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_rot text := nullif(btrim(coalesce(p_rotulo, '')), '');
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  if not exists (select 1 from public.catalogo_procedimento where id = p_id and classe = 'CONSULTAS') then raise exception 'Consulta não encontrada.' using errcode = '22023'; end if;
  if v_rot is not null and length(v_rot) > 80 then raise exception 'O nome da consulta pode ter até 80 letras.' using errcode = '22023'; end if;
  if not coalesce(p_oculta, false) and v_rot is null then
    delete from public.consulta_config where procedimento_id = p_id;      -- sem ajuste nenhum: volta ao padrão
  else
    insert into public.consulta_config (procedimento_id, oculta, rotulo, atualizado_por) values (p_id, coalesce(p_oculta, false), v_rot, (select auth.uid()))
    on conflict (procedimento_id) do update set oculta = excluded.oculta, rotulo = excluded.rotulo, atualizado_em = now(), atualizado_por = excluded.atualizado_por;
  end if;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.consulta_config_salvar(integer, boolean, text) to authenticated;
