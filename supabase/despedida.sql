-- FLUXOGRAMA: entrada (o administrador salva o texto e/ou a imagem da despedida em Configurações; toda conversa que passa para 'encerrada') -> validação (só administrador salva; imagem JPG/PNG/WebP conferida pelos primeiros bytes e limitada a ~2 MB; texto até 600 caracteres, sempre mostrado como texto puro) -> lógica (cada salvamento cria uma VERSÃO nova e imutável; ao encerrar, o gatilho grava UMA mensagem de sistema com a versão vigente; repetir o evento não duplica) -> saída (a mensagem chega ao chat do paciente em tempo real e fica no histórico com a versão que foi entregue).
-- Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-05 e WC-06 da Atualização do WebChat). Decisão D4: despedida vazia = a frase de hoje.
-- Pré-requisitos: encerramento-motivo.sql (conversa_status_mudou com histórico do fechamento), 00-base-snapshot.sql (mensagens, chat_valida). Aditivo e idempotente. Nenhum comando destrutivo.
-- LIGAR: Configurações > Encerramento e avaliação > "Usar a despedida configurada" (config.despedida_configurada = 'sim'). Começa 'nao': a frase de hoje continua sendo enviada (agora também marcada como despedida no histórico).
-- ROLLBACK: update public.config set valor = 'nao' where chave = 'despedida_configurada';  (efeito imediato). Para voltar o gatilho: conversa_status_mudou de encerramento-motivo.sql. As tabelas e funções novas podem ficar.

-- ===== PARTE 1: versões da despedida e chaves =====
create table if not exists public.despedida_versao (
  id bigint generated always as identity primary key,
  texto text check (texto is null or char_length(texto) between 1 and 600),
  mime text check (mime is null or mime in ('image/jpeg', 'image/png', 'image/webp')),
  dados bytea,
  criado_em timestamptz not null default now(),
  criado_por uuid,
  check ((mime is null) = (dados is null)),
  check (texto is not null or dados is not null)
);
comment on table public.despedida_versao is 'Cada salvamento da despedida é uma versão nova; as antigas nunca mudam (o histórico das conversas aponta para a versão entregue).';
alter table public.despedida_versao enable row level security;   -- sem política: só as funções abaixo (security definer) leem e gravam
insert into public.config (chave, valor) values ('despedida_configurada', 'nao'), ('despedida_versao_atual', '') on conflict (chave) do nothing;

-- Uma despedida por fechamento: a mesma conversa e o mesmo instante de encerramento não geram duas mensagens.
create unique index if not exists mensagens_despedida_unica on public.mensagens (conversa_id, (opcoes ->> 'encerrada_em')) where (opcoes ->> 'tipo') = 'despedida';

-- ===== PARTE 2: salvar e ler (administrador) =====
create or replace function public.despedida_salvar(p_texto text, p_mime text default null, p_base64 text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_txt text := nullif(btrim(coalesce(p_texto, '')), ''); v_bin bytea; v_id bigint; v_b0 int; v_b1 int; v_b2 int; v_b3 int;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Só o administrador pode alterar a despedida.' using errcode = '42501'; end if;
  if v_txt is not null and char_length(v_txt) > 600 then raise exception 'O texto da despedida pode ter até 600 caracteres.' using errcode = '22023'; end if;
  if nullif(p_base64, '') is not null then
    if p_mime not in ('image/jpeg', 'image/png', 'image/webp') then raise exception 'Envie uma imagem JPG, PNG ou WebP.' using errcode = '22023'; end if;
    if length(p_base64) > 2800000 then raise exception 'A imagem é grande demais (máximo de cerca de 2 MB).' using errcode = '22023'; end if;
    begin v_bin := decode(regexp_replace(p_base64, '^data:[^,]*,', ''), 'base64'); exception when others then raise exception 'Imagem inválida.' using errcode = '22023'; end;
    if length(v_bin) < 12 then raise exception 'Imagem inválida.' using errcode = '22023'; end if;
    v_b0 := get_byte(v_bin, 0); v_b1 := get_byte(v_bin, 1); v_b2 := get_byte(v_bin, 2); v_b3 := get_byte(v_bin, 3);
    if not ((p_mime = 'image/jpeg' and v_b0 = 255 and v_b1 = 216 and v_b2 = 255)
         or (p_mime = 'image/png' and v_b0 = 137 and v_b1 = 80 and v_b2 = 78 and v_b3 = 71)
         or (p_mime = 'image/webp' and v_b0 = 82 and v_b1 = 73 and v_b2 = 70 and v_b3 = 70 and get_byte(v_bin, 8) = 87 and get_byte(v_bin, 9) = 69 and get_byte(v_bin, 10) = 66 and get_byte(v_bin, 11) = 80)) then
      raise exception 'O arquivo não é uma imagem do tipo informado.' using errcode = '22023';
    end if;
  else
    v_bin := null; p_mime := null;
  end if;
  if v_txt is null and v_bin is null then
    update public.config set valor = '' where chave = 'despedida_versao_atual';   -- os dois vazios: volta para a frase padrão
    return jsonb_build_object('ok', true, 'versao', null);
  end if;
  insert into public.despedida_versao (texto, mime, dados, criado_por) values (v_txt, p_mime, v_bin, (select auth.uid())) returning id into v_id;
  update public.config set valor = v_id::text where chave = 'despedida_versao_atual';
  return jsonb_build_object('ok', true, 'versao', v_id);
end $$;
revoke all on function public.despedida_salvar(text, text, text) from public, anon;
grant execute on function public.despedida_salvar(text, text, text) to authenticated;

create or replace function public.despedida_atual() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_ver bigint; r record;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select case when valor ~ '^[0-9]+$' then valor::bigint end into v_ver from public.config where chave = 'despedida_versao_atual';
  select texto, mime, (dados is not null) as tem_imagem, criado_em into r from public.despedida_versao where id = v_ver;
  return jsonb_build_object('ativa', coalesce((select valor from public.config where chave = 'despedida_configurada'), 'nao') = 'sim',
    'versao', case when r.criado_em is null then null else v_ver end, 'texto', r.texto, 'tem_imagem', coalesce(r.tem_imagem, false), 'criado_em', r.criado_em);
end $$;
revoke all on function public.despedida_atual() from public, anon;
grant execute on function public.despedida_atual() to authenticated;

create or replace function public.despedida_imagem(p_versao bigint) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare r record;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select mime, dados into r from public.despedida_versao where id = p_versao and dados is not null;
  if not found then return null; end if;
  return jsonb_build_object('mime', r.mime, 'base64', encode(r.dados, 'base64'));
end $$;
revoke all on function public.despedida_imagem(bigint) from public, anon;
grant execute on function public.despedida_imagem(bigint) to authenticated;

-- O paciente só vê a imagem da versão que foi entregue na PRÓPRIA conversa (token da conversa).
create or replace function public.chat_despedida_imagem(p_conversa uuid, p_token text, p_versao bigint) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare r record;
begin
  perform public.chat_valida(p_conversa, p_token);
  if not exists (select 1 from public.mensagens m where m.conversa_id = p_conversa and (m.opcoes ->> 'tipo') = 'despedida' and (m.opcoes ->> 'versao') = p_versao::text) then return null; end if;
  select mime, dados into r from public.despedida_versao where id = p_versao and dados is not null;
  if not found then return null; end if;
  return jsonb_build_object('mime', r.mime, 'base64', encode(r.dados, 'base64'));
end $$;
revoke all on function public.chat_despedida_imagem(uuid, text, bigint) from public;
grant execute on function public.chat_despedida_imagem(uuid, text, bigint) to anon, authenticated;

-- ===== PARTE 3: publicar a despedida no fechamento =====
create or replace function public.despedida_publicar(p_conversa uuid, p_encerrada_em timestamptz) returns void
language plpgsql security definer set search_path to '' as $$
declare
  v_padrao constant text := 'Atendimento encerrado. Se precisar, é só mandar uma nova mensagem.';
  v_ver bigint; v_id bigint; v_txt text; v_img boolean := false; v_texto text := v_padrao; v_opc jsonb;
begin
  if coalesce((select valor from public.config where chave = 'despedida_configurada'), 'nao') = 'sim' then
    select case when valor ~ '^[0-9]+$' then valor::bigint end into v_ver from public.config where chave = 'despedida_versao_atual';
    select d.id, d.texto, (d.dados is not null) into v_id, v_txt, v_img from public.despedida_versao d where d.id = v_ver;
    if v_id is not null then v_texto := coalesce(nullif(btrim(v_txt), ''), v_padrao); else v_img := false; end if;
  end if;
  v_opc := jsonb_build_object('tipo', 'despedida', 'versao', v_id, 'imagem', coalesce(v_img, false), 'encerrada_em', p_encerrada_em::text);
  insert into public.mensagens (conversa_id, autor, texto, opcoes) values (p_conversa, 'sistema', v_texto, v_opc) on conflict do nothing;
end $$;
revoke all on function public.despedida_publicar(uuid, timestamptz) from public, anon, authenticated;

-- Gatilho (definição de encerramento-motivo.sql, trocando só a mensagem fixa pela despedida).
create or replace function public.conversa_status_mudou() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v_nome text;
begin
  if new.status is distinct from old.status then
    if new.status = 'em_atendimento' and new.agente_id is not null then
      select nome into v_nome from public.agentes where id = new.agente_id;
      insert into public.mensagens (conversa_id, autor, texto)
      values (new.id, 'sistema', coalesce(v_nome, 'Um atendente') || ' entrou na conversa.');
    elsif new.status = 'encerrada' then
      perform public.despedida_publicar(new.id, new.encerrada_em);
      insert into public.conversa_encerramento (conversa_id, encerrada_em, motivo, origem, por)
      values (new.id, new.encerrada_em, new.motivo_encerramento, new.encerramento_origem, new.encerrada_por)
      on conflict (conversa_id, encerrada_em) do nothing;
    end if;
  end if;
  return new;
end $$;
