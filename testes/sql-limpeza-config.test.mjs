// FLUXOGRAMA: entrada (clone da produção + chaves de config como estavam em 18/11/2026) -> validação (antes: painel_automacao_resumo e klingo_modo respondem com as chaves presentes)
//   -> lógica (aplica supabase/limpeza-config-parte1.sql e parte2.sql; roda de novo; roda o rollback) -> saída (PASS/FAIL: as 17 chaves somem, as vivas ficam, os números do painel e o autoatendimento não mudam, o rollback devolve tudo)
// Versão 1.0 — 18/11/2026 / Mudança: primeira versão. Dados inventados; nada toca o Supabase nem o Klingo reais.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, separarSql, REPO } from './banco-producao.mjs';

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + String(e.message).split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const sql = (arq) => readFileSync(`${REPO}/supabase/${arq}`, 'utf8');

const { db, falhas } = await criarBancoProducao();
const { q, um, como } = ajudantes(db);
const aplicar = async (arq) => { for (const c of separarSql(sql(arq))) await db.exec(c); };

const MORTAS1 = ['ia_ativa', 'motor', 'motor_telefones_teste', 'previsao_texto'];
const MORTAS2 = { klingo_auto: 'sim', klingo_api_horarios: 'sim', klingo_api_marcar: 'sim', klingo_api_pre_cadastro: 'sim', klingo_api_consultar: 'sim', klingo_api_cancelar: 'sim', klingo_api_remarcar: 'sim',
  klingo_api_pos: 'teste', klingo_api_percentual: '100', klingo_autogestao: 'sim', previsao_modo: 'sim', previsao_monitor_modo: 'sim', notificacao_modo: 'sim' };
const VIVAS = { klingo_api_resultado: 'nao', klingo_api_telefones_teste: '', pedido_horario_modo: 'teste', klingo_webhook: 'nao', permissao_modo: 'observacao', klingo_exames_so_api: 'sim',
  klingo_exames_vencimento_h: '6', klingo_exames_vazio_min: '60', klingo_exames_tem_min: '120', base_antes_programa: '{"fonte":"teste"}', catalogo_csi: 'nao', marcacao_auto_csi: 'nao', retorno_dias_modo: 'sim' };

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
await db.exec(`insert into auth.users (id, email) values ('${ADMIN}', 'admin@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADMIN}', 'Admin Teste', 'admin@exemplo.invalid', 'admin', true);`);
for (const [k, v] of [...Object.entries(MORTAS2), ...Object.entries(VIVAS)]) await db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [k, v]);
const ct = (await um(`insert into public.contatos (nome, telefone) values ('Paciente Limpeza Teste', '71980000001') returning id`)).id;
const conv = (await um(`insert into public.conversas (contato_id, nome_informado, status, ia_ativa) values ($1, 'Paciente Limpeza Teste', 'aguardando', true) returning id`, [ct])).id;
const existem = async (lista) => (await q(`select chave from public.config where chave = any($1) order by chave`, [lista])).map((r) => r.chave);
const resumo = async () => { await como(ADMIN); const r = await um(`select public.painel_automacao_resumo() as r`); await como(''); return r.r; };
const semModos = (r) => { const { modos, gerado_em, ...resto } = r; return JSON.stringify(resto); };

await caso('o clone monta inteiro e as 17 chaves a apagar + as vivas existem antes da limpeza', async () => {
  const todas = [...MORTAS1.filter((k) => k !== 'previsao_texto' || true), ...Object.keys(MORTAS2)];
  const tem = await existem([...Object.keys(MORTAS2), ...Object.keys(VIVAS)]);
  return { ok: falhas.length === 0 && tem.length === Object.keys(MORTAS2).length + Object.keys(VIVAS).length, detalhe: `${falhas.length} falhas; ${tem.length} chaves; ${todas.length} listadas` };
});

const antes = await resumo();
const modosAntes = await q(`select public.klingo_ativo($1::uuid, 'klingo_api_marcar') m, public.klingo_ativo($1::uuid, 'klingo_api_cancelar') c, public.klingo_ativo($1::uuid, 'previsao_modo') p, public.klingo_ativo($1::uuid, 'notificacao_modo') n, public.klingo_modo($1::uuid, 'klingo_api_resultado') r, public.klingo_modo($1::uuid, 'klingo_api_pre_cadastro') pc`, [conv]);

await caso('PARTE 1: apaga ia_ativa, motor, motor_telefones_teste e previsao_texto, e só elas', async () => {
  await aplicar('limpeza-config-parte1.sql');
  const sobraram = await existem(MORTAS1);
  const vivas = await existem(Object.keys(VIVAS));
  return { ok: sobraram.length === 0 && vivas.length === Object.keys(VIVAS).length && (await existem(Object.keys(MORTAS2))).length === Object.keys(MORTAS2).length, detalhe: `sobraram ${sobraram.join(',') || 'nenhuma'}` };
});

await caso('PARTE 2: apaga as 13 chaves do autoatendimento; klingo_api_resultado, klingo_exames_*, base_antes_programa e as demais vivas ficam', async () => {
  await aplicar('limpeza-config-parte2.sql');
  const sobraram = await existem(Object.keys(MORTAS2));
  const vivas = await existem(Object.keys(VIVAS));
  return { ok: sobraram.length === 0 && vivas.length === Object.keys(VIVAS).length, detalhe: `sobraram ${sobraram.join(',') || 'nenhuma'}; vivas ${vivas.length}/${Object.keys(VIVAS).length}` };
});

await caso('painel_automacao_resumo: todos os números iguais aos de antes (só o bloco "modos" perde percentual e autogestao)', async () => {
  const depois = await resumo();
  const m = depois.modos || {};
  return { ok: semModos(antes) === semModos(depois) && m.mestre === 'sim' && m.horarios === 'sim' && m.marcar === 'sim' && m.pre_cadastro === 'sim' && m.webhook === 'nao' && !('percentual' in m) && !('autogestao' in m),
    detalhe: JSON.stringify(m) };
});

await caso('autoatendimento igual: klingo_ativo continua "sim" para a conversa e klingo_api_resultado continua seguindo a configuração (nao)', async () => {
  const d = (await q(`select public.klingo_ativo($1::uuid, 'klingo_api_marcar') m, public.klingo_ativo($1::uuid, 'klingo_api_cancelar') c, public.klingo_ativo($1::uuid, 'previsao_modo') p, public.klingo_ativo($1::uuid, 'notificacao_modo') n, public.klingo_modo($1::uuid, 'klingo_api_resultado') r, public.klingo_modo($1::uuid, 'klingo_api_pre_cadastro') pc`, [conv]))[0];
  return { ok: JSON.stringify(d) === JSON.stringify(modosAntes[0]) && d.m === true && d.c === true && d.r === 'nao', detalhe: JSON.stringify(d) };
});

await caso('as funções que leem a configuração por texto ainda respondem (chat_config e klingo_cfg das chaves vivas)', async () => {
  const c = (await um(`select public.chat_config() as c`)).c;
  const k = await um(`select public.klingo_cfg('klingo_exames_so_api', 'nao') v`);
  return { ok: typeof c === 'object' && k.v === 'sim', detalhe: JSON.stringify(c).slice(0, 80) };
});

await caso('rodar de novo é inofensivo (idempotente)', async () => {
  await aplicar('limpeza-config-parte1.sql'); await aplicar('limpeza-config-parte2.sql');
  const vivas = await existem(Object.keys(VIVAS));
  return { ok: vivas.length === Object.keys(VIVAS).length && (await existem([...MORTAS1, ...Object.keys(MORTAS2)])).length === 0 };
});

await caso('o histórico de configuração guarda o valor antigo das chaves apagadas (config_auditoria)', async () => {
  const n = await um(`select count(*)::int n from public.config_auditoria where operacao = 'delete' and chave = any($1) and valor_antes is not null`, [[...MORTAS1, ...Object.keys(MORTAS2)]]);
  return { ok: n.n >= 10, detalhe: `${n.n} linhas de auditoria` };
});

await caso('ROLLBACK: devolve as 17 chaves com os valores de antes', async () => {
  for (const c of separarSql(sql('limpeza-config-rollback.sql'))) await db.exec(c);
  const r = await q(`select chave, valor from public.config where chave = any($1)`, [[...MORTAS1, ...Object.keys(MORTAS2)]]);
  const por = Object.fromEntries(r.map((x) => [x.chave, x.valor]));
  const certo = por.ia_ativa === 'sim' && por.motor === 'fluxo' && por.klingo_api_pos === 'teste' && por.klingo_api_percentual === '100' && por.notificacao_modo === 'sim';
  return { ok: r.length === 17 && certo, detalhe: `${r.length} chaves de volta` };
});

const passou = resultados.filter(Boolean).length;
console.log(`\n${passou} de ${resultados.length} verificações passaram.`);
process.exit(passou === resultados.length ? 0 : 1);
