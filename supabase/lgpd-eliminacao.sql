-- FLUXOGRAMA: entrada (administrador no painel informa telefone, CPF e/ou e-mail de quem pediu a eliminação, LGPD art. 18, VI)
--   -> validação (só admin; telefone com DDD, CPF com 11 números, e-mail válido; ao menos um dado) -> lógica (acha tudo da pessoa; SIMULA por padrão e só apaga com p_confirmar = true;
--   apaga conversas, mensagens, fotos, pedidos, acesso rápido, filhos, aparelhos, acessos, laudos, pré-cadastro da previsão, conta do chat e cadastro do chat)
--   -> persistência (public.lgpd_pedido: só contagens e códigos embaralhados, nunca o dado em claro) -> saída (o que foi apagado e o que a lei manda manter)
-- Versão 1.0 — 19/11/2026 / Mudança: primeira versão (decisão do dono: "apagar tudo conforme solicitação e conforme art. 18").
-- O que NÃO apaga (e a função devolve na resposta, para o atendente explicar ao titular): cadastro e agendamentos no Klingo (prontuário: obrigação legal, art. 16, I e Lei 13.787/2018),
--   a cópia da agenda (Jornada), que é refeita a partir do Klingo, indicadores já somados sem identificação e o próprio registro do pedido.
-- Reversão: drop function public.painel_lgpd_eliminar(text, text, text, boolean); drop function public.painel_lgpd_pedidos(); drop table public.lgpd_pedido;  (apagar dados NÃO tem volta)

create table if not exists public.lgpd_pedido (
  id uuid primary key default gen_random_uuid(),
  criado_em timestamptz not null default now(),
  tipo text not null default 'eliminacao' check (tipo = 'eliminacao'),
  ident_hash text[] not null default '{}',     -- códigos embaralhados (com sal do cofre) do que foi informado; nunca o dado em claro
  por uuid references public.agentes (id) on delete set null,
  resumo jsonb not null default '{}'::jsonb    -- só contagens por categoria
);
comment on table public.lgpd_pedido is 'Registro dos pedidos de eliminação de dados (LGPD art. 18). Guarda só contagens e códigos embaralhados: prova que o pedido foi atendido sem manter o dado.';
alter table public.lgpd_pedido enable row level security;
revoke all on public.lgpd_pedido from public, anon, authenticated;

create or replace function public.painel_lgpd_eliminar(p_telefone text default null, p_cpf text default null, p_email text default null, p_confirmar boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $f$
declare
  v_tel text := right(regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'), 11);
  v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g');
  v_mail text := lower(btrim(coalesce(p_email, '')));
  v_contatos uuid[]; v_conversas uuid[]; v_contas uuid[]; v_apps uuid[]; v_pmarc uuid[]; v_pac uuid[]; v_fila uuid[]; v_cod uuid[]; v_conf uuid[]; v_filhos uuid[];
  r jsonb := '{}'::jsonb;
  v_hash text[] := '{}';
  v_n int;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Só o administrador elimina dados de titular.' using errcode = '42501'; end if;
  if v_tel <> '' and length(v_tel) < 10 then raise exception 'Telefone incompleto: informe DDD e número.' using errcode = '22023'; end if;
  if v_cpf <> '' and length(v_cpf) <> 11 then raise exception 'O CPF precisa ter 11 números.' using errcode = '22023'; end if;
  if v_mail <> '' and v_mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.' using errcode = '22023'; end if;
  if v_tel = '' and v_cpf = '' and v_mail = '' then raise exception 'Informe o telefone, o CPF ou o e-mail de quem pediu.' using errcode = '22023'; end if;

  -- contas do chat (login por e-mail)
  select coalesce(array_agg(id), '{}') into v_contas from public.contas_paciente
   where (v_mail <> '' and lower(email) = v_mail) or (v_tel <> '' and right(regexp_replace(coalesce(telefone, ''), '\D', '', 'g'), 11) = v_tel);
  -- contatos e conversas do chat
  select coalesce(array_agg(id), '{}') into v_contatos from public.contatos
   where (v_mail <> '' and lower(email) = v_mail) or (v_tel <> '' and right(regexp_replace(coalesce(telefone, ''), '\D', '', 'g'), 11) = v_tel);
  select coalesce(array_agg(id), '{}') into v_conversas from public.conversas
   where contato_id = any (v_contatos) or conta_id = any (v_contas) or (v_mail <> '' and lower(email_informado) = v_mail);
  -- acesso rápido
  select coalesce(array_agg(id), '{}') into v_apps from public.app_paciente
   where (v_tel <> '' and right(regexp_replace(coalesce(telefone, ''), '\D', '', 'g'), 11) = v_tel)
      or (v_cpf <> '' and regexp_replace(coalesce(cpf, ''), '\D', '', 'g') = v_cpf) or (v_mail <> '' and lower(email) = v_mail);
  select coalesce(array_agg(id), '{}') into v_filhos from public.app_filho
   where responsavel_id = any (v_apps) or (v_cpf <> '' and regexp_replace(coalesce(cpf, ''), '\D', '', 'g') = v_cpf);
  select coalesce(array_agg(id), '{}') into v_conf from public.app_contato_confianca
   where responsavel_id = any (v_apps) or (v_tel <> '' and right(regexp_replace(coalesce(telefone, ''), '\D', '', 'g'), 11) = v_tel);
  select coalesce(array_agg(id), '{}') into v_cod from public.app_codigo_email
   where (v_tel <> '' and right(regexp_replace(coalesce(telefone, ''), '\D', '', 'g'), 11) = v_tel) or (v_mail <> '' and lower(email) = v_mail);
  -- pré-cadastro da previsão de marcação
  select coalesce(array_agg(id), '{}') into v_pmarc from public.pmarc_pessoa
   where (v_tel <> '' and (right(regexp_replace(coalesce(celular, ''), '\D', '', 'g'), 11) = v_tel or right(regexp_replace(coalesce(telefone, ''), '\D', '', 'g'), 11) = v_tel))
      or (v_mail <> '' and lower(email) = v_mail);
  -- cadastro de paciente do chat (só o que nunca teve atendimento registrado)
  select coalesce(array_agg(p.id), '{}') into v_pac from public.pacientes p
   where ((v_cpf <> '' and regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g') = v_cpf) or (v_mail <> '' and lower(p.email) = v_mail)
          or (v_tel <> '' and exists (select 1 from unnest(p.telefones) t where right(regexp_replace(coalesce(t, ''), '\D', '', 'g'), 11) = v_tel)))
     and not exists (select 1 from public.atendimentos a where a.paciente_id = p.id);
  select coalesce(array_agg(id), '{}') into v_fila from public.fila_chegada
   where (v_mail <> '' and lower(email) = v_mail) or (v_tel <> '' and right(regexp_replace(coalesce(telefone, ''), '\D', '', 'g'), 11) = v_tel);

  r := jsonb_build_object(
    'contas_do_chat', cardinality(v_contas), 'contatos', cardinality(v_contatos), 'conversas', cardinality(v_conversas),
    'mensagens', (select count(*) from public.mensagens where conversa_id = any (v_conversas)),
    'fotos_e_arquivos', (select count(*) from public.conversa_anexo where conversa_id = any (v_conversas)),
    'pedidos_de_agendamento', (select count(*) from public.pre_agendamentos where conversa_id = any (v_conversas)),
    'acesso_rapido', cardinality(v_apps), 'filhos', cardinality(v_filhos), 'pessoas_de_confianca', cardinality(v_conf),
    'codigos_por_email', cardinality(v_cod), 'previsao_de_marcacao', cardinality(v_pmarc),
    'cadastro_do_chat', cardinality(v_pac), 'chegadas_na_fila', cardinality(v_fila));

  if p_confirmar then
    -- o que prova o pedido: códigos embaralhados (sem o dado em claro)
    begin
      if v_tel <> '' then v_hash := v_hash || public.klingo_hash('tel|' || v_tel); end if;
      if v_cpf <> '' then v_hash := v_hash || public.klingo_hash('cpf|' || v_cpf); end if;
      if v_mail <> '' then v_hash := v_hash || public.klingo_hash('mail|' || v_mail); end if;
    exception when others then v_hash := '{}'; end;

    delete from public.conversas where id = any (v_conversas);          -- mensagens, fotos, pedidos, avaliação e histórico saem em cascata
    delete from public.contatos where id = any (v_contatos);
    delete from public.app_filho where id = any (v_filhos);
    delete from public.app_contato_confianca where id = any (v_conf);
    delete from public.app_paciente where id = any (v_apps);            -- aparelhos, acessos (IP, local), laudos, marcações e resultados saem em cascata
    delete from public.app_codigo_email where id = any (v_cod);
    delete from public.pmarc_pessoa where id = any (v_pmarc);
    delete from public.fila_chegada where id = any (v_fila);
    delete from public.pacientes where id = any (v_pac);
    if v_cpf <> '' then
      begin delete from public.klingo_identidade where cpf_hash = public.klingo_hash(v_cpf); exception when others then null; end;
    end if;
    delete from auth.users where id = any (v_contas);                   -- conta de login do chat (contas_paciente sai em cascata)

    insert into public.lgpd_pedido (ident_hash, por, resumo) values (v_hash, (select auth.uid()), r);
  end if;

  return jsonb_build_object('ok', true, 'simulacao', not p_confirmar, 'apagado', r,
    'mantido', jsonb_build_array(
      'Cadastro e agendamentos no Klingo (prontuário e registros de saúde: obrigação legal, LGPD art. 16, I, e Lei 13.787/2018)',
      'Cópia da agenda no painel (Jornada), refeita a partir do Klingo',
      'Indicadores já somados, sem identificação da pessoa',
      'O registro deste pedido, só com códigos embaralhados, para provar que foi atendido'));
end
$f$;

create or replace function public.painel_lgpd_pedidos()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $f$
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Só o administrador vê os pedidos de eliminação.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'criado_em', p.criado_em, 'por', (select a.nome from public.agentes a where a.id = p.por), 'resumo', p.resumo) order by p.criado_em desc)
                     from (select * from public.lgpd_pedido order by criado_em desc limit 200) p), '[]'::jsonb);
end
$f$;

revoke all on function public.painel_lgpd_eliminar(text, text, text, boolean) from public, anon;
grant execute on function public.painel_lgpd_eliminar(text, text, text, boolean) to authenticated, service_role;
revoke all on function public.painel_lgpd_pedidos() from public, anon;
grant execute on function public.painel_lgpd_pedidos() to authenticated, service_role;
