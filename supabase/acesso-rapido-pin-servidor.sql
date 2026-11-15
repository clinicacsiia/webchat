-- FLUXOGRAMA: entrada (cada chamada que cria ou continua uma conversa: chat_iniciar, chat_nova_conversa, chat_irmao_iniciar, chat_enviar, chat_responder; o chat manda o código do aparelho no cabeçalho x-acesso) -> validação (app_pin_exigir: só vale com app_acesso_modo, app_pin_obrigatorio e app_pin_servidor = sim; chamada sem requisição HTTP, service_role e funções app_* passam, pois já têm as suas próprias conferências) -> lógica (sem aparelho com PIN dos últimos 30 minutos a chamada é recusada com a mensagem pin_obrigatorio; cada chamada aceita renova os 30 minutos) -> saída (o chat não consegue falar com a clínica sem PIN, mesmo que a tela esteja velha, com defeito ou adulterada)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial.
--
-- POR QUE: em 15/11/2026 o chat abriu sem PIN para quem já tinha o service worker (a regra só existia na tela). A tela continua sendo a porta; isto é a segunda trava, no banco, para que um erro de tela nunca mais deixe alguém falar com a clínica sem PIN.
--
-- COMO LIGAR (só DEPOIS de a tela nova, que manda o cabeçalho x-acesso, estar publicada; antes disso o chat atual seria recusado):
--   update public.config set valor = 'sim' where chave = 'app_pin_servidor';
-- COMO DESLIGAR NA HORA (volta ao que era antes, sem mexer no resto):
--   update public.config set valor = 'nao' where chave = 'app_pin_servidor';
-- Desligar app_pin_obrigatorio ou app_acesso_modo também desliga esta trava.
--
-- O QUE NÃO FAZ: não confere se o cadastro está completo (CPF); isso é da porta ("Falta pouco"). Aqui só se exige um aparelho com PIN válido.
--
-- COMO FUNCIONA A APLICAÇÃO: o bloco no fim lê a definição ATUAL de cada uma das 5 funções no banco e acrescenta só a linha `perform public.app_pin_exigir();` logo depois do `begin` principal (nada mais muda; as permissões ficam). Se a linha já existe, pula. Assim o arquivo vale mesmo que a função tenha mudado desde o retrato.
-- ROLLBACK (voltar as 5 funções ao que eram): refazer cada uma a partir da versão anterior em supabase/producao/funcoes/<nome>.sql (git) e depois:
--   drop function public.app_pin_exigir();   -- (o conector pede confirmação)  e   delete from public.config where chave = 'app_pin_servidor';

insert into public.config (chave, valor) values ('app_pin_servidor', 'nao') on conflict (chave) do nothing;

create or replace function public.app_pin_exigir() returns void language plpgsql security definer set search_path to '' as $$
declare v_h jsonb; v_path text; v_tok text; s record;
begin
  if coalesce((select valor from public.config where chave = 'app_pin_servidor'), 'nao') <> 'sim' then return; end if;
  if not public.app_modo() or coalesce((select valor from public.config where chave = 'app_pin_obrigatorio'), 'nao') <> 'sim' then return; end if;
  begin v_h := current_setting('request.headers', true)::jsonb; exception when others then v_h := null; end;
  if v_h is null then return; end if;   -- sem requisição HTTP (rotina do banco, teste interno): a regra é da porta
  begin if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role' then return; end if; exception when others then null; end;
  begin v_path := current_setting('request.path', true); exception when others then v_path := null; end;
  if coalesce(v_path, '') like '/rpc/app\_%' then return; end if;   -- as funções app_* já conferem o aparelho e o PIN sozinhas
  v_tok := nullif(btrim(coalesce(v_h ->> 'x-acesso', '')), '');
  if v_tok is null then raise exception 'pin_obrigatorio' using hint = 'Digite o seu PIN para continuar.'; end if;
  select * into s from public.app_aparelho_validar(v_tok);   -- confere o PIN dos últimos 30 minutos e renova o prazo
  if s.o_erro is not null then raise exception 'pin_obrigatorio' using hint = 'Digite o seu PIN para continuar.'; end if;
end $$;
revoke all on function public.app_pin_exigir() from public, anon, authenticated;

do $mig$
declare r record; v_def text; v_a integer; v_p integer; v_pos integer; v_novo text; v_alvo text := E'\nbegin\n';
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('chat_iniciar', 'chat_nova_conversa', 'chat_irmao_iniciar', 'chat_enviar', 'chat_responder') order by p.proname loop
    v_def := pg_get_functiondef(r.oid);
    if position('app_pin_exigir' in v_def) > 0 then continue; end if;   -- já aplicada
    v_a := position('AS $function$' in v_def);
    v_p := position(v_alvo in substr(v_def, v_a));
    if v_a = 0 or v_p = 0 then raise exception 'não achei o begin principal de %', r.proname; end if;
    v_pos := v_a + v_p - 1 + length(v_alvo);   -- primeira posição depois do "begin" principal
    v_novo := substr(v_def, 1, v_pos - 1) || E'  perform public.app_pin_exigir();   -- PIN obrigatório também no servidor (nasce desligado: config.app_pin_servidor)\n' || substr(v_def, v_pos);
    execute v_novo;
  end loop;
end $mig$;
