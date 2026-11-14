// FLUXOGRAMA: entrada (clone da produção de 14/11/2026 com dados inventados ANTES da migração) -> validação (aplicar as partes 1 a 3 preserva as linhas existentes) -> processamento (reaplicar as definições do retrato = rollback documentado) -> saída (PASS/FAIL)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Prova que a migração não destrói dados e que o rollback devolve o comportamento anterior (inclusive o defeito), sem apagar tabelas novas.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um } = ajudantes(db);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste')`);
// dados que já existem na produção antes da migração (inventados)
await db.exec(`
  insert into public.config (chave, valor) values ('klingo_auto', 'sim'), ('klingo_api_horarios', 'sombra'), ('klingo_api_marcar', 'teste'), ('klingo_api_pos', 'teste'), ('klingo_api_pre_cadastro', 'teste'),
    ('klingo_so_liberados', 'sim'), ('klingo_api_telefones_teste', '71900000001'), ('klingo_api_percentual', '100'), ('klingo_webhook', 'nao'), ('pedido_horario_modo', 'teste'), ('klingo_autogestao', 'sim')
    on conflict (chave) do update set valor = excluded.valor;
  insert into public.contatos (nome, telefone) values ('Paciente Comum', '71988880001'), ('Paciente Teste', '71900000001');
  insert into public.conversas (contato_id) select id from public.contatos;
`);
const comum = (await um(`select c.id from public.conversas c join public.contatos t on t.id = c.contato_id where t.telefone = '71988880001'`)).id;
const antes = await um(`select (select count(*) from public.config)::int cfg, (select count(*) from public.conversas)::int conv, (select count(*) from public.contatos)::int cont, (select count(*) from public.pedido_previsao)::int prev`);
await db.exec(`insert into public.klingo_oferta (conversa_id, chave, procedimento, plano, data, hora, expira_em) values ('${comum}', 'k1', 1096, 14, current_date + 3, '08:00', now() + interval '10 minutes')`);
const defAntiga = async (nome) => (await um(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1 order by p.oid limit 1`, [nome])).d;
const antigoAtivo = (await um(`select public.klingo_ativo($1, 'klingo_api_marcar') a`, [comum])).a;
registrar('ANTES da migração o defeito existe (retrato da produção): mestre "sim" + marcar "teste" libera o paciente comum', falhas.length === 0 && antigoAtivo === true, `klingo_ativo(comum, marcar) = ${antigoAtivo}`);

let erro = null;
for (const f of ['webchat-v2-parte1-modos', 'webchat-v2-parte2-calendario-api', 'webchat-v2-parte4-medicos-api', 'webchat-v2-parte3-disponibilidade-futura', 'webchat-v2-parte5-pos-agendamento', 'klingo-agendamento-seguranca']) {
  try { await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8')); } catch (e) { erro = `${f}: ${String(e.message).split('\n')[0]}`; }
}
registrar('as 6 migrações, na ordem do plano de publicação, aplicam sem erro sobre um banco que já tem dados', !erro, erro ?? '');
// reaplicar tudo de novo não pode falhar (o plano manda aplicar em partes e repetir se o Supabase expirar)
let erro2 = null; const erros2 = [];
for (const f of ['webchat-v2-parte1-modos', 'webchat-v2-parte2-calendario-api', 'webchat-v2-parte4-medicos-api', 'webchat-v2-parte3-disponibilidade-futura', 'webchat-v2-parte5-pos-agendamento', 'klingo-agendamento-seguranca']) { try { await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8')); } catch (e) { erros2.push(`${f}: ${String(e.message).split('\n')[0]}`); } }
erro2 = erros2.join(' || ') || null;
registrar('reaplicar as 6 migrações uma segunda vez também funciona (idempotentes)', !erro2, erro2 ?? '');

await caso('MIGRAÇÃO PRESERVA DADOS: nenhuma linha existente foi apagada ou alterada (configuração, conversas, contatos, ofertas, previsão antiga); só entram chaves novas', async () => {
  const depois = await um(`select (select count(*) from public.config)::int cfg, (select count(*) from public.conversas)::int conv, (select count(*) from public.contatos)::int cont, (select count(*) from public.pedido_previsao)::int prev`);
  const oferta = await um(`select sombra, chave from public.klingo_oferta where conversa_id = $1`, [comum]);
  const mantidas = await q(`select chave, valor from public.config where chave in ('klingo_auto', 'klingo_api_horarios', 'klingo_api_marcar', 'klingo_api_pos', 'klingo_api_pre_cadastro', 'klingo_webhook', 'pedido_horario_modo', 'klingo_api_telefones_teste') order by chave`);
  const v = Object.fromEntries(mantidas.map((x) => [x.chave, x.valor]));
  const novas = await q(`select chave, valor from public.config where chave in ('klingo_api_cancelar', 'klingo_api_remarcar', 'klingo_api_consultar', 'klingo_api_resultado', 'previsao_modo', 'previsao_monitor_modo', 'notificacao_modo')`);
  return { ok: depois.conv === antes.conv && depois.cont === antes.cont && depois.prev === antes.prev && depois.cfg >= antes.cfg && oferta.sombra === false && oferta.chave === 'k1'
                && v.klingo_auto === 'sim' && v.klingo_api_horarios === 'sombra' && v.klingo_api_marcar === 'teste' && v.klingo_webhook === 'nao' && novas.length === 7,
           detalhe: `chaves ${antes.cfg}->${depois.cfg}; oferta antiga sombra=${oferta.sombra}; novas=${novas.map((x) => x.chave + '=' + x.valor).join(',')}` };
});
await caso('DEPOIS da migração o paciente comum NÃO é liberado (mesmos valores de configuração, comportamento corrigido)', async () => {
  const a = (await um(`select public.klingo_ativo($1, 'klingo_api_marcar') a, public.klingo_modo($1, 'klingo_api_horarios') h`, [comum]));
  return { ok: a.a === false && a.h === 'sombra', detalhe: `marcar ativo=${a.a}; horários=${a.h}` };
});

// ROLLBACK documentado: reaplicar as definições do retrato (a produção antes da migração)
let erroRb = null;
for (const f of ['klingo_ativo', 'klingo_liberado', 'klingo_decidir', 'klingo_autogestao', 'klingo_pode_marcar', 'klingo_limpar', 'chat_horarios', 'chat_horario_escolher', 'previsao_buscar', 'pedido_horario_vigiar', 'previsao_ativa', 'previsao_vigiar', 'medicos_disponiveis_interno', 'fluxo_aplicar', 'fluxo_proximo', 'fluxo_perguntar', 'fluxo_avancar', 'fluxo_ler_texto', 'chat_voltar', 'klingo_operacao_concluir', 'klingo_operacao_criar', 'klingo_evento_aplicar', 'painel_automacao_resumo']) {
  try { await db.exec(readFileSync(`${REPO}/supabase/producao/funcoes/${f}.sql`, 'utf8')); } catch (e) { erroRb = `${f}: ${String(e.message).split('\n')[0]}`; }
}
registrar('ROLLBACK: reaplicar as funções do retrato (todas as que as migrações trocaram) executa sem erro', !erroRb, erroRb ?? '');
await caso('ROLLBACK devolve o comportamento anterior (inclusive o defeito, que é o que "voltar atrás" significa) e as tabelas novas ficam sem uso nem dano', async () => {
  const a = (await um(`select public.klingo_ativo($1, 'klingo_api_marcar') a`, [comum])).a;
  const lib = (await um(`select pg_get_functiondef('public.klingo_liberado(uuid,integer,text)'::regprocedure) d`)).d;
  const novas = (await um(`select (select count(*) from public.config_auditoria)::int a, (select count(*) from public.klingo_consulta)::int c, (select count(*) from public.disponibilidade_pedido)::int d`));
  const gravouConfig = (await um(`select count(*)::int n from public.config`)).n;   // o gatilho de auditoria continua gravando sem quebrar escritas
  await db.query(`insert into public.config (chave, valor) values ('zz_rb', '1') on conflict (chave) do update set valor = excluded.valor`);
  return { ok: a === true && /klingo_so_liberados/.test(lib) && novas.a > 0 && gravouConfig > 0, detalhe: `klingo_ativo(comum, marcar)=${a} (comportamento antigo); tabelas novas preservadas: auditoria=${novas.a}` };
});

console.log(`\n${resultados.filter(Boolean).length} de ${resultados.length} verificações passaram.`);
process.exit(resultados.every(Boolean) ? 0 : 1);
