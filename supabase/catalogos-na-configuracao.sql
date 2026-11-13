-- FLUXOGRAMA: entrada (o dono liga ou desliga um catálogo em Configurações > Catálogos do chat) -> validação (config catalogo_<chave> = sim ou nao; nunca deixa o último catálogo ligado ser desligado)
--   -> lógica (o gatilho copia o valor para unidade_config.ativo, que o chat já usa em chat_opcoes_inicio e chat_iniciar) -> saída (o botão do catálogo some ou volta na primeira tela do chat; conversas abertas continuam).
-- Versão 1.0 — 13/11/2026 / Mudança: pedido do dono ("separar por catálogos para poder desativar na configuração"). A tela de Configurações do painel ganhou o grupo "Catálogos do chat (unidades)".
-- Sem "drop": a ferramenta de migração pede confirmação para comandos que parecem destrutivos e expira em 60 s.
-- ROLLBACK: delete from public.config where chave like 'catalogo\_%'; update public.unidade_config set ativo = true; e apagar o gatilho config_catalogo_aplicar e a função catalogo_config_aplicar().

-- Parte 1: chaves (começam como estão hoje em unidade_config.ativo)
insert into public.config (chave, valor)
select 'catalogo_' || u.chave, case when u.ativo then 'sim' else 'nao' end from public.unidade_config u
on conflict (chave) do nothing;

-- Parte 2: gatilho
create or replace function public.catalogo_config_aplicar() returns trigger language plpgsql security definer set search_path to '' as $f$
declare v_chave text := substr(new.chave, 10); v_quer boolean := (new.valor = 'sim'); v_restam int;
begin
  if not exists (select 1 from public.unidade_config u where u.chave = v_chave) then return new; end if;
  if not v_quer then
    select count(*) into v_restam from public.unidade_config u where u.ativo and u.chave <> v_chave;
    if v_restam = 0 then raise exception 'Deixe pelo menos um catálogo ligado: sem nenhum o chat não consegue começar.' using errcode = '22023'; end if;
  end if;
  update public.unidade_config set ativo = v_quer where chave = v_chave and ativo is distinct from v_quer;
  return new;
end $f$;
revoke all on function public.catalogo_config_aplicar() from public, anon, authenticated;
create or replace trigger config_catalogo_aplicar before insert or update of valor on public.config
  for each row when (new.chave like 'catalogo\_%') execute function public.catalogo_config_aplicar();
