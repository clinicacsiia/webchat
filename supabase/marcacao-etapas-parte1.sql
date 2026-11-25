-- FLUXOGRAMA: entrada (a tela de entrada do chat lê `chat_config()`; o botão "Começar" decide se abre o chat de hoje ou o sistema de marcação por etapas)
--   -> validação (chave `marcacao_etapas_modo` em `config`: nao | piloto | sim; ausente ou erro de rede = `nao`, ou seja, o botão de hoje; no piloto, só os telefones de `marcacao_etapas_telefones`)
--   -> lógica (marcacao_etapas_pode(telefone) responde sim/não; marcacao_ciencia_registrar grava a CIÊNCIA da pré-marcação NO SERVIDOR: hora do servidor, IP, aparelho, texto aceito; exige PIN e token da conversa)
--   -> saída (chat_config devolve também `marcacao_etapas_modo`; a ciência vira uma nota na conversa para a equipe ver no painel) | ROLLBACK: o bloco no fim deste arquivo
-- Versão 1.0 — 24/11/2026 / Mudança: primeira versão (parte 1 da integração do sistema de marcação por etapas; ver docs/integracao-marcacao-por-etapas.md).
--
-- NÃO muda nada do que o paciente vê enquanto `marcacao_etapas_modo` = 'nao' (valor inicial).
-- Para desligar de novo, a qualquer hora:  update public.config set valor = 'nao' where chave = 'marcacao_etapas_modo';

insert into public.config (chave, valor) values ('marcacao_etapas_modo', 'nao'), ('marcacao_etapas_telefones', '') on conflict (chave) do nothing;

-- 1) chat_config: o chat lê a chave ao abrir (a lista de telefones do piloto NUNCA sai daqui).
create or replace function public.chat_config() returns jsonb
language sql stable security definer set search_path = '' as $function$
  select coalesce(jsonb_object_agg(chave, valor), '{}'::jsonb)
  from public.config where chave in ('nome_empresa', 'boas_vindas', 'entrada_webchat_modo', 'entrada_previsao_modo', 'marcacao_etapas_modo')
$function$;

-- 2) quem entra no sistema por etapas: 'sim' = todos; 'piloto' = só os telefones da lista; qualquer outra coisa = ninguém.
create or replace function public.marcacao_etapas_pode(p_telefone text) returns boolean
language plpgsql stable security definer set search_path = '' as $function$
declare v_modo text; v_tel text; v_lista text;
begin
  select valor into v_modo from public.config where chave = 'marcacao_etapas_modo';
  if v_modo = 'sim' then return true; end if;
  if v_modo is distinct from 'piloto' then return false; end if;
  v_tel := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  if char_length(v_tel) in (12, 13) and left(v_tel, 2) = '55' then v_tel := substr(v_tel, 3); end if;
  if char_length(v_tel) not in (10, 11) then return false; end if;
  select valor into v_lista from public.config where chave = 'marcacao_etapas_telefones';
  return exists (
    select 1 from unnest(string_to_array(coalesce(v_lista, ''), ',')) t(x)
    where case when char_length(regexp_replace(t.x, '\D', '', 'g')) in (12, 13) and left(regexp_replace(t.x, '\D', '', 'g'), 2) = '55'
               then substr(regexp_replace(t.x, '\D', '', 'g'), 3) else regexp_replace(t.x, '\D', '', 'g') end = v_tel);
end $function$;

-- 3) ciência da pré-marcação gravada pelo servidor (o navegador não consegue forjar a hora nem o IP).
create table if not exists public.marcacao_ciencia (
  id bigint generated always as identity primary key,
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  em timestamptz not null default now(),
  ip text,
  aparelho jsonb not null default '{}'::jsonb,
  motivo text,
  versao_texto text not null
);
create index if not exists marcacao_ciencia_conversa_idx on public.marcacao_ciencia (conversa_id, em desc);
alter table public.marcacao_ciencia enable row level security;
revoke all on table public.marcacao_ciencia from public, anon, authenticated;

create or replace function public.marcacao_ciencia_registrar(p_conversa uuid, p_token text, p_aparelho jsonb default '{}'::jsonb, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_h jsonb; v_ip text; v_ap jsonb := '{}'::jsonb; k text; v_id bigint; v_em timestamptz;
begin
  perform public.app_pin_exigir();                       -- PIN também no servidor
  perform public.chat_valida(p_conversa, p_token);       -- token secreto da conversa
  if (select count(*) from public.marcacao_ciencia where conversa_id = p_conversa and em > now() - interval '1 hour') >= 5 then
    raise exception 'Muitas confirmações em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  begin v_h := nullif(current_setting('request.headers', true), '')::jsonb; exception when others then v_h := null; end;
  -- IP que a plataforma informa; no x-forwarded-for vale o ÚLTIMO item (o começo pode ser escrito pelo cliente)
  v_ip := nullif(btrim(coalesce(v_h ->> 'cf-connecting-ip', v_h ->> 'x-real-ip',
                                (string_to_array(coalesce(v_h ->> 'x-forwarded-for', ''), ','))[cardinality(string_to_array(coalesce(v_h ->> 'x-forwarded-for', ''), ','))], '')), '');
  -- só estes campos do aparelho são aceitos, cada um com tamanho limitado (nada de texto livre grande)
  if jsonb_typeof(p_aparelho) = 'object' then
    foreach k in array array['aparelho', 'idioma', 'tela', 'fuso', 'navegador'] loop
      if p_aparelho ->> k is not null then v_ap := v_ap || jsonb_build_object(k, left(btrim(p_aparelho ->> k), 160)); end if;
    end loop;
  end if;
  insert into public.marcacao_ciencia (conversa_id, ip, aparelho, motivo, versao_texto)
  values (p_conversa, left(v_ip, 64), v_ap, left(nullif(btrim(coalesce(p_motivo, '')), ''), 120), 'pre-marcacao-v1')
  returning id, em into v_id, v_em;
  perform public.fluxo_nota(p_conversa, 'CIÊNCIA DA PRÉ-MARCAÇÃO registrada em ' || to_char(v_em at time zone 'America/Bahia', 'DD/MM/YYYY HH24:MI:SS') || ' (Bahia): o paciente confirmou que a pré-marcação NÃO garante o horário.');
  return jsonb_build_object('ok', true, 'id', v_id, 'em', v_em);
end $function$;

-- permissões: só estas duas funções são do paciente (anon); a tabela não é de ninguém além do servidor.
revoke all on function public.marcacao_etapas_pode(text) from public;
revoke all on function public.marcacao_ciencia_registrar(uuid, text, jsonb, text) from public;
grant execute on function public.marcacao_etapas_pode(text) to anon, authenticated, service_role;
grant execute on function public.marcacao_ciencia_registrar(uuid, text, jsonb, text) to anon, authenticated, service_role;

-- ROLLBACK (volta tudo ao que era; a tabela só tem a ciência dos testes do piloto):
--   create or replace function public.chat_config() returns jsonb language sql stable security definer set search_path = '' as $function$
--     select coalesce(jsonb_object_agg(chave, valor), '{}'::jsonb) from public.config where chave in ('nome_empresa', 'boas_vindas', 'entrada_webchat_modo', 'entrada_previsao_modo') $function$;
--   drop function if exists public.marcacao_ciencia_registrar(uuid, text, jsonb, text);
--   drop function if exists public.marcacao_etapas_pode(text);
--   drop table if exists public.marcacao_ciencia;
--   delete from public.config where chave in ('marcacao_etapas_modo', 'marcacao_etapas_telefones');
