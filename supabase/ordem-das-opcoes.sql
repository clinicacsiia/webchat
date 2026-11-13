-- FLUXOGRAMA: entrada (o chat monta uma pergunta com botões em fluxo_perguntar) -> validação (só os passos motivo, plano e assunto; opção sem peso fica depois, na ordem de sempre)
--   -> lógica (fluxo_ordenar ordena os botões pelo peso em fluxo_opcao_ordem, do maior para o menor) -> saída (os botões mais escolhidos aparecem primeiro).
-- Versão 1.0 — 13/11/2026 / Mudança: ordem das opções pelo uso real (dados de 29/10 a 12/11/2026). Os pesos são atualizados pelo ciclo de melhoria (docs/ciclo-de-melhoria-com-claude.md).
-- Não mexe em: médico (continua "Tanto faz" primeiro e ordem alfabética, para não concentrar a demanda), confirmar, calendário.
-- ROLLBACK: delete from public.fluxo_opcao_ordem; (a ordem volta à de sempre, sem mexer na função). Para tirar de vez: reaplicar fluxo_perguntar de supabase/producao/funcoes/ e drop function public.fluxo_ordenar(text, jsonb); drop table public.fluxo_opcao_ordem;
-- APLICAR EM PARTES (a ferramenta de migração expira em 60 s): 1) tabela + função; 2) pesos; 3) ligar na função fluxo_perguntar.

-- Parte 1
create table if not exists public.fluxo_opcao_ordem (
  passo text not null, valor text not null, peso numeric not null default 0, atualizado_em timestamptz not null default now(),
  primary key (passo, valor)
);
comment on table public.fluxo_opcao_ordem is 'Peso de cada botão do chat (maior = aparece antes). Preenchido pelo ciclo de melhoria com base nos cliques reais; sem linha = ordem original, depois dos que têm peso.';
alter table public.fluxo_opcao_ordem enable row level security;
revoke all on public.fluxo_opcao_ordem from public, anon, authenticated;

create or replace function public.fluxo_ordenar(p_passo text, p_itens jsonb)
 returns jsonb language sql stable security definer set search_path to ''
as $f$
  select coalesce(jsonb_agg(x.v order by coalesce(o.peso, 0) desc, x.ord), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) with ordinality x(v, ord)
    left join public.fluxo_opcao_ordem o on o.passo = p_passo and lower(o.valor) = lower(coalesce(x.v ->> 'valor', ''))
$f$;
revoke all on function public.fluxo_ordenar(text, jsonb) from public, anon, authenticated;
grant execute on function public.fluxo_ordenar(text, jsonb) to service_role;

-- Parte 2: pesos = cliques reais de 29/10 a 12/11/2026 (conversas sem teste)
insert into public.fluxo_opcao_ordem (passo, valor, peso) values
  ('motivo', 'consulta', 265), ('motivo', 'exame', 10), ('motivo', 'assunto', 9),
  ('assunto', 'Outro', 5), ('assunto', 'Remarcar', 4),
  ('plano', 'sulamerica', 54), ('plano', 'bradesco saude', 48), ('plano', 'central nacional unimed', 33), ('plano', 'unimed seguros saúde s/a', 22), ('plano', 'amil', 19),
  ('plano', 'particular', 14), ('plano', 'hapvida', 9), ('plano', 'planserv', 7), ('plano', 'petrobras', 4), ('plano', 'cassi', 3), ('plano', 'bradesco operadora', 3),
  ('plano', 'promedica', 3), ('plano', 'camed saude', 2), ('plano', 'mediservice', 1), ('plano', 'geap', 1)
on conflict (passo, valor) do update set peso = excluded.peso, atualizado_em = now();

-- Parte 3: liga na função que monta as perguntas (parte do que está na produção agora, não de um arquivo antigo)
do $do$
declare d text; a text := E'  perform public.fluxo_dizer(p_conversa, v_txt, v_op);\n  update public.conversa_fluxo set tentativas';
begin
  d := pg_get_functiondef('public.fluxo_perguntar(uuid,text,text)'::regprocedure);
  if position('fluxo_ordenar' in d) > 0 then return; end if;   -- já aplicado
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then raise exception 'ponto de ligação não encontrado ou repetido'; end if;
  execute replace(d, a, E'  if p_passo in (''motivo'', ''plano'', ''assunto'') and jsonb_typeof(v_op -> ''itens'') = ''array'' then v_op := jsonb_set(v_op, ''{itens}'', public.fluxo_ordenar(p_passo, v_op -> ''itens'')); end if;\n' || a);
end $do$;
