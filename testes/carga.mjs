// FLUXOGRAMA: entrada (variáveis CARGA_*; sem CARGA_CONFIRMO=SIM só roda no servidor simulado) -> validação (trava de segurança contra a produção, limite de usuários) -> lógica (N pacientes virtuais fazem o mesmo que o chat: config, iniciar, listar a cada 4 s, responder opção ou escrever; mais provas das travas de proteção) -> saída (tabela de tempos por chamada, erros por código, veredito e código de saída 0/1)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
//
// Teste de carga do chat: 100 pacientes simultâneos (padrão) chamando as MESMAS funções RPC que o index.html chama.
// Não usa navegador: mede o servidor (PostgREST + funções SQL do Supabase), que é onde o chat pode travar.
//
//   Simulado (seguro, não toca na produção):  npm run test:carga
//   Produção (cria conversas de teste de verdade):
//     CARGA_CONFIRMO=SIM npm run carga
//     depois rode testes/carga-limpeza.sql no SQL Editor do Supabase.
//
// O que NÃO mede: Realtime por WebSocket (o chat cai para consulta a cada 4 s, que é o que aqui se mede), n8n, Klingo, o painel da equipe.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { simulado } from './carga-simulado.mjs';

const env = (k, padrao) => (process.env[k] ?? '') === '' ? padrao : process.env[k];
const num = (k, padrao) => { const n = Number(env(k, padrao)); if (!Number.isFinite(n) || n < 0) throw new Error(`${k} inválido`); return n; };

const CFG = {
  usuarios: num('CARGA_USUARIOS', 100),
  rampaS: num('CARGA_RAMPA_S', 10),        // os usuários entram espalhados nesse tempo (todos juntos = pico de abertura)
  duracaoS: num('CARGA_DURACAO_S', 60),    // quanto tempo cada um fica conversando depois de entrar
  pensarMs: [num('CARGA_PENSAR_MIN_MS', 1500), num('CARGA_PENSAR_MAX_MS', 5000)],
  pollMs: num('CARGA_POLL_MS', 4000),      // o chat consulta a cada 4 s quando o Realtime não entrega
  timeoutMs: num('CARGA_TIMEOUT_MS', 15000),
  p95MaxMs: num('CARGA_P95_MAX_MS', 1500),
  errosMaxPct: num('CARGA_ERROS_MAX_PCT', 1),
  json: env('CARGA_JSON', '')
};
const MAX_SEGURO = 300;
const SIMULADO = env('CARGA_SIMULADO', '') === '1';

if (CFG.usuarios < 1 || CFG.usuarios > MAX_SEGURO) { console.error(`CARGA_USUARIOS deve ficar entre 1 e ${MAX_SEGURO}.`); process.exit(2); }

// ---------- alvo ----------
let URL_BASE = env('CARGA_URL', 'https://nrvuynjwcgwpjdptkiay.supabase.co');
let CHAVE = env('CARGA_KEY', 'sb_publishable_e2GK1YGEj06STa_ESCevow_nvtATB-y');   // chave publicável: a mesma que já está no index.html
let servidorSimulado = null;
if (SIMULADO) {
  servidorSimulado = await simulado();
  URL_BASE = `http://127.0.0.1:${servidorSimulado.address().port}`;
  CHAVE = 'chave-simulada';
} else if (env('CARGA_CONFIRMO', '') !== 'SIM') {
  console.error([
    'Este teste cria ' + CFG.usuarios + ' conversas de teste no banco REAL (' + URL_BASE + ').',
    'Elas aparecem para a equipe no painel até você rodar testes/carga-limpeza.sql.',
    'Para rodar mesmo assim:  CARGA_CONFIRMO=SIM npm run carga',
    'Para validar o script sem tocar na produção:  npm run test:carga'
  ].join('\n'));
  process.exit(2);
}

// ---------- medição ----------
const medidas = new Map();   // rpc -> { ms: [], ok, erros: Map(codigo -> n) }
const esperados = new Set(['28000:prova', '54000:prova', '22023:prova']);   // erros que as provas de proteção PROVOCAM de propósito
const reg = (rpc) => { if (!medidas.has(rpc)) medidas.set(rpc, { ms: [], ok: 0, erros: new Map() }); return medidas.get(rpc); };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const entre = ([a, b]) => a + Math.random() * (b - a);
const pct = (v, p) => v.length ? v[Math.min(v.length - 1, Math.ceil(p / 100 * v.length) - 1)] : 0;

// Chama a função como o supabase-js faz (POST /rest/v1/rpc/<nome>). `rotulo` marca uma chamada que DEVE falhar (prova de proteção).
async function rpc(nome, corpo, rotulo = '') {
  const r = reg(nome), t0 = performance.now();
  let codigo = null, dados = null, mensagem = '';
  try {
    const res = await fetch(`${URL_BASE}/rest/v1/rpc/${nome}`, {
      method: 'POST', signal: AbortSignal.timeout(CFG.timeoutMs),
      headers: { apikey: CHAVE, authorization: `Bearer ${CHAVE}`, 'content-type': 'application/json' },
      body: JSON.stringify(corpo)
    });
    const texto = await res.text();
    try { dados = texto ? JSON.parse(texto) : null; } catch { dados = null; }
    if (!res.ok) { codigo = (dados && dados.code) || `HTTP${res.status}`; mensagem = (dados && dados.message) || texto.slice(0, 120); }
  } catch (e) {
    codigo = e.name === 'TimeoutError' ? 'TIMEOUT' : 'REDE'; mensagem = e.message;
  }
  const ms = performance.now() - t0;
  r.ms.push(ms);
  if (!codigo) r.ok++;
  else { const k = rotulo && esperados.has(`${codigo}:${rotulo}`) ? `${codigo} (esperado)` : codigo; r.erros.set(k, (r.erros.get(k) || 0) + 1); }
  return { dados, codigo, mensagem, ms };
}

// ---------- paciente virtual ----------
const RODADA = Date.now().toString(36);
// Telefone: DDD 11 + 9 + 8 dígitos únicos por rodada/usuário. E-mail @example.invalid nunca existe de verdade (a limpeza usa isso).
const SUFIXO = String(Date.now() % 10000).padStart(4, '0');
const telefone = (i) => `119${SUFIXO}${String(i).padStart(4, '0')}`;
const emailDe = (i) => `carga-${RODADA}-${i}@example.invalid`;
const nomeDe = (i) => `TESTE DE CARGA ${String(i).padStart(3, '0')}`;

function camposDe(opcoes) {   // preenche um formulário do motor com dados inventados
  const v = {};
  for (const c of opcoes.campos || []) {
    const n = c.nome;
    v[n] = c.valor || ({ nome: nomeDe(0), sexo: 'F', dt_nasc: '1990-05-17', mae: 'MAE DE TESTE', cpf: '', rg: '', celular: '11999990000',
      telefone: '', cep: '', endereco: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '', matricula: '', validade: '' }[n] ?? 'teste');
  }
  return v;
}

async function paciente(i, fim, ctx) {
  await rpc('chat_config', {});
  const ini = await rpc('chat_iniciar', {
    p_nome: nomeDe(i), p_telefone: telefone(i), p_email: emailDe(i), p_aceite: true, p_origem: 'teste-de-carga',
    p_paciente_tipo: 'proprio', p_paciente_nome: null
  });
  if (ini.codigo || !ini.dados) { ctx.semConversa++; return; }
  const conv = { id: ini.dados.conversa_id, token: ini.dados.token };
  let ultima = (ini.dados.respostas || []).filter((m) => m.autor !== 'cliente').pop() || null;
  let cursor = Math.max(0, ...(ini.dados.respostas || []).map((m) => m.id));
  let parar = false;
  const k = { p_conversa: conv.id, p_token: conv.token };

  // Consulta periódica: é o custo fixo de cada paciente com a aba aberta (o chat faz isto a cada 4 s sem Realtime).
  const consulta = async () => {
    const r = await rpc('chat_listar', { p_conversa: k.p_conversa, p_token: k.p_token, p_apos: cursor });
    if (r.dados && Array.isArray(r.dados.mensagens)) {
      for (const m of r.dados.mensagens) { if (m.id > cursor) cursor = m.id; if (m.autor !== 'cliente') ultima = m; }
    }
  };
  await consulta();
  const poll = (async () => { while (!parar) { await espera(CFG.pollMs * (0.85 + Math.random() * 0.3)); if (!parar) await consulta(); } })();

  while (performance.now() < fim) {
    await espera(entre(CFG.pensarMs));
    if (performance.now() >= fim) break;
    const op = ultima && ultima.opcoes;
    let r;
    if (op && op.tipo === 'escolha' && Array.isArray(op.itens) && op.itens.length) {
      const it = op.itens[Math.floor(Math.random() * op.itens.length)];
      r = await rpc('chat_responder', { p_conversa: k.p_conversa, p_token: k.p_token, p_passo: op.passo, p_valor: it.valor, p_texto: it.rotulo, p_ms: 300 });
    } else if (op && op.tipo === 'campos') {
      r = await rpc('chat_responder', { p_conversa: k.p_conversa, p_token: k.p_token, p_passo: op.passo, p_valor: camposDe(op), p_texto: null, p_ms: 900 });
    } else if (op && op.tipo === 'texto') {
      r = await rpc('chat_responder', { p_conversa: k.p_conversa, p_token: k.p_token, p_passo: op.passo, p_valor: 'Quero marcar um exame, por favor.', p_texto: null, p_ms: 1500 });
    } else if (op && op.passo) {   // busca de exame, calendário etc.: componentes de tela que o robô não preenche; pede a atendente
      r = await rpc('chat_responder', { p_conversa: k.p_conversa, p_token: k.p_token, p_passo: op.passo, p_valor: { acao: 'atendente' }, p_texto: null, p_ms: 500 });
    } else {
      r = await rpc('chat_enviar', { p_conversa: k.p_conversa, p_token: k.p_token, p_texto: 'Olá, gostaria de saber o horário de atendimento.' });
    }
    const novas = r.dados && Array.isArray(r.dados.respostas) ? r.dados.respostas : [];
    for (const m of novas) { if (m.id > cursor) cursor = m.id; if (m.autor !== 'cliente') ultima = m; }
    if (r.codigo === '22023') ultima = null;   // "pergunta já respondida": volta a escrever texto livre
    ctx.acoes++;
  }
  parar = true; await poll;
  ctx.conversas.push(conv);
}

// ---------- provas das travas de proteção ----------
async function provas() {
  const out = [];
  const marca = (nome, ok, detalhe) => out.push({ nome, ok, detalhe });
  const base = 900;
  const ini = async (j, tel, rotulo = '') => rpc('chat_iniciar', { p_nome: nomeDe(j), p_telefone: tel, p_email: emailDe(j), p_aceite: true, p_origem: 'teste-de-carga', p_paciente_tipo: 'proprio', p_paciente_nome: null }, rotulo);

  // 1. token errado não lê conversa alheia
  const a = await ini(base, telefone(base));
  const e = await rpc('chat_listar', { p_conversa: a.dados?.conversa_id, p_token: 'token-errado', p_apos: 0 }, 'prova');
  marca('token errado é recusado (28000)', e.codigo === '28000', e.codigo || 'aceitou!');

  // 2. 21ª mensagem no mesmo minuto é recusada
  let ultimo = null;
  for (let n = 1; n <= 22; n++) {
    ultimo = await rpc('chat_enviar', { p_conversa: a.dados.conversa_id, p_token: a.dados.token, p_texto: `flood ${n}` }, 'prova');
    if (ultimo.codigo) { marca('limite de 20 mensagens por minuto (54000)', ultimo.codigo === '54000' && n >= 15, `recusou na ${n}ª`); break; }
  }
  if (!ultimo.codigo) marca('limite de 20 mensagens por minuto (54000)', false, 'enviou 22 sem recusar');

  // 3. 6ª conversa na mesma hora com o mesmo telefone é recusada
  const tel = telefone(base + 1); let recusou = 0;
  for (let n = 0; n < 7; n++) { const r = await ini(base + 1, tel, 'prova'); if (r.codigo === '54000') { recusou = n + 1; break; } }
  marca('limite de 5 conversas por hora por telefone (54000)', recusou === 6, recusou ? `recusou na ${recusou}ª` : 'nunca recusou');

  // 4. entrada inválida volta erro de validação, não erro 500
  const inv = await rpc('chat_iniciar', { p_nome: 'x', p_telefone: '123', p_email: 'ruim', p_aceite: true }, 'prova');
  marca('dados inválidos dão erro de validação (22023), não 5xx', inv.codigo === '22023', inv.codigo || 'aceitou!');
  const sem = await rpc('chat_iniciar', { p_nome: nomeDe(base + 2), p_telefone: telefone(base + 2), p_email: emailDe(base + 2), p_aceite: false }, 'prova');
  marca('sem aceite da LGPD é recusado (22023)', sem.codigo === '22023', sem.codigo || 'aceitou!');
  return out;
}

// ---------- execução ----------
console.log(`Alvo: ${SIMULADO ? 'SERVIDOR SIMULADO' : URL_BASE}\nUsuários: ${CFG.usuarios} | entrada em ${CFG.rampaS}s | conversando ${CFG.duracaoS}s cada | consulta a cada ${CFG.pollMs / 1000}s\n`);
const ctx = { acoes: 0, semConversa: 0, conversas: [] };
const t0 = performance.now();
const todos = [];
for (let i = 1; i <= CFG.usuarios; i++) {
  const atraso = CFG.rampaS * 1000 * (i - 1) / Math.max(1, CFG.usuarios - 1);
  todos.push(espera(atraso).then(() => paciente(i, performance.now() + CFG.duracaoS * 1000, ctx)).catch((e) => { ctx.semConversa++; console.error(`usuário ${i}:`, e.message); }));
}
const emParalelo = provas();   // as provas rodam COM a carga, não depois: é aí que a trava pode falhar
await Promise.all(todos);
const provasFeitas = await emParalelo;
const seg = (performance.now() - t0) / 1000;

// ---------- relatório ----------
let total = 0, falhas = 0;
const linhas = [];
for (const [nome, r] of [...medidas].sort((a, b) => b[1].ms.length - a[1].ms.length)) {
  const s = [...r.ms].sort((x, y) => x - y);
  const inesperados = [...r.erros].filter(([k]) => !k.endsWith('(esperado)')).reduce((t, [, n]) => t + n, 0);
  total += s.length; falhas += inesperados;
  linhas.push({ nome, n: s.length, ok: r.ok, falhas: inesperados, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1] || 0,
    erros: Object.fromEntries(r.erros) });
}
const f = (x) => String(Math.round(x)).padStart(6);
console.log('chamada'.padEnd(20) + '     n  falhas   p50ms   p95ms   p99ms   maxms');
for (const l of linhas) console.log(l.nome.padEnd(20) + String(l.n).padStart(6) + String(l.falhas).padStart(8) + f(l.p50) + ' ' + f(l.p95) + ' ' + f(l.p99) + ' ' + f(l.max));
const todosMs = [...medidas.values()].flatMap((r) => r.ms).sort((a, b) => a - b);
console.log(`\n${total} chamadas em ${seg.toFixed(1)}s = ${(total / seg).toFixed(1)} chamadas/s | ${ctx.acoes} respostas de pacientes | ${ctx.conversas.length} de ${CFG.usuarios} pacientes completaram`);
const codigos = linhas.filter((l) => Object.keys(l.erros).length);
if (codigos.length) { console.log('\nErros por código:'); for (const l of codigos) console.log(`  ${l.nome}: ${JSON.stringify(l.erros)}`); }
console.log('\nTravas de proteção (rodando junto com a carga):');
for (const p of provasFeitas) console.log(`  ${p.ok ? 'OK    ' : 'FALHOU'} ${p.nome} — ${p.detalhe}`);

const problemas = [];
const p95Geral = pct(todosMs, 95);
if (ctx.semConversa) problemas.push(`${ctx.semConversa} paciente(s) nem conseguiram abrir a conversa`);
if (total && falhas / total * 100 > CFG.errosMaxPct) problemas.push(`${(falhas / total * 100).toFixed(1)}% de chamadas com erro inesperado (limite ${CFG.errosMaxPct}%)`);
if (p95Geral > CFG.p95MaxMs) problemas.push(`p95 geral ${Math.round(p95Geral)}ms acima do limite de ${CFG.p95MaxMs}ms`);
for (const l of linhas) if (l.n >= 20 && l.p95 > CFG.p95MaxMs * 2) problemas.push(`${l.nome}: p95 ${Math.round(l.p95)}ms (mais que o dobro do limite)`);
for (const p of provasFeitas) if (!p.ok) problemas.push(`trava de proteção falhou: ${p.nome} (${p.detalhe})`);

console.log(`\np95 geral: ${Math.round(p95Geral)}ms | limite ${CFG.p95MaxMs}ms`);
console.log(problemas.length ? `\nRESULTADO: PROBLEMAS ENCONTRADOS\n  - ${problemas.join('\n  - ')}` : '\nRESULTADO: PASSOU');
if (!SIMULADO) console.log('\nLimpeza: rode testes/carga-limpeza.sql no SQL Editor do Supabase (apaga só contatos "TESTE DE CARGA" com e-mail @example.invalid).');
if (CFG.json) writeFileSync(CFG.json, JSON.stringify({ quando: new Date().toISOString(), alvo: SIMULADO ? 'simulado' : URL_BASE, config: CFG, chamadas: linhas, provas: provasFeitas, problemas }, null, 2));
if (servidorSimulado) servidorSimulado.close();
process.exit(problemas.length ? 1 : 0);
