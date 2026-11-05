-- Revisão humana do preço (aba Catálogo > Cardápio): o administrador confere cada preço e liga ou desliga o chat.
--
--  * Ligado: o chat informa ao paciente a PREVISÃO do preço confirmado (valor que o administrador viu ou corrigiu), com aviso de que é previsão.
--  * Desligado (padrão): o chat continua dizendo que o atendente informa o valor. Nada muda para o paciente até alguém ligar.
--  * Uma revisão vale para um exame e uma operadora (ou Particular). "Ligar" grava o valor confirmado naquele momento; se o catálogo ou o Klingo
--    mudarem depois, o cardápio mostra "!" (preço mudou depois da confirmação) e o chat segue com o valor confirmado até alguém revisar.
--  * Tudo fica registrado em catalogo_preco_revisao_log (quem, quando, valor antes e depois).
-- Aditivo e seguro para rodar de novo. Ordem: depois de catalogo-cardapio.sql.

-- ===== 1. Tabelas =====
create table if not exists public.catalogo_preco_revisao (
  procedimento_id integer not null references public.catalogo_procedimento (id) on delete cascade,
  opn text not null,                      -- operadora normalizada (public.norm_chave) ou 'PARTICULAR'
  operadora text not null,                -- como aparece no cardápio
  ligado boolean not null default false,
  valor numeric(12,2) not null check (valor >= 5 and valor < 100000),
  referencia numeric(12,2),               -- preço de referência (catálogo ou Klingo) que a pessoa viu ao confirmar; serve para avisar se ele mudar depois
  nota text check (nota is null or length(nota) <= 200),
  revisado_por uuid,
  revisado_em timestamptz not null default now(),
  primary key (procedimento_id, opn)
);
alter table public.catalogo_preco_revisao enable row level security;
revoke all on public.catalogo_preco_revisao from public, anon, authenticated;
comment on table public.catalogo_preco_revisao is 'Preço revisado por uma pessoa. ligado = o chat informa esta previsão ao paciente. Sem acesso direto: só as funções catalogo_cardapio, catalogo_preco_revisar e preco_previsao_chat leem ou escrevem.';

create table if not exists public.catalogo_preco_revisao_log (
  id bigint generated always as identity primary key,
  procedimento_id integer not null,
  opn text not null,
  operadora text not null,
  ligado_antes boolean, ligado_depois boolean not null,
  valor_antes numeric(12,2), valor_depois numeric(12,2) not null,
  nota text,
  por uuid,
  criado_em timestamptz not null default now()
);
alter table public.catalogo_preco_revisao_log enable row level security;
revoke all on public.catalogo_preco_revisao_log from public, anon, authenticated;

alter table public.catalogo_preco_revisao add column if not exists referencia numeric(12,2);

-- ===== 2. O botão: ligar, desligar ou corrigir (só administrador) =====
drop function if exists public.catalogo_preco_revisar(integer, text, boolean, numeric, text);
create or replace function public.catalogo_preco_revisar(p_procedimento integer, p_operadora text, p_ligado boolean,
                                                        p_valor numeric default null, p_nota text default null, p_referencia numeric default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  v_opn text := public.norm_chave(p_operadora);
  v_ant public.catalogo_preco_revisao%rowtype;
  v_valor numeric(12,2);
  v_nome text;
  v_op text;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then
    raise exception 'Somente administrador.' using errcode = '42501';
  end if;
  if v_opn is null or p_ligado is null then raise exception 'Informe o exame, a operadora e se o chat deve informar o preço.' using errcode = '22023'; end if;
  if not exists (select 1 from public.catalogo_procedimento where id = p_procedimento and ativo) then
    raise exception 'Exame não encontrado ou inativo.' using errcode = '22023';
  end if;
  v_op := case when v_opn = 'PARTICULAR' then 'PARTICULAR' else btrim(p_operadora) end;

  select * into v_ant from public.catalogo_preco_revisao where procedimento_id = p_procedimento and opn = v_opn;
  v_valor := round(coalesce(p_valor, v_ant.valor), 2);
  if v_valor is null then
    if not p_ligado then return jsonb_build_object('ok', true, 'ligado', false, 'sem_revisao', true); end if;   -- desligar o que nunca foi ligado: nada a fazer
    raise exception 'Informe o valor que o chat deve passar.' using errcode = '22023';
  end if;
  if v_valor < 5 or v_valor >= 100000 then raise exception 'Valor fora do esperado (R$ 5 a R$ 99.999,99).' using errcode = '22023'; end if;

  insert into public.catalogo_preco_revisao (procedimento_id, opn, operadora, ligado, valor, referencia, nota, revisado_por, revisado_em)
  values (p_procedimento, v_opn, v_op, p_ligado, v_valor, round(p_referencia, 2), nullif(left(btrim(coalesce(p_nota, '')), 200), ''), auth.uid(), now())
  on conflict (procedimento_id, opn) do update
    set ligado = excluded.ligado, valor = excluded.valor, operadora = excluded.operadora,
        referencia = case when p_referencia is null then public.catalogo_preco_revisao.referencia else excluded.referencia end,
        nota = case when p_nota is null then public.catalogo_preco_revisao.nota else excluded.nota end,
        revisado_por = excluded.revisado_por, revisado_em = excluded.revisado_em;

  insert into public.catalogo_preco_revisao_log (procedimento_id, opn, operadora, ligado_antes, ligado_depois, valor_antes, valor_depois, nota, por)
  values (p_procedimento, v_opn, v_op, v_ant.ligado, p_ligado, v_ant.valor, v_valor, nullif(left(btrim(coalesce(p_nota, '')), 200), ''), auth.uid());

  return jsonb_build_object('ok', true, 'ligado', p_ligado, 'valor', v_valor);
end $$;
revoke all on function public.catalogo_preco_revisar(integer, text, boolean, numeric, text, numeric) from public, anon;
grant execute on function public.catalogo_preco_revisar(integer, text, boolean, numeric, text, numeric) to authenticated;
