-- FLUXOGRAMA: entrada (um PIN novo: criar o cadastro, migrar a conta antiga, trocar ou recuperar o PIN) -> validação (app_pin_fraco: números repetidos 1111, sequências 1234 e 4321, pares repetidos 1212 e 1122) -> lógica (as 4 funções que criam um PIN recusam com erro 'pin_fraco' e a mensagem; quem já tem PIN não é afetado até trocá-lo) -> saída (o PIN dos novos usuários e dos antigos que migram não é o primeiro que alguém tentaria)
-- Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (auditoria de 15/11/2026: o PIN aceitava 0000, 1234, 1111).
--
-- POR QUE: o PIN tem 4 números e 5 erros bloqueiam por 1 minuto (depois 15 minutos e 1 hora). Isso protege de adivinhar à força, mas quem escolhe 0000 ou 1234 cai na primeira tentativa. A regra é só sobre PINs NOVOS: nenhum PIN existente é mexido.
-- NÃO MUDA: app_login e app_desbloquear (só conferem o PIN que já existe).
-- ROLLBACK: refazer app_cadastrar, app_conta_antiga_migrar, app_pin_trocar e app_pin_esqueci a partir de supabase/producao/funcoes/<nome>.sql (git); a função app_pin_fraco pode ficar (não é chamada por mais ninguém).

create or replace function public.app_pin_fraco(p_pin text) returns boolean language sql immutable set search_path to '' as $$
  select coalesce(p_pin ~ '^([0-9])\1{3}$'                                   -- 0000, 1111, ..., 9999
      or p_pin in ('0123', '1234', '2345', '3456', '4567', '5678', '6789', '3210', '4321', '5432', '6543', '7654', '8765', '9876')
      or p_pin ~ '^([0-9])([0-9])\1\2$'                                       -- 1212, 3434, ...
      or p_pin ~ '^([0-9])\1([0-9])\2$', false)                               -- 1122, 3344, ...
$$;
revoke all on function public.app_pin_fraco(text) from public, anon, authenticated;

do $mig$
declare r record; v_def text; v_novo text; v_param text; v_antigo text := '''O PIN precisa ter 4 números.''); end if;';
begin
  for r in select * from (values ('app_cadastrar', 'p_pin'), ('app_conta_antiga_migrar', 'p_pin'), ('app_pin_trocar', 'p_novo'), ('app_pin_esqueci', 'p_pin_novo')) as t(nome, param) loop
    select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = r.nome;
    if v_def is null then raise exception 'função % não existe', r.nome; end if;
    if position('app_pin_fraco' in v_def) > 0 then continue; end if;   -- já aplicada
    if position(v_antigo in v_def) = 0 then raise exception 'não achei a conferência do formato do PIN em %', r.nome; end if;
    v_novo := replace(v_def, v_antigo, v_antigo || E'\n  if public.app_pin_fraco(' || r.param || E') then return jsonb_build_object(''ok'', false, ''erro'', ''pin_fraco'', ''mensagem'', ''Escolha um PIN menos óbvio: não use números repetidos (1111), em sequência (1234) nem pares repetidos (1212).''); end if;');
    execute v_novo;
  end loop;
end $mig$;
