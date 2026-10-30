-- Fase 4 antecipada: conferência de identidade de quem já é paciente. NÃO aplicado ainda no banco (aguardando confirmação do Supabase).
-- Regra (compara o que o paciente digitou ao iniciar o chat: nome, telefone e e-mail):
--   completo: todos os campos comparáveis batem (mínimo 2)  -> segue como paciente conhecido
--   parcial : 2 ou 3 batem, algum difere                    -> a IA pede para atualizar o que diferiu
--   novo    : menos de 2 batem, ou nada encontrado          -> segue como paciente novo; valida no próximo atendimento
-- Antes de reaproveitar qualquer dado do cadastro, a IA pede a data de nascimento; se não bater, trata como paciente novo.
-- Nenhum comando destrutivo neste arquivo (sem drop/delete/truncate).

create table if not exists public.pacientes (
  id uuid primary key default gen_random_uuid(),
  nome text not null, nome_norm text not null,
  telefones text[] not null default '{}',
  email text, dt_nasc date, cpf text,
  dados jsonb not null default '{}'::jsonb,
  validado boolean not null default false, validado_em timestamptz,
  revisar boolean not null default false,
  origem_conversa uuid references public.conversas(id) on delete set null,
  criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now(), ultima_visita_em timestamptz not null default now()
);
comment on table public.pacientes is 'Pacientes conhecidos (dados pessoais: CPF, mãe, endereço). validado = identidade conferida (data de nascimento batendo em novo atendimento) ou agendamento confirmado pelo atendente. revisar = CPF repetido ou dados divergentes. Só admin/atendente leem.';
create index if not exists pacientes_telefones on public.pacientes using gin (telefones);
create index if not exists pacientes_email on public.pacientes (lower(email));
create index if not exists pacientes_nome on public.pacientes (nome_norm);
create index if not exists pacientes_cpf on public.pacientes (cpf);
alter table public.pacientes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pacientes' and policyname = 'pacientes_select') then
    create policy pacientes_select on public.pacientes for select using ((select public.papel_atual()) = any (array['admin','atendente']));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pacientes' and policyname = 'pacientes_update') then
    create policy pacientes_update on public.pacientes for update using ((select public.papel_atual()) = any (array['admin','atendente'])) with check ((select public.papel_atual()) = any (array['admin','atendente']));
  end if;
end $$;

alter table public.pre_agendamentos add column if not exists paciente_id uuid references public.pacientes(id) on delete set null;
alter table public.pre_agendamentos add column if not exists identidade text check (identidade in ('nova','aguardando','conferida','atualizar','divergente'));

create or replace function public.norm_nome(t text) returns text language sql stable set search_path to '' as $$
  select nullif(btrim(regexp_replace(regexp_replace(upper(extensions.unaccent(coalesce(t, ''))), '[^A-Z ]', ' ', 'g'), '\s+', ' ', 'g')), '')
$$;

-- DDD + número sem o nono dígito e sem o 55: "5571988710544", "(71) 98871-0544" e "7188710544" dão a mesma chave.
create or replace function public.fone_chave(t text) returns text language sql immutable set search_path to '' as $$
  select case when d = '' then null
              when length(d) = 11 and substr(d, 3, 1) = '9' then substr(d, 1, 2) || substr(d, 4)
              else right(d, 10) end
  from (select case when length(regexp_replace(coalesce(t, ''), '\D', '', 'g')) >= 12 and left(regexp_replace(coalesce(t, ''), '\D', '', 'g'), 2) = '55'
                    then substr(regexp_replace(coalesce(t, ''), '\D', '', 'g'), 3) else regexp_replace(coalesce(t, ''), '\D', '', 'g') end) q(d)
$$;

create or replace function public.data_ou_nula(t text) returns date language plpgsql immutable set search_path to '' as $$
begin
  if t is null or t !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return t::date;
exception when others then return null;
end $$;

-- Mesmo nome, ou o nome mais curto contido no mais longo com pelo menos 2 palavras ("Alisson Cruz" = "Alisson Oliveira da Cruz").
create or replace function public.nome_confere(a text, b text) returns boolean language sql stable set search_path to '' as $$
  select case
    when x.na is null or x.nb is null then false
    when x.na = x.nb then true
    else coalesce((
      select count(*) >= 2 and bool_and(t = any(string_to_array(case when length(x.na) <= length(x.nb) then x.nb else x.na end, ' ')))
      from unnest(string_to_array(case when length(x.na) <= length(x.nb) then x.na else x.nb end, ' ')) t where length(t) > 2), false)
  end
  from (select public.norm_nome(a) na, public.norm_nome(b) nb) x
$$;

create or replace function public.paciente_conferir(p_conversa uuid) returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_ct record; b record; v_dt text; v_conf boolean; v_t int; v_m int; v_sit text;
begin
  select ct.nome, ct.telefone, nullif(btrim(ct.email), '') as email into v_ct
  from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
  if not found then return jsonb_build_object('situacao', 'novo'); end if;

  select q.* into b from (
    select p.id, p.validado, p.dt_nasc, p.ultima_visita_em, p.atualizado_em,
           public.nome_confere(v_ct.nome, p.nome) as n_ok,
           coalesce(public.fone_chave(v_ct.telefone) = any(p.telefones), false) as t_ok,
           (v_ct.email is not null and p.email is not null and lower(v_ct.email) = lower(p.email)) as e_ok,
           (v_ct.email is not null and p.email is not null) as e_cmp
    from public.pacientes p
    where p.origem_conversa is distinct from p_conversa
      and (public.fone_chave(v_ct.telefone) = any(p.telefones) or public.nome_confere(v_ct.nome, p.nome)
           or (v_ct.email is not null and lower(v_ct.email) = lower(p.email)))) q
  order by (q.n_ok::int + q.t_ok::int + q.e_ok::int) desc, q.atualizado_em desc limit 1;
  if not found then return jsonb_build_object('situacao', 'novo'); end if;

  v_t := 2 + b.e_cmp::int;
  v_m := b.n_ok::int + b.t_ok::int + b.e_ok::int;
  v_sit := case when v_m = v_t then 'completo' when v_m >= 2 then 'parcial' else 'novo' end;
  if v_sit = 'novo' then return jsonb_build_object('situacao', 'novo'); end if;

  select paciente ->> 'dt_nasc' into v_dt from public.pre_agendamentos where conversa_id = p_conversa;
  v_conf := case when public.data_ou_nula(v_dt) is not null and b.dt_nasc is not null then public.data_ou_nula(v_dt) = b.dt_nasc else null end;
  return jsonb_build_object('situacao', v_sit, 'paciente_id', b.id,
    'batem', to_jsonb(array_remove(array[case when b.n_ok then 'nome' end, case when b.t_ok then 'telefone' end, case when b.e_ok then 'email' end], null)),
    'diferem', to_jsonb(array_remove(array[case when not b.n_ok then 'nome' end, case when not b.t_ok then 'telefone' end, case when b.e_cmp and not b.e_ok then 'email' end], null)),
    'validado', b.validado, 'dt_nasc_conferida', v_conf, 'ultima_visita_em', b.ultima_visita_em::date);
end $$;
revoke all on function public.paciente_conferir(uuid) from public, anon, authenticated;
grant execute on function public.paciente_conferir(uuid) to service_role;

-- Quando a atendente confirma o agendamento no Klingo, o cadastro do paciente passa a validado.
create or replace function public.pre_agendamento_valida_paciente_trg() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.status = 'agendado' and old.status is distinct from 'agendado' and new.paciente_id is not null then
    update public.pacientes set validado = true, validado_em = coalesce(validado_em, now()), atualizado_em = now() where id = new.paciente_id;
  end if;
  return new;
end $$;
create or replace trigger pre_agendamento_valida_paciente after update on public.pre_agendamentos
  for each row execute function public.pre_agendamento_valida_paciente_trg();

-- ia_contexto passa a devolver "paciente_conhecido" (situação e quais campos batem/diferem; nunca os valores guardados).
do $$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.ia_contexto(text,uuid)'::regprocedure);
  d2 := replace(d, '''pre_agendamento'', (select to_jsonb(pa) - ''id'' - ''conversa_id'' - ''criado_em'' - ''atualizado_em'' - ''klingo_paciente_id''',
                   '''paciente_conhecido'', (public.paciente_conferir(c.id) - ''paciente_id''),' || E'\n    ' ||
                   '''pre_agendamento'', (select to_jsonb(pa) - ''id'' - ''conversa_id'' - ''criado_em'' - ''atualizado_em'' - ''klingo_paciente_id'' - ''paciente_id''');
  if d2 = d then raise exception 'ia_contexto: substituição não aplicada; nada foi alterado.'; end if;
  execute d2;
end $$;

-- ia_pre_agendar: depois de gravar, confere a identidade; se a data de nascimento bater, reaproveita o cadastro (o que o paciente
-- acabou de digitar sempre vence); ao ficar "pronto", grava/atualiza o paciente conhecido.
do $$
declare d text; d2 text; bloco text;
begin
  d := pg_get_functiondef('public.ia_pre_agendar(text,uuid,jsonb,boolean)'::regprocedure);
  bloco := $b$
  -- Identidade: compara o que o paciente digitou ao iniciar o chat com o cadastro já conhecido.
  v_conf := public.paciente_conferir(p_conversa);
  v_pid := nullif(v_conf ->> 'paciente_id', '')::uuid;
  v_ident := case
    when v_pid is null then 'nova'
    when (v_conf ->> 'dt_nasc_conferida') = 'true' and v_conf ->> 'situacao' = 'parcial' then 'atualizar'
    when (v_conf ->> 'dt_nasc_conferida') = 'true' then 'conferida'
    when (v_conf ->> 'dt_nasc_conferida') = 'false' then 'divergente'
    else 'aguardando' end;
  if v_ident in ('conferida', 'atualizar') then
    update public.pre_agendamentos x set
      paciente = coalesce((select jsonb_object_agg(e.key, e.value) from public.pacientes p, jsonb_each(p.dados) e
                           where p.id = v_pid and e.key = any(array['nome_social','sexo','dt_nasc','mae','cpf','rg','cns','celular','telefone','email',
                             'cep','endereco','numero','complemento','bairro','cidade','uf'])), '{}'::jsonb) || x.paciente,
      paciente_id = v_pid, identidade = v_ident
    where x.conversa_id = p_conversa;
  else
    update public.pre_agendamentos x set identidade = v_ident,
      paciente_id = case when v_ident in ('nova', 'divergente') then null else x.paciente_id end
    where x.conversa_id = p_conversa;
  end if;

  select * into r from public.pre_agendamentos where conversa_id = p_conversa;
  if r.status in ('pronto', 'agendado') then
    select ct.nome, ct.telefone into v_ct from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
    v_p := r.paciente;
    if r.paciente_id is not null then
      update public.pacientes set
        nome = coalesce(nullif(v_p ->> 'nome', ''), nome), nome_norm = public.norm_nome(coalesce(nullif(v_p ->> 'nome', ''), nome)),
        telefones = (select coalesce(array_agg(distinct t), '{}') from unnest(telefones || array[public.fone_chave(v_p ->> 'celular'), public.fone_chave(v_p ->> 'telefone'), public.fone_chave(v_ct.telefone)]) t where t is not null),
        email = coalesce(nullif(v_p ->> 'email', ''), email), dt_nasc = coalesce(public.data_ou_nula(v_p ->> 'dt_nasc'), dt_nasc),
        cpf = coalesce(nullif(v_p ->> 'cpf', ''), cpf), dados = dados || (v_p - 'matricula' - 'validade'),
        validado = true, validado_em = coalesce(validado_em, now()), ultima_visita_em = now(), atualizado_em = now()
      where id = r.paciente_id;
    else
      insert into public.pacientes (nome, nome_norm, telefones, email, dt_nasc, cpf, dados, validado, revisar, origem_conversa)
      values (coalesce(nullif(v_p ->> 'nome', ''), v_ct.nome), public.norm_nome(coalesce(nullif(v_p ->> 'nome', ''), v_ct.nome)),
        array_remove(array[public.fone_chave(v_p ->> 'celular'), public.fone_chave(v_p ->> 'telefone'), public.fone_chave(v_ct.telefone)], null),
        nullif(v_p ->> 'email', ''), public.data_ou_nula(v_p ->> 'dt_nasc'), nullif(v_p ->> 'cpf', ''), v_p - 'matricula' - 'validade', false,
        v_ident = 'divergente' or (nullif(v_p ->> 'cpf', '') is not null and exists (select 1 from public.pacientes o where o.cpf = v_p ->> 'cpf')),
        p_conversa)
      returning id into v_pid;
      update public.pre_agendamentos set paciente_id = v_pid where conversa_id = p_conversa;
    end if;
  end if;

  return jsonb_build_object('salvo', true, 'status', r.status, 'identidade', v_ident);$b$;
  d2 := replace(d, E'  return jsonb_build_object(''salvo'', true, ''status'', r.status);', bloco);
  d2 := replace(d2, E'  r public.pre_agendamentos;\nbegin', E'  r public.pre_agendamentos;\n  v_conf jsonb; v_pid uuid; v_ident text; v_p jsonb; v_ct record;\nbegin');
  if d2 = d or position('v_conf jsonb' in d2) = 0 or position('paciente_conferir' in d2) = 0 then
    raise exception 'ia_pre_agendar: substituição não aplicada por completo; nada foi alterado.';
  end if;
  execute d2;
end $$;
