-- SNAPSHOT DE REFERÊNCIA do que veio ANTES dos arquivos fase*/catalogo*/pacientes*/pre-agendamentos (tabelas e funções do chat, do painel e do login).
-- Gerado a partir do banco em 30/10/2026. NÃO é migração incremental e NÃO deve ser rodado no projeto atual (tudo isto já existe lá).
-- Serve para: (1) recriar o projeto do zero num Supabase novo (rode este arquivo primeiro, depois os demais na ordem do docs/passagem-fases-3-a-5.md);
-- (2) auditar o que o painel e o chat chamam. Para um espelho completo e fiel, prefira `supabase db dump --schema public` no terminal.
-- Extensões necessárias: pgcrypto, uuid-ossp, unaccent (schema extensions), pg_net, pg_cron, supabase_vault.
-- Nenhum comando destrutivo.

create extension if not exists pg_net;
create extension if not exists pg_cron;
create extension if not exists unaccent with schema extensions;

-- ===== Tabelas =====
create table if not exists public.agentes (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text not null, email text,
  papel text not null default 'atendente' check (papel in ('admin','atendente','marketing')),
  ativo boolean not null default false,
  criado_em timestamptz not null default now()
);
create table if not exists public.config (chave text primary key, valor text not null default '');
create table if not exists public.contatos (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (char_length(nome) between 2 and 120),
  telefone text not null check (char_length(telefone) between 10 and 11),
  email text check (email is null or char_length(email) <= 200),
  origem text, tags text[] not null default '{}', observacoes text,
  aceitou_lgpd_em timestamptz,
  criado_em timestamptz not null default now(), ultimo_contato_em timestamptz not null default now()
);
create unique index if not exists contatos_telefone_key on public.contatos (telefone);
create table if not exists public.conversas (
  id uuid primary key default gen_random_uuid(),
  contato_id uuid not null references public.contatos(id) on delete cascade,
  status text not null default 'aguardando' check (status in ('aguardando','em_atendimento','encerrada')),
  agente_id uuid references public.agentes(id) on delete set null,
  ultima_mensagem text, nao_lidas_agente integer not null default 0,
  criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now(), encerrada_em timestamptz,
  ia_ativa boolean not null default true, triagem_resumo text,
  triagem_urgencia text check (triagem_urgencia in ('baixa','media','alta')),
  alerta_agenda text   -- Fase 3: alerta da conferência automática da agenda
);
create index if not exists conversas_agente_idx on public.conversas (agente_id);
create index if not exists conversas_contato_idx on public.conversas (contato_id);
create index if not exists conversas_status_idx on public.conversas (status, atualizado_em desc);
create table if not exists public.conversa_segredo (
  conversa_id uuid primary key references public.conversas(id) on delete cascade,
  token text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
create table if not exists public.mensagens (
  id bigint generated always as identity primary key,
  conversa_id uuid not null references public.conversas(id) on delete cascade,
  autor text not null check (autor in ('cliente','agente','sistema')),
  agente_id uuid references public.agentes(id) on delete set null,
  texto text not null check (char_length(texto) between 1 and 4000),
  criado_em timestamptz not null default now(),
  opcoes jsonb
);
create index if not exists mensagens_agente_idx on public.mensagens (agente_id);
create index if not exists mensagens_conversa_idx on public.mensagens (conversa_id, id);

-- ===== Funções de papel, login e configuração =====
create or replace function public.papel_atual() returns text language sql stable security definer set search_path to '' as $$
  select papel from public.agentes where id = (select auth.uid()) and ativo
$$;

create or replace function public.novo_usuario() returns trigger language plpgsql security definer set search_path to '' as $$
declare v_primeiro boolean;
begin
  select not exists (select 1 from public.agentes) into v_primeiro;
  insert into public.agentes (id, nome, email, papel, ativo)
  values (new.id, coalesce(nullif(btrim(new.raw_user_meta_data->>'nome'), ''), split_part(new.email, '@', 1)), new.email,
          case when v_primeiro then 'admin' else 'atendente' end, v_primeiro);
  return new;
end $$;
-- a primeira conta criada vira administradora e ativa; as demais ficam "aguardando liberação"
create or replace trigger on_auth_user_created after insert on auth.users for each row execute function public.novo_usuario();

create or replace function public.admin_redefinir_senha(p_agente uuid, p_senha text) returns void language plpgsql security definer set search_path to '' as $$
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Apenas administradores podem redefinir senhas.'; end if;
  if p_senha is null or length(p_senha) < 8 then raise exception 'A senha precisa ter pelo menos 8 caracteres.'; end if;
  if p_agente = auth.uid() then raise exception 'Para trocar a sua própria senha, use a opção Minha senha.'; end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_senha, extensions.gen_salt('bf')),
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || '{"trocar_senha": true}'::jsonb,
         updated_at = now()
   where id = p_agente;
  if not found then raise exception 'Pessoa não encontrada.'; end if;
end $$;

create or replace function public.chat_config() returns jsonb language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_object_agg(chave, valor), '{}'::jsonb) from public.config where chave in ('nome_empresa', 'boas_vindas')
$$;

-- ===== Chat do paciente (anon + token da conversa) =====
create or replace function public.chat_iniciar(p_nome text, p_telefone text, p_email text default null, p_mensagem text default null, p_aceite boolean default false, p_origem text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_tel text; v_contato uuid; v_conv uuid; v_token text; v_url text; v_nome text; v_msg text; v_recentes int;
begin
  if not coalesce(p_aceite, false) then raise exception 'Aceite a política de privacidade para continuar.' using errcode = '22023'; end if;
  v_nome := btrim(coalesce(p_nome, ''));
  if char_length(v_nome) < 2 then raise exception 'Informe seu nome.' using errcode = '22023'; end if;
  v_tel := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  if char_length(v_tel) in (12, 13) and left(v_tel, 2) = '55' then v_tel := substr(v_tel, 3); end if;
  if char_length(v_tel) not in (10, 11) then raise exception 'Informe um telefone válido com DDD.' using errcode = '22023'; end if;
  v_msg := btrim(coalesce(p_mensagem, ''));
  if char_length(v_msg) > 4000 then raise exception 'Mensagem muito longa.' using errcode = '22023'; end if;
  select c.id into v_contato from public.contatos c where c.telefone = v_tel;
  if v_contato is not null then
    select count(*) into v_recentes from public.conversas where contato_id = v_contato and criado_em > now() - interval '1 hour';
    if v_recentes >= 5 then raise exception 'Muitas tentativas. Tente novamente em alguns minutos.' using errcode = '54000'; end if;
  end if;
  insert into public.contatos (nome, telefone, email, origem, aceitou_lgpd_em)
  values (left(v_nome, 120), v_tel, nullif(left(btrim(coalesce(p_email, '')), 200), ''), nullif(left(btrim(coalesce(p_origem, '')), 100), ''), now())
  on conflict (telefone) do update set ultimo_contato_em = now(), email = coalesce(public.contatos.email, excluded.email), aceitou_lgpd_em = coalesce(public.contatos.aceitou_lgpd_em, now())
  returning id into v_contato;
  insert into public.conversas (contato_id) values (v_contato) returning id into v_conv;   -- cada visita abre uma conversa nova
  insert into public.conversa_segredo (conversa_id) values (v_conv) returning token into v_token;
  if v_msg <> '' then insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'cliente', v_msg); end if;
  select valor into v_url from public.config where chave = 'n8n_webhook_url';
  if coalesce(v_url, '') <> '' then
    begin
      perform net.http_post(url := v_url,
        body := jsonb_build_object('evento', 'nova_conversa', 'conversa_id', v_conv, 'nome', v_nome, 'telefone', v_tel,
                                   'email', nullif(btrim(coalesce(p_email, '')), ''), 'mensagem', v_msg, 'origem', p_origem, 'criado_em', now()),
        headers := '{"Content-Type":"application/json"}'::jsonb);
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('conversa_id', v_conv, 'token', v_token);
end $$;

create or replace function public.chat_enviar(p_conversa uuid, p_token text, p_texto text) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_txt text; v_id bigint;
begin
  v_txt := btrim(coalesce(p_texto, ''));
  if v_txt = '' or char_length(v_txt) > 4000 then raise exception 'Mensagem inválida.' using errcode = '22023'; end if;
  perform 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  update public.conversas set status = case when status = 'encerrada' then 'aguardando' else status end,
    agente_id = case when status = 'encerrada' then null else agente_id end where id = p_conversa;
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.chat_listar(p_conversa uuid, p_token text, p_apos bigint default 0) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_status text; v_agente text;
begin
  select c.status, a.nome into v_status, v_agente from public.conversas c
    join public.conversa_segredo s on s.conversa_id = c.id left join public.agentes a on a.id = c.agente_id
   where c.id = p_conversa and s.token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  return jsonb_build_object('status', v_status, 'agente', v_agente, 'mensagens', coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'autor', m.autor, 'texto', m.texto, 'opcoes', m.opcoes, 'criado_em', m.criado_em,
                                        'agente', coalesce(ag.nome, case when m.autor = 'agente' then 'Assistente virtual' end)) order by m.id)
    from (select * from public.mensagens where conversa_id = p_conversa and id > coalesce(p_apos, 0) order by id limit 200) m
    left join public.agentes ag on ag.id = m.agente_id), '[]'::jsonb));
end $$;

-- ===== Gatilhos de conversas e mensagens =====
create or replace function public.conversa_antes_update() returns trigger language plpgsql set search_path to '' as $$
begin
  if new.status is distinct from old.status then
    new.encerrada_em := case when new.status = 'encerrada' then now() else null end;
    if old.status = 'encerrada' and new.status = 'aguardando' then new.ia_ativa := true; new.triagem_resumo := null; new.triagem_urgencia := null; end if;
  end if;
  return new;
end $$;

create or replace function public.conversa_status_mudou() returns trigger language plpgsql security definer set search_path to '' as $$
declare v_nome text;
begin
  if new.status is distinct from old.status then
    if new.status = 'em_atendimento' and new.agente_id is not null then
      select nome into v_nome from public.agentes where id = new.agente_id;
      insert into public.mensagens (conversa_id, autor, texto) values (new.id, 'sistema', coalesce(v_nome, 'Um atendente') || ' entrou na conversa.');
    elsif new.status = 'encerrada' then
      insert into public.mensagens (conversa_id, autor, texto) values (new.id, 'sistema', 'Atendimento encerrado. Se precisar, é só mandar uma nova mensagem.');
    end if;
  end if;
  return new;
end $$;

create or replace function public.mensagem_inserida() returns trigger language plpgsql security definer set search_path to '' as $$
declare v_token text; v_nome text;
begin
  update public.conversas set ultima_mensagem = left(new.texto, 140), atualizado_em = now(),
    nao_lidas_agente = case when new.autor = 'cliente' then nao_lidas_agente + 1 else nao_lidas_agente end where id = new.conversa_id;
  if new.autor = 'cliente' then
    update public.contatos set ultimo_contato_em = now() where id = (select contato_id from public.conversas where id = new.conversa_id);
  end if;
  select token into v_token from public.conversa_segredo where conversa_id = new.conversa_id;
  if v_token is not null then
    select nome into v_nome from public.agentes where id = new.agente_id;
    if v_nome is null and new.autor = 'agente' then v_nome := 'Assistente virtual'; end if;
    begin
      perform realtime.send(jsonb_build_object('id', new.id, 'autor', new.autor, 'texto', new.texto, 'criado_em', new.criado_em, 'agente', v_nome, 'opcoes', new.opcoes),
                            'msg', 'conversa:' || v_token, false);
    exception when others then null;
    end;
  end if;
  return new;
end $$;

create or replace function public.avisar_n8n_mensagem() returns trigger language plpgsql security definer set search_path to '' as $$
declare v_url text; v_ok boolean;
begin
  if new.autor <> 'cliente' then return new; end if;
  select (c.ia_ativa and c.status = 'aguardando') into v_ok from public.conversas c where c.id = new.conversa_id;
  if not coalesce(v_ok, false) then return new; end if;
  if coalesce((select valor from public.config where chave = 'ia_ativa'), 'sim') <> 'sim' then return new; end if;
  select valor into v_url from public.config where chave = 'n8n_webhook_url';
  if coalesce(v_url, '') = '' then return new; end if;
  begin
    perform net.http_post(url := v_url, body := jsonb_build_object('evento', 'mensagem_cliente', 'conversa_id', new.conversa_id, 'mensagem_id', new.id, 'texto', new.texto),
                          headers := '{"Content-Type":"application/json"}'::jsonb);
  exception when others then null;
  end;
  return new;
end $$;

create or replace trigger conversas_antes_update before update on public.conversas for each row execute function public.conversa_antes_update();
create or replace trigger conversas_apos_update after update on public.conversas for each row execute function public.conversa_status_mudou();
create or replace trigger mensagens_apos_insert after insert on public.mensagens for each row execute function public.mensagem_inserida();
create or replace trigger mensagens_avisar_n8n after insert on public.mensagens for each row execute function public.avisar_n8n_mensagem();

-- ===== IA (chamadas pelo n8n com o segredo config.ia_segredo) =====
create or replace function public.ia_responder(p_segredo text, p_conversa uuid, p_texto text, p_resumo text default null, p_urgencia text default null, p_transferir boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_seg text; v_ok boolean;
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if v_seg is null or p_segredo is distinct from v_seg then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select (ia_ativa and status = 'aguardando') into v_ok from public.conversas where id = p_conversa for update;
  if not coalesce(v_ok, false) then return jsonb_build_object('enviada', false); end if;
  if btrim(coalesce(p_texto, '')) <> '' then insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'agente', left(btrim(p_texto), 4000)); end if;
  update public.conversas set
    triagem_resumo = coalesce(nullif(left(btrim(coalesce(p_resumo, '')), 1000), ''), triagem_resumo),
    triagem_urgencia = coalesce(case when p_urgencia in ('baixa','media','alta') then p_urgencia end, triagem_urgencia),
    ia_ativa = case when p_transferir then false else ia_ativa end
  where id = p_conversa;
  return jsonb_build_object('enviada', true);
end $$;

-- ia_contexto: estado atual (inclui paciente_conhecido da pacientes.sql e historico_paciente da fase4).
create or replace function public.ia_contexto(p_segredo text, p_conversa uuid) returns jsonb language plpgsql security definer set search_path to '' as $$
declare v_seg text; r jsonb;
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if v_seg is null or p_segredo is distinct from v_seg then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select jsonb_build_object(
    'ia_ativa', c.ia_ativa and c.status = 'aguardando' and coalesce((select valor from public.config where chave = 'ia_ativa'), 'sim') = 'sim',
    'status', c.status, 'nome', ct.nome, 'telefone', ct.telefone, 'origem', ct.origem,
    'pedido_itens', coalesce((select jsonb_agg(jsonb_build_object('modalidade', i.modalidade, 'parte_do_corpo', i.regiao_nome,
        'lado', case i.lado when 'D' then 'direito' when 'E' then 'esquerdo' when 'A' then 'ambos' else null end, 'exame', i.procedimento, 'quantidade', i.quantidade) order by i.id)
        from public.pre_agendamento_itens i where i.conversa_id = c.id and i.ativo), '[]'::jsonb),
    'paciente_conhecido', (public.paciente_conferir(c.id) - 'paciente_id'),
    'historico_paciente', public.paciente_historico_para_ia(c.id),
    'pre_agendamento', (select to_jsonb(pa) - 'id' - 'conversa_id' - 'criado_em' - 'atualizado_em' - 'klingo_paciente_id' - 'paciente_id'
                        from public.pre_agendamentos pa where pa.conversa_id = c.id),
    'mensagens', coalesce((select jsonb_agg(jsonb_build_object('autor', m.autor, 'texto', m.texto) order by m.id)
                           from (select * from public.mensagens where conversa_id = c.id and autor in ('cliente','agente') order by id desc limit 40) m), '[]'::jsonb))
  into r from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
  return r;
end $$;

-- ia_pre_agendar: estado atual (grava o pré-agendamento, confere identidade, cria/atualiza o paciente conhecido e aceita "reaproveitar" da fase 4).
create or replace function public.ia_pre_agendar(p_segredo text, p_conversa uuid, p_dados jsonb, p_pronto boolean default false) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_seg text; v_ok boolean; v_pac jsonb := '{}'::jsonb; k text; v text;
  campos text[] := array['nome','nome_social','sexo','dt_nasc','mae','cpf','rg','cns','celular','telefone','email','cep','endereco','numero','complemento','bairro','cidade','uf','matricula','validade'];
  r public.pre_agendamentos; v_conf jsonb; v_pid uuid; v_ident text; v_p jsonb; v_ct record;
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  if v_seg is null or p_segredo is distinct from v_seg then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select true into v_ok from public.conversas where id = p_conversa;
  if not coalesce(v_ok, false) or p_dados is null or jsonb_typeof(p_dados) <> 'object' then return jsonb_build_object('salvo', false); end if;
  if jsonb_typeof(p_dados->'paciente') = 'object' then
    foreach k in array campos loop
      v := nullif(btrim(p_dados->'paciente'->>k), '');
      if v is null then continue; end if;
      if k in ('cpf','celular','telefone','cep') then v := regexp_replace(v, '\D', '', 'g'); end if;
      if k = 'uf' then v := upper(left(v, 2)); end if;
      if v <> '' then v_pac := v_pac || jsonb_build_object(k, left(v, 200)); end if;
    end loop;
  end if;
  insert into public.pre_agendamentos as pa (conversa_id, tipo, especialidade, procedimento, plano, unidade, profissional, preferencia_horario, paciente, status, etapa)
  values (p_conversa, case when p_dados->>'tipo' in ('consulta','exame') then p_dados->>'tipo' end,
    left(nullif(btrim(p_dados->>'especialidade'), ''), 120), left(nullif(btrim(p_dados->>'procedimento'), ''), 160),
    left(nullif(btrim(p_dados->>'plano'), ''), 120), left(nullif(btrim(p_dados->>'unidade'), ''), 120),
    left(nullif(btrim(p_dados->>'profissional'), ''), 120), left(nullif(btrim(p_dados->>'preferencia_horario'), ''), 200),
    v_pac, case when p_pronto then 'pronto' else 'rascunho' end,
    case when p_dados->>'etapa' in ('pedido','plano','preferencias','data_hora','dados','confirmacao','pronto') then p_dados->>'etapa' end)
  on conflict (conversa_id) do update set
    tipo = coalesce(excluded.tipo, pa.tipo), especialidade = coalesce(excluded.especialidade, pa.especialidade),
    procedimento = coalesce(excluded.procedimento, pa.procedimento), plano = coalesce(excluded.plano, pa.plano),
    unidade = coalesce(excluded.unidade, pa.unidade), profissional = coalesce(excluded.profissional, pa.profissional),
    preferencia_horario = coalesce(excluded.preferencia_horario, pa.preferencia_horario),
    etapa = coalesce(excluded.etapa, pa.etapa), paciente = pa.paciente || excluded.paciente,
    status = case when pa.status in ('agendado','cancelado') then pa.status when p_pronto then 'pronto' else pa.status end,
    atualizado_em = now()
  returning * into r;

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
                           where p.id = v_pid and e.key = any(array['nome_social','sexo','dt_nasc','mae','cpf','rg','cns','celular','telefone','email','cep','endereco','numero','complemento','bairro','cidade','uf'])), '{}'::jsonb) || x.paciente,
      paciente_id = v_pid, identidade = v_ident
    where x.conversa_id = p_conversa;
  else
    update public.pre_agendamentos x set identidade = v_ident,
      paciente_id = case when v_ident in ('nova', 'divergente') then null else x.paciente_id end
    where x.conversa_id = p_conversa;
  end if;

  -- Fase 4: o paciente aceitou repetir o último exame ('ultimo') ou retomar o pedido pela metade ('pendente').
  if p_dados ->> 'reaproveitar' in ('ultimo', 'pendente') then perform public.pre_reaproveitar(p_conversa, p_dados ->> 'reaproveitar'); end if;
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
  return jsonb_build_object('salvo', true, 'status', r.status, 'identidade', v_ident);
end $$;

-- ===== Segurança (RLS) =====
alter table public.agentes enable row level security;
alter table public.config enable row level security;
alter table public.contatos enable row level security;
alter table public.conversa_segredo enable row level security;   -- sem política: só as funções acima leem
alter table public.conversas enable row level security;
alter table public.mensagens enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'agentes') then
    create policy agentes_select on public.agentes for select using (id = (select auth.uid()) or (select public.papel_atual()) is not null);
    create policy agentes_update on public.agentes for update using ((select public.papel_atual()) = 'admin') with check ((select public.papel_atual()) = 'admin');
    create policy agentes_delete on public.agentes for delete using ((select public.papel_atual()) = 'admin');
    create policy config_select on public.config for select using ((select public.papel_atual()) = 'admin');
    create policy config_update on public.config for update using ((select public.papel_atual()) = 'admin') with check ((select public.papel_atual()) = 'admin');
    create policy contatos_select on public.contatos for select using ((select public.papel_atual()) is not null);
    create policy contatos_update on public.contatos for update using ((select public.papel_atual()) is not null) with check ((select public.papel_atual()) is not null);
    create policy contatos_delete on public.contatos for delete using ((select public.papel_atual()) = 'admin');
    create policy conversas_select on public.conversas for select using ((select public.papel_atual()) is not null);
    create policy conversas_update on public.conversas for update using ((select public.papel_atual()) = any (array['admin','atendente']))
      with check ((select public.papel_atual()) = any (array['admin','atendente']));
    create policy mensagens_select on public.mensagens for select using ((select public.papel_atual()) = any (array['admin','atendente']));
    create policy mensagens_insert on public.mensagens for insert
      with check ((select public.papel_atual()) = any (array['admin','atendente']) and autor = 'agente' and agente_id = (select auth.uid()));
  end if;
end $$;

-- ===== Tempo real (painel) e configuração inicial =====
do $$ begin
  begin alter publication supabase_realtime add table public.conversas; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.mensagens; exception when duplicate_object then null; end;
end $$;
insert into public.config (chave, valor) values
  ('nome_empresa', 'Atendimento'), ('boas_vindas', 'Olá! Conta pra gente como podemos ajudar. Um atendente responde em instantes.'),
  ('ia_ativa', 'sim'), ('n8n_webhook_url', ''),
  ('ia_segredo', encode(gen_random_bytes(24), 'hex'))   -- troque no n8n (nós que chamam ia_*) para o mesmo valor
on conflict (chave) do nothing;
-- Depois: conceder execução às funções públicas do chat (anon/authenticated) como no estado atual:
--   chat_config, chat_iniciar, chat_enviar, chat_listar, chat_corpo, chat_exames, chat_horarios, chat_horario_escolher, chat_pedido_salvar -> anon, authenticated
--   ia_* -> anon (protegidas pelo segredo); admin_redefinir_senha, papel_atual -> authenticated
--   funções internas (agenda_conferencia_*, pre_*, paciente_*) -> somente service_role
