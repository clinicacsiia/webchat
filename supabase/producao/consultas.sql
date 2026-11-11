-- FLUXOGRAMA: entrada (o banco de produção, lido pelo conector do Supabase) -> validação (só catálogo do Postgres: nenhuma linha de tabela de negócio; de public.config saem só os NOMES das chaves) -> lógica (duas consultas que devolvem um JSON cada) -> saída (os dois arquivos que supabase/producao/gerar.py transforma no retrato)
-- Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial
--
-- Como refazer o retrato (peça ao Claude: "atualize o retrato da produção"):
--   1. Rodar a CONSULTA 1 (em 4 fatias, pelo nome da função, porque o resultado é grande) e a CONSULTA 2 pelo conector do Supabase (execute_sql).
--   2. Juntar o resultado da consulta 1 num arquivo funcoes.json (lista) e o da consulta 2 em estrutura.json (objeto "retrato").
--   3. python3 supabase/producao/gerar.py funcoes.json estrutura.json
--   4. cd testes && npm run test:retrato && npm run test:producao-sql && npm run test:ponta-a-ponta
-- O gerador RECUSA gravar se achar e-mail, telefone, chave ou token no texto.

-- ===== CONSULTA 1: funções (repetir com os filtros: < 'chat_i' | >= 'chat_i' e < 'fluxo_p' | >= 'fluxo_p' e < 'medico' | >= 'medico') =====
select jsonb_agg(jsonb_build_object(
  'n', p.proname, 'a', pg_get_function_identity_arguments(p.oid), 'k', p.prokind, 'def', pg_get_functiondef(p.oid),
  'anon', has_function_privilege('anon', p.oid, 'execute'), 'auth', has_function_privilege('authenticated', p.oid, 'execute'),
  'srv', has_function_privilege('service_role', p.oid, 'execute'), 'pub', coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), p.proacl is null)
) order by p.proname, pg_get_function_identity_arguments(p.oid)) as funcoes
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind in ('f','p') and p.proname < 'chat_i';

-- ===== CONSULTA 2: tabelas, visões, gatilhos, regras de acesso, rotinas, tempo real, nomes das chaves de config =====
select jsonb_build_object(
 'gerado_em', now(),
 'versao_pg', current_setting('server_version'),
 'extensoes', (select jsonb_agg(jsonb_build_object('nome', e.extname, 'esquema', n.nspname, 'versao', e.extversion) order by e.extname) from pg_extension e join pg_namespace n on n.oid = e.extnamespace),
 'tabelas', (select jsonb_agg(jsonb_build_object(
     'nome', c.relname, 'rls', c.relrowsecurity, 'comentario', obj_description(c.oid),
     'colunas', (select jsonb_agg(jsonb_build_object('nome', a.attname, 'tipo', format_type(a.atttypid, a.atttypmod), 'nn', a.attnotnull,
                    'padrao', pg_get_expr(d.adbin, d.adrelid), 'identidade', nullif(a.attidentity, ''), 'gerada', nullif(a.attgenerated, '')) order by a.attnum)
                   from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
     'restricoes', (select jsonb_agg(jsonb_build_object('nome', k.conname, 'tipo', k.contype, 'def', pg_get_constraintdef(k.oid)) order by k.contype, k.conname) from pg_constraint k where k.conrelid = c.oid),
     'indices', (select jsonb_agg(pg_get_indexdef(i.indexrelid) order by i.indexrelid::regclass::text) from pg_index i where i.indrelid = c.oid and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid)),
     'politicas', (select jsonb_agg(jsonb_build_object('nome', p.policyname, 'cmd', p.cmd, 'papeis', p.roles, 'permissiva', p.permissive, 'usando', p.qual, 'checando', p.with_check) order by p.policyname) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname),
     'gatilhos', (select jsonb_agg(pg_get_triggerdef(t.oid) order by t.tgname) from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal),
     'concessoes', (select jsonb_object_agg(g.grantee, g.privs) from (select grantee, string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where table_schema = 'public' and table_name = c.relname and grantee in ('anon', 'authenticated') group by grantee) g)
   ) order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'),
 'visoes', (select jsonb_agg(jsonb_build_object('nome', c.relname, 'tipo', c.relkind, 'opcoes', c.reloptions, 'def', pg_get_viewdef(c.oid, true),
     'concessoes', (select jsonb_object_agg(g.grantee, g.privs) from (select grantee, string_agg(privilege_type, ',' order by privilege_type) as privs from information_schema.role_table_grants where table_schema = 'public' and table_name = c.relname and grantee in ('anon', 'authenticated') group by grantee) g),
     'indices', (select jsonb_agg(pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid = c.oid)) order by c.relname)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('v', 'm')),
 'tipos', (select jsonb_agg(jsonb_build_object('nome', t.typname, 'valores', (select jsonb_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)) order by t.typname) from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype = 'e'),
 'sequencias', (select jsonb_agg(c.relname order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'S'),
 'tempo_real', (select jsonb_agg(schemaname || '.' || tablename order by tablename) from pg_publication_tables where pubname = 'supabase_realtime'),
 'rotinas', (select jsonb_agg(jsonb_build_object('nome', jobname, 'quando', schedule, 'ativa', active, 'comando', command) order by jobname) from cron.job),
 'config_chaves', (select jsonb_agg(chave order by chave) from public.config),
 'limites', (select jsonb_agg(jsonb_build_object('papel', r.rolname, 'config', r.rolconfig) order by r.rolname) from pg_roles r where r.rolname in ('anon', 'authenticated', 'authenticator', 'service_role'))
) as retrato;
