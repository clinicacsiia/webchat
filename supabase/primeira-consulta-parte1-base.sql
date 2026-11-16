-- FLUXOGRAMA: entrada (a leitura do #14359 manda as marcações ATENDIDAS com o nome do profissional; o dono liga a regra e escolhe a(s) médica(s) em Configurações > Primeira consulta com a médica)
--   -> validação (regra desligada, lista vazia ou conversa que não é consulta = nada muda; médica não listada = marca como hoje)
--   -> lógica (primeira_consulta_ok: o paciente já foi ATENDIDO por essa médica? histórico em consulta_feita pelo prontuário do vínculo CPF+nascimento; ou liberado à mão pela atendente)
--   -> saída (bloqueia = true: o chat avisa, passa para a atendente e NÃO marca; false: segue o fluxo normal)
-- Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial. Pedido do dono: primeira consulta com a médica só com atendente; quem já foi atendido por ela marca sozinho.
-- Nasce DESLIGADA (primeira_consulta_modo = nao). Só ligar depois de carregar o histórico (modo "historico" da sync-jornada-klingo) e conferir a contagem de consulta_feita.
-- Sem "drop": a ferramenta de migração pede confirmação e expira em 60 s. Idempotente.
-- ROLLBACK: update public.config set valor = 'nao' where chave = 'primeira_consulta_modo'; (desliga na hora). Para remover: recriar fluxo_proximo, fluxo_perguntar e klingo_pode_marcar a partir de supabase/producao/funcoes/ e apagar as tabelas consulta_feita e primeira_consulta_liberada.
-- Privacidade: guarda só prontuário (já é a chave da Jornada), nome do profissional, procedimento e data. Nada de nome/CPF/telefone do paciente. RLS ligada, sem política: só funções security definer.

-- ===== Parte 1a: tabelas e chaves =====
create table if not exists public.consulta_feita (
  marcacao_id text primary key,                 -- id da marcação no Klingo (col0 do #14359)
  prontuario text not null,
  profissional text not null,                   -- como vem do Klingo ("Profissional")
  procedimento text,
  atendido_em date not null,                    -- dia do atendimento (Data Agendado Para)
  atualizado_em timestamptz not null default now()
);
create index if not exists consulta_feita_prontuario_idx on public.consulta_feita (prontuario);
alter table public.consulta_feita enable row level security;
revoke all on public.consulta_feita from anon, authenticated;
comment on table public.consulta_feita is 'Atendimentos já feitos (Atendido = S no #14359) com o profissional. Base da regra "primeira consulta só com atendente". Sem dado pessoal além do prontuário.';

create table if not exists public.primeira_consulta_liberada (
  chave text primary key,                       -- klingo_hash(cpf|nascimento): a atendente confirmou que o paciente já foi atendido pela médica
  liberado_por uuid,
  liberado_em timestamptz not null default now()
);
alter table public.primeira_consulta_liberada enable row level security;
revoke all on public.primeira_consulta_liberada from anon, authenticated;
comment on table public.primeira_consulta_liberada is 'Pacientes liberados à mão pela atendente (o Klingo não mostrou o atendimento anterior). Chave = hash de CPF+nascimento.';

insert into public.config (chave, valor) values
  ('primeira_consulta_modo', 'nao'),
  ('primeira_consulta_medicas', 'GEANNE CHRISTINA PINHEIRO')
on conflict (chave) do nothing;

-- ===== Parte 1b: leitura do histórico (chamada só pela Edge Function sync-jornada-klingo) =====
-- p_linhas: [{m: id da marcação, p: prontuário, q: profissional, x: procedimento, d: 'AAAA-MM-DD...'}] só de quem tem Atendido = S.
create or replace function public.consulta_feita_lote(p_linhas jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $f$
declare r jsonb; n integer := 0; v integer;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then raise exception 'O lote precisa ser uma lista.'; end if;
  for r in select x from jsonb_array_elements(p_linhas) x loop
    if coalesce(r ->> 'm', '') = '' or coalesce(r ->> 'p', '') = '' or r ->> 'p' like 'n:%' or coalesce(btrim(r ->> 'q'), '') = ''
       or coalesce(r ->> 'd', '') !~ '^\d{4}-\d{2}-\d{2}' then continue; end if;
    insert into public.consulta_feita as c (marcacao_id, prontuario, profissional, procedimento, atendido_em)
    values (left(r ->> 'm', 40), left(r ->> 'p', 40), left(btrim(r ->> 'q'), 120), nullif(left(btrim(coalesce(r ->> 'x', '')), 200), ''), (left(r ->> 'd', 10))::date)
    on conflict (marcacao_id) do update set prontuario = excluded.prontuario, profissional = excluded.profissional, procedimento = excluded.procedimento,
      atendido_em = excluded.atendido_em, atualizado_em = now()
    where (c.prontuario, c.profissional, c.procedimento, c.atendido_em) is distinct from (excluded.prontuario, excluded.profissional, excluded.procedimento, excluded.atendido_em);
    get diagnostics v = row_count; n := n + v;
  end loop;
  return jsonb_build_object('gravadas', n);
end $f$;
revoke all on function public.consulta_feita_lote(jsonb) from public, anon, authenticated;
grant execute on function public.consulta_feita_lote(jsonb) to service_role;
