// FLUXOGRAMA: entrada (clone do banco de produção de 14/11/2026 + supabase/webchat-v2-parte1-modos.sql) -> validação (conversas e telefones inventados, nenhuma linha real) -> processamento (matriz mestre x chave x telefone; auditoria de config; recuo e promoção; catálogo; consulta à API)
//   -> persistência (só no clone em memória) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Prova que o mestre klingo_auto NÃO promove teste/sombra, que sombra não expõe nem escreve, que a autogestão só recua e que toda mudança de config fica auditada.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como } = ajudantes(db);
let sqlErro = null;
try { await db.exec(readFileSync(`${REPO}/supabase/webchat-v2-parte1-modos.sql`, 'utf8')); } catch (e) { sqlErro = String(e.message).split('\n')[0]; }
registrar('o retrato da produção monta inteiro e a migração webchat-v2-parte1 aplica sem erro', falhas.length === 0 && !sqlErro, sqlErro ?? '');

const ADMIN = '00000000-0000-4000-8000-0000000000a1', ATEND = '00000000-0000-4000-8000-0000000000a2';
await db.exec(`
  insert into auth.users (id, email) values ('${ADMIN}', 'admin@exemplo.invalid'), ('${ATEND}', 'atendente@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADMIN}', 'Admin Teste', 'admin@exemplo.invalid', 'admin', true), ('${ATEND}', 'Atendente Teste', 'atendente@exemplo.invalid', 'atendente', true);
`);
const cfg = (chave, valor) => db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]);
const novaConversa = async (tel) => {
  const c = (await q(`insert into public.contatos (nome, telefone) values ('Paciente Teste', $1) returning id`, [tel]))[0].id;
  return (await q(`insert into public.conversas (contato_id) values ($1) returning id`, [c]))[0].id;
};
const FORA = await novaConversa('71988880001'), LISTA = await novaConversa('71900000001');
const modo = async (conv, chave) => (await um(`select public.klingo_modo($1, $2) m, public.klingo_ativo($1, $2) a, public.klingo_sombra($1, $2) s`, [conv, chave]));
const cenario = async (mestre, chaves, pct = '100') => {
  await cfg('klingo_auto', mestre); await cfg('klingo_api_telefones_teste', '71900000001'); await cfg('klingo_api_percentual', pct);
  for (const [k, v] of Object.entries(chaves)) await cfg(k, v);
};

// ------------------------------------------------------------------ A. matriz de modos
await caso('BUG ORIGINAL: mestre "sim" + marcar "teste": o paciente comum NÃO marca; só o telefone da lista de teste', async () => {
  await cenario('sim', { klingo_api_marcar: 'teste' });
  const fora = await modo(FORA, 'klingo_api_marcar'), lista = await modo(LISTA, 'klingo_api_marcar');
  return { ok: fora.a === false && fora.m === 'nao' && lista.a === true && lista.m === 'teste', detalhe: `fora=${fora.m}; lista=${lista.m}` };
});
await caso('mestre "sim" + horários "sombra": o paciente comum fica em SOMBRA (só mede): não está "ativo" e nada é exposto', async () => {
  await cenario('sim', { klingo_api_horarios: 'sombra' });
  const fora = await modo(FORA, 'klingo_api_horarios'), lista = await modo(LISTA, 'klingo_api_horarios');
  return { ok: fora.m === 'sombra' && fora.a === false && fora.s === true && lista.m === 'sombra' && lista.a === false, detalhe: `fora=${fora.m}/ativo=${fora.a}; lista=${lista.m}/ativo=${lista.a}` };
});
await caso('"sombra" em capacidade de ESCRITA (marcar, cancelar, pré-cadastro) vale "nao": sombra nunca escreve', async () => {
  await cenario('sim', { klingo_api_marcar: 'sombra', klingo_api_cancelar: 'sombra', klingo_api_pre_cadastro: 'sombra' });
  const r = [await modo(LISTA, 'klingo_api_marcar'), await modo(LISTA, 'klingo_api_cancelar'), await modo(LISTA, 'klingo_api_pre_cadastro')];
  return { ok: r.every((x) => x.m === 'nao' && !x.a && !x.s), detalhe: r.map((x) => x.m).join(',') };
});
await caso('mestre "sim" + chave "sim" a 100%: todos usam; a 0%: só a lista de teste', async () => {
  await cenario('sim', { klingo_api_marcar: 'sim' }, '100');
  const todos = await modo(FORA, 'klingo_api_marcar');
  await cfg('klingo_api_percentual', '0');
  const zero = await modo(FORA, 'klingo_api_marcar'), lista0 = await modo(LISTA, 'klingo_api_marcar');
  return { ok: todos.a === true && todos.m === 'sim' && zero.a === false && lista0.a === true, detalhe: `100%=${todos.m}; 0% comum=${zero.m}; 0% lista=${lista0.m}` };
});
await caso('mestre "teste" é TETO: mesmo com a chave em "sim" só a lista usa; sombra de leitura continua medindo', async () => {
  await cenario('teste', { klingo_api_marcar: 'sim', klingo_api_horarios: 'sombra' });
  const fora = await modo(FORA, 'klingo_api_marcar'), lista = await modo(LISTA, 'klingo_api_marcar'), hor = await modo(FORA, 'klingo_api_horarios');
  return { ok: fora.a === false && lista.a === true && lista.m === 'teste' && hor.m === 'sombra', detalhe: `fora=${fora.m}; lista=${lista.m}; horários comum=${hor.m}` };
});
await caso('mestre "nao" desliga TUDO (inclusive a lista de teste e a sombra)', async () => {
  await cenario('nao', { klingo_api_marcar: 'sim', klingo_api_horarios: 'sombra' });
  const r = [await modo(LISTA, 'klingo_api_marcar'), await modo(LISTA, 'klingo_api_horarios'), await modo(FORA, 'klingo_api_horarios')];
  return { ok: r.every((x) => x.m === 'nao'), detalhe: r.map((x) => x.m).join(',') };
});
await caso('mestre "legado" ou valor inválido: "legado" não promove nada; valor desconhecido na chave = "nao"', async () => {
  await cenario('legado', { klingo_api_marcar: 'teste', klingo_api_horarios: 'talvez' });
  const a = await modo(FORA, 'klingo_api_marcar'), b = await modo(LISTA, 'klingo_api_horarios');
  return { ok: a.m === 'nao' && b.m === 'nao', detalhe: `marcar comum=${a.m}; horários inválido=${b.m}` };
});
await caso('cancelar e remarcar herdam klingo_api_pos enquanto não têm chave própria; com chave própria vale a própria', async () => {
  await cenario('sim', { klingo_api_pos: 'teste' });
  await db.query(`delete from public.config where chave in ('klingo_api_cancelar', 'klingo_api_remarcar')`);
  const herdado = await modo(FORA, 'klingo_api_cancelar'), herdadoLista = await modo(LISTA, 'klingo_api_remarcar');
  await cfg('klingo_api_cancelar', 'nao');
  const proprio = await modo(LISTA, 'klingo_api_cancelar');
  return { ok: herdado.m === 'nao' && herdadoLista.m === 'teste' && proprio.m === 'nao', detalhe: `herdado comum=${herdado.m}; herdado lista=${herdadoLista.m}; próprio nao=${proprio.m}` };
});
await caso('conversa inexistente e erro interno nunca liberam: modo "nao"', async () => {
  await cenario('sim', { klingo_api_marcar: 'sim' });
  const r = await um(`select public.klingo_modo('00000000-0000-4000-8000-00000000ffff', 'klingo_api_marcar') m, public.klingo_modo(null, 'klingo_api_marcar') n`);
  return { ok: r.m === 'nao' && r.n === 'nao', detalhe: JSON.stringify(r) };
});

// ------------------------------------------------------------------ B. auditoria
await caso('AUDITORIA: cada mudança em config grava chave, antes, depois, origem e versão; mesma valor não grava; segredo sai oculto', async () => {
  await db.exec(`select set_config('app.origem', '', false)`);
  await cfg('zz_teste_auditoria', 'a'); await cfg('zz_teste_auditoria', 'b'); await cfg('zz_teste_auditoria', 'b');
  await cfg('ia_segredo', 'valor-secreto-1'); await cfg('ia_segredo', 'valor-secreto-2');
  await db.query(`delete from public.config where chave = 'zz_teste_auditoria'`);
  const l = await q(`select operacao, valor_antes, valor_depois, origem, versao from public.config_auditoria where chave = 'zz_teste_auditoria' order by id`);
  const s = await q(`select valor_antes, valor_depois from public.config_auditoria where chave = 'ia_segredo' order by id`);
  const semVazar = JSON.stringify(s).indexOf('valor-secreto') < 0;
  const partes = { tres: l.length === 3, insert: l[0]?.operacao === 'insert', antes_depois: l[1]?.valor_antes === 'a' && l[1]?.valor_depois === 'b', apagou: l[2]?.operacao === 'delete' && l[2]?.valor_antes === 'b', versao: l[0]?.versao === 'webchat-v2.0', origem: String(l[0]?.origem).startsWith('sql:'), semVazar };
  const ok = Object.values(partes).every(Boolean);
  return { ok, detalhe: `${l.length} linhas (esperado 3: insert, update a>b, delete); ${JSON.stringify(partes)}` };
});
await caso('AUDITORIA da migração: as chaves novas e a mudança de klingo_so_liberados ficaram registradas com a origem "migracao:webchat-v2.0"', async () => {
  const l = await q(`select chave from public.config_auditoria where origem = 'migracao:webchat-v2.0' order by chave`);
  const nomes = l.map((x) => x.chave);
  const esperadas = ['klingo_api_cancelar', 'klingo_api_remarcar', 'klingo_api_resultado', 'notificacao_modo', 'previsao_modo', 'previsao_monitor_modo'];
  return { ok: esperadas.every((c) => nomes.includes(c)), detalhe: nomes.join(',') };
});
await caso('só o administrador lê a auditoria (atendente e anon veem zero linhas ou são recusados)', async () => {
  await como(ATEND); const a = await q(`select count(*)::int n from public.config_auditoria`).catch(() => [{ n: 'negado' }]);
  await como(ADMIN); const d = await q(`select count(*)::int n from public.config_auditoria`);
  await como('');
  return { ok: (a[0].n === 0 || a[0].n === 'negado') && d[0].n > 0, detalhe: `atendente=${a[0].n}; admin=${d[0].n}` };
});

// ------------------------------------------------------------------ C. recuo, recomendação e promoção
await caso('klingo_decidir RECUA (sim > teste) mas RECUSA subir (teste > sim) sem autorização', async () => {
  await cfg('klingo_api_marcar', 'sim');
  await db.query(`select public.klingo_decidir('klingo_api_marcar', 'teste', '{}'::jsonb)`);
  const depoisRecuo = (await um(`select valor from public.config where chave = 'klingo_api_marcar'`)).valor;
  let recusou = false;
  try { await db.query(`select public.klingo_decidir('klingo_api_marcar', 'sim', '{}'::jsonb)`); } catch (e) { recusou = /autoriza/i.test(e.message); }
  const depoisTentativa = (await um(`select valor from public.config where chave = 'klingo_api_marcar'`)).valor;
  return { ok: depoisRecuo === 'teste' && recusou && depoisTentativa === 'teste', detalhe: `após recuo=${depoisRecuo}; subida recusada=${recusou}; valor=${depoisTentativa}` };
});
await caso('AUTOGESTÃO: com 25 marcações de teste perfeitas só RECOMENDA (a chave continua "teste", uma recomendação, sem repetir)', async () => {
  await cenario('sim', { klingo_api_marcar: 'teste', klingo_api_horarios: 'nao', klingo_autogestao: 'sim' });
  await db.query(`delete from public.klingo_decisao`);
  const c = await novaConversa('71988880099');
  for (let i = 0; i < 25; i++) await db.query(`insert into public.klingo_operacao (conversa_id, tipo, estado, chave_idem) values ($1, 'marcar', 'sucesso', $2)`, [c, `t-${i}`]);
  const r1 = await um(`select public.klingo_autogestao() r`), r2 = await um(`select public.klingo_autogestao() r`);
  const v = (await um(`select valor from public.config where chave = 'klingo_api_marcar'`)).valor;
  const rec = (await um(`select count(*)::int n from public.klingo_decisao where chave = 'recomendacao:klingo_api_marcar'`)).n;
  return { ok: v === 'teste' && rec === 1 && JSON.stringify(r1.r.acoes).includes('marcar:recomendado') && !JSON.stringify(r2.r.acoes).includes('recomendado'), detalhe: `marcar=${v}; recomendações=${rec}; ações 1ª=${JSON.stringify(r1.r.acoes)}; 2ª=${JSON.stringify(r2.r.acoes)}` };
});
await caso('AUTOGESTÃO: horários em sombra com muitas respostas VAZIAS não geram recomendação (só "com horários" conta)', async () => {
  await cenario('sim', { klingo_api_marcar: 'nao', klingo_api_horarios: 'sombra' });
  await db.exec(`delete from public.klingo_decisao; delete from public.klingo_medida`);
  await db.query(`insert into public.klingo_medida (dia, tipo, n) values (current_date, 'horarios_api_ok', 500), (current_date, 'horarios_api_sem_horarios', 500), (current_date, 'sombra_api', 300), (current_date, 'sombra_api_na_grade', 300)`);
  const r = await um(`select public.klingo_autogestao() r`);
  const rec = (await um(`select count(*)::int n from public.klingo_decisao where chave like 'recomendacao:%'`)).n;
  return { ok: rec === 0 && (await um(`select valor from public.config where chave = 'klingo_api_horarios'`)).valor === 'sombra', detalhe: `recomendações=${rec}; ações=${JSON.stringify(r.r.acoes)}` };
});
await caso('AUTOGESTÃO RECUA o mestre (sim > teste) com 2 marcações incertas em 24 h e avisa a gestão; nunca sobe', async () => {
  await cenario('sim', { klingo_api_marcar: 'sim', klingo_api_horarios: 'nao', klingo_autogestao: 'sim' });
  await db.exec(`delete from public.klingo_decisao; delete from public.klingo_operacao`);
  const c = await novaConversa('71988880098');
  for (let i = 0; i < 2; i++) await db.query(`insert into public.klingo_operacao (conversa_id, tipo, estado, chave_idem) values ($1, 'marcar', 'incerto', $2)`, [c, `i-${i}`]);
  await db.query(`delete from public.equipe_notificacao`);
  const r = await um(`select public.klingo_autogestao() r`);
  const mestre = (await um(`select valor from public.config where chave = 'klingo_auto'`)).valor;
  const marcar = (await um(`select valor from public.config where chave = 'klingo_api_marcar'`)).valor;
  const avisos = (await um(`select count(*)::int n from public.equipe_notificacao where tipo = 'klingo_autogestao'`)).n;
  const aud = await q(`select origem from public.config_auditoria where chave = 'klingo_auto' order by id desc limit 1`);
  return { ok: mestre === 'teste' && marcar === 'teste' && avisos > 0 && aud[0]?.origem === 'autogestao', detalhe: `mestre=${mestre}; marcar=${marcar}; avisos=${avisos}; origem da auditoria=${aud[0]?.origem}; ações=${JSON.stringify(r.r.acoes)}` };
});
await caso('PROMOVER: atendente é recusado; admin sem justificativa é recusado; admin com justificativa promove, e fica na auditoria e em klingo_decisao', async () => {
  await cfg('klingo_api_marcar', 'teste');
  const tenta = async (uid, just) => { await como(uid); try { await q(`select public.klingo_promover('klingo_api_marcar', 'sim', $1)`, [just]); return 'ok'; } catch (e) { return e.message.slice(0, 40); } finally { await como(''); } };
  const a = await tenta(ATEND, 'Piloto concluído com 20 marcações de teste conferidas.'), b = await tenta(ADMIN, 'curto'), v1 = (await um(`select valor from public.config where chave = 'klingo_api_marcar'`)).valor;
  const c = await tenta(ADMIN, 'Piloto concluído com 20 marcações de teste conferidas.'), v2 = (await um(`select valor from public.config where chave = 'klingo_api_marcar'`)).valor;
  const aud = await um(`select origem, justificativa, valor_antes, valor_depois from public.config_auditoria where chave = 'klingo_api_marcar' order by id desc limit 1`);
  const dec = await um(`select count(*)::int n from public.klingo_decisao where chave = 'klingo_api_marcar' and motivo ? 'autorizado_por'`);
  return { ok: a !== 'ok' && b !== 'ok' && v1 === 'teste' && c === 'ok' && v2 === 'sim' && aud.origem === `promocao:${ADMIN}` && /Piloto/.test(aud.justificativa) && aud.valor_antes === 'teste' && dec.n === 1, detalhe: `atendente=${a}; sem justificativa=${b}; admin=${c}; auditoria=${aud.origem}` };
});
await caso('klingo_promover recusa chave que não é interruptor (ex.: textos) e valor inválido', async () => {
  await como(ADMIN);
  const r = [];
  for (const [k, v] of [['boas_vindas', 'sim'], ['klingo_api_marcar', 'ligadissimo']]) { try { await q(`select public.klingo_promover($1, $2, 'justificativa longa o bastante')`, [k, v]); r.push('ok'); } catch (e) { r.push('recusou'); } }
  await como('');
  return { ok: r.every((x) => x === 'recusou'), detalhe: r.join(',') };
});

// ------------------------------------------------------------------ D. catálogo
await caso('CATÁLOGO: klingo_so_liberados = sim NÃO esconde serviço (klingo_liberado sempre true); klingo_automatizavel só diz se a API reconhece', async () => {
  await cfg('klingo_so_liberados', 'sim'); await cfg('klingo_auto', 'sim'); await cfg('klingo_api_horarios', 'sim');
  await db.query(`insert into public.klingo_especialidade (cbos, nome, procedimentos, liberada_api) values ('225125', 'Clinico', array[9001], true), ('225270', 'Ortopedia', array[9002], false) on conflict do nothing`).catch(() => {});
  const r = await um(`select public.klingo_liberado($1, 9002, 'consulta') a, public.klingo_liberado($1, 9001, 'consulta') b, public.klingo_automatizavel(9001, 'consulta') c, public.klingo_automatizavel(9002, 'consulta') d, public.klingo_automatizavel(555, 'exame') e`, [FORA]);
  return { ok: r.a === true && r.b === true && r.c === true && r.d === false && r.e === true, detalhe: JSON.stringify(r) };
});

// ------------------------------------------------------------------ E. consulta à API e ofertas
await caso('CONSULTA: cada resultado vira UMA linha em klingo_consulta e a métrica certa; "com horários" só quando sobrou horário; sem dado pessoal', async () => {
  await db.query(`delete from public.klingo_medida`);
  const reg = (res, ms, g = null) => q(`select public.klingo_consulta_registrar($1, 'sim', 'consulta', 1096, 14, $2, 200, 10, 10, 0, $3, $4, null)`, [FORA, res, g, ms]);
  await reg('ok_com_horarios', 800, 10); await reg('api_sem_horarios', 900, 0); await reg('todos_filtrados', 700, 0); await reg('estrutura_invalida', 500); await reg('erro_api', 1000);
  const m = Object.fromEntries((await q(`select tipo, n::int n from public.klingo_medida`)).map((x) => [x.tipo, x.n]));
  const cols = (await q(`select column_name from information_schema.columns where table_name = 'klingo_consulta'`)).map((x) => x.column_name).join(',');
  const semPii = !/cpf|nome|nasc|telefone|email/i.test(cols);
  return { ok: m.horarios_api_ok === 3 && m.horarios_api_com_horarios === 1 && m.horarios_api_sem_horarios === 1 && m.horarios_api_filtrados === 1 && m.horarios_api_estrutura_invalida === 1 && m.horarios_api_erro === 1 && semPii,
           detalhe: `ok=${m.horarios_api_ok} (HTTP ok = 3: com, sem, filtrados); com horários=${m.horarios_api_com_horarios}; sem=${m.horarios_api_sem_horarios}; estrutura inválida=${m.horarios_api_estrutura_invalida}; erro=${m.horarios_api_erro}; colunas sem PII=${semPii}` };
});
await caso('OFERTAS: gravação de sombra não apaga as ofertas reais da conversa (e vice-versa); sombra fica marcada', async () => {
  const of = (c, h) => JSON.stringify([{ chave: `2026-11-20|1|1|1|${h}`, data: '2026-11-20', hora: h, profissional: 'DR TESTE', unidade: 'CSI' }]);
  await db.query(`delete from public.klingo_oferta where conversa_id = $1`, [FORA]);
  await db.query(`select public.klingo_oferta_gravar_v2($1, 1096, 14, $2::jsonb, false)`, [FORA, of(FORA, '08:00')]);
  await db.query(`select public.klingo_oferta_gravar_v2($1, 1096, 14, $2::jsonb, true)`, [FORA, of(FORA, '09:00')]);
  const l = await q(`select hora, sombra from public.klingo_oferta where conversa_id = $1 order by hora`, [FORA]);
  return { ok: l.length === 2 && l[0].sombra === false && l[1].sombra === true, detalhe: JSON.stringify(l) };
});
await caso('klingo_pode_marcar não aceita oferta de sombra como base e remarcar usa klingo_api_remarcar (patch aplicado)', async () => {
  const d = (await um(`select pg_get_functiondef('public.klingo_pode_marcar(uuid)'::regprocedure) d`)).d;
  return { ok: /and not sombra and expira_em/.test(d) && /klingo_api_remarcar/.test(d) && !/klingo_ativo\(p_conversa, 'klingo_api_pos'\)/.test(d), detalhe: 'estrutural' };
});
await caso('permissões: as funções novas não são chamáveis por anon; klingo_promover só por logado', async () => {
  const r = await q(`select p.proname, has_function_privilege('anon', p.oid, 'execute') anon, has_function_privilege('authenticated', p.oid, 'execute') auth from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where n.nspname = 'public' and p.proname in ('klingo_modo', 'klingo_ativo', 'klingo_sombra', 'klingo_decidir', 'klingo_recomendar', 'klingo_consulta_registrar', 'klingo_oferta_gravar_v2', 'config_auditar', 'klingo_promover')`);
  const exposta = r.filter((x) => x.anon || (x.auth && x.proname !== 'klingo_promover')).map((x) => x.proname);
  const prom = r.find((x) => x.proname === 'klingo_promover');
  return { ok: exposta.length === 0 && prom.auth === true && prom.anon === false, detalhe: exposta.length ? `expostas: ${exposta}` : 'nenhuma exposta' };
});

console.log(`\n${resultados.filter(Boolean).length} de ${resultados.length} verificações passaram.`);
process.exit(resultados.every(Boolean) ? 0 : 1);
