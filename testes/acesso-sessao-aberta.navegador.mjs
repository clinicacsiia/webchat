// FLUXOGRAMA: entrada (o index.html REAL do chat e a página /acesso/ REAL num Chromium de celular, com relógio falso e o banco de teste: retrato da produção + migrações do acesso rápido + PIN obrigatório) -> validação (31 a 45 minutos sem tocar na tela, com a conversa aberta esperando a atendente; PIN vencido com a conversa aberta; PIN certo na porta) -> lógica (a página renova o PIN sozinha a cada 3 minutos e não manda ninguém para a porta no meio da conversa; PIN vencido com a conversa aberta pede o PIN em cima dela; quem ABRE o chat com o PIN vencido continua indo à porta; depois do PIN aparece a tela grande de boas-vindas e o teclado fica coberto) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 17/11/2026 / Mudança: Implementação inicial (sessão ativa enquanto o chat está aberto; boas-vindas depois do PIN)
// Dados inventados. Nada fala com o Supabase de verdade.
import { readFileSync } from 'node:fs';
import { chromium, servidor, novaPaginaChat } from './mock-chat.mjs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const { db } = await criarBancoProducao();
const { q, anonimo } = ajudantes(db);
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-paciente.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-chat.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-pendencias.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-pin-obrigatorio.sql`, 'utf8'));
const modo = (v) => db.query(`update public.config set valor = $1 where chave = 'app_acesso_modo'`, [v]);

// O "Supabase" do chat: cada chamada rpc vai para a função de mesmo nome no banco de teste, como anon, com parâmetros nomeados.
let fila = Promise.resolve();
const infos = new Map();
const mundo = {
  chamadas: [], quedas: {}, cab: [], recusar: {}, atrasar: {}, chegadas: [],
  // cab = cabeçalhos da requisição (o chat manda o aparelho em x-acesso); recusar = { nome: n } faz as próximas n chamadas devolverem "pin_obrigatorio", como o servidor faz com a trava ligada
  tratar: (nome, corpo, cab) => {
    mundo.chegadas.push({ nome, t: Date.now() });
    mundo.cab.push({ nome, x: (cab || {})['x-acesso'] || null });
    if (mundo.recusar[nome] > 0) { mundo.recusar[nome]--; return Promise.resolve({ status: 400, body: { code: 'P0001', message: 'pin_obrigatorio', hint: 'Digite o seu PIN para continuar.' } }); }
    const r = fila.then(async () => { if (mundo.atrasar[nome]) await espera(mundo.atrasar[nome]); return chamar(nome, corpo); }); fila = r.catch(() => {}); return r;
  },
};
async function chamar(nome, corpo) {
  let info = infos.get(nome);
  if (!info) {
    info = (await db.query(`select p.proargnames as nomes, (select array_agg(format_type(t, null) order by o) from unnest(p.proargtypes::oid[]) with ordinality as x(t, o)) as tipos
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [nome])).rows[0];
    infos.set(nome, info || null);
  }
  mundo.chamadas.push({ nome, corpo });
  if (!info) return { status: 404, body: { message: `função inexistente: ${nome}` } };
  const partes = [], valores = [];
  for (const [k, v] of Object.entries(corpo || {})) {
    const i = (info.nomes || []).indexOf(k);
    if (i < 0) return { status: 400, body: { message: `parâmetro desconhecido em ${nome}: ${k}` } };
    const t = info.tipos[i];
    valores.push(v === null ? null : t === 'jsonb' ? JSON.stringify(v) : t === 'boolean' ? v === true || v === 'true' : /^(integer|bigint|smallint)$/.test(t) ? Number(v) : String(v));
    partes.push(`${k} => $${valores.length}::${info.tipos[i]}`);
  }
  await db.exec('reset role; set role anon');
  try { return { status: 200, body: (await db.query(`select public.${nome}(${partes.join(', ')}) as r`, valores)).rows[0].r }; }
  catch (e) { return { status: 400, body: { message: e.message, code: e.code } }; }
  finally { await db.exec('reset role'); }
}

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

const CPF_ANA = '529.982.247-25', CPF_LEO = '111.444.777-35';
const rpcSql = async (nome, args) => {   // cadastra a Ana direto no banco (como a página /acesso/ faria)
  const ks = Object.keys(args); await anonimo();
  try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${typeof args[k] === 'object' && args[k] !== null ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (typeof args[k] === 'object' && args[k] !== null ? JSON.stringify(args[k]) : args[k]))))[0].r; }
  finally { await db.exec('reset role'); }
};
await modo('sim');   // o cadastro só funciona com o acesso rápido ligado
const ana = await rpcSql('app_cadastrar', { p_telefone: '71991230001', p_nome: 'Ana Souza Teste', p_nascimento: '1988-04-12', p_pin: '1357',
  p_filhos: [{ nome: 'Leo Souza Teste', nascimento: '2019-08-30' }, { nome: 'Lia Souza Teste', nascimento: '2022-01-10' }] });
if (!ana || !ana.token) { console.log('FAIL  cadastro de teste da Ana:', JSON.stringify(ana)); process.exit(1); }


const obrig = (v) => db.query(`update public.config set valor = $1 where chave = 'app_pin_obrigatorio'`, [v]);
const destrava = () => q(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
const trava = () => q(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
const completa = async () => { await q(`update public.app_paciente set cpf = '52998224725'`); await q(`update public.app_filho set cpf = '11144477735'`); };
const incompleta = async () => { await q(`update public.app_paciente set cpf = null`); await q(`update public.app_filho set cpf = null`); };
const texto = (page) => page.evaluate(() => document.body.innerText);
const aguardaTexto = (page, re, ms = 8000) => page.waitForFunction((s) => new RegExp(s).test(document.body.innerText), re.source, { timeout: ms });
const abrir = async ({ token = ana.token, init = [], clock = false } = {}) => {
  await q(`update public.conversas set criado_em = criado_em - interval '2 hours'`);
  const ini = [...(token ? [[(t) => { try { localStorage.setItem('csi_acesso_v2', JSON.stringify({ dev: t, nome1: 'Ana' })); } catch { /* sem armazenamento */ } }, token]] : []), ...init];
  const r = await novaPaginaChat(browser, mundo, { init: ini });
  if (clock) await r.ctx.clock.install();
  await r.page.goto(`${base}/index.html`);
  return r;
};
const naPorta = (page) => /\/acesso\//.test(page.url());
const noChat = (page) => !naPorta(page);
const pinAcesso = async (page, d) => { for (const x of d) await page.locator(`.pad button[data-k="${x}"]`).click(); await espera(500); };


// Abre o chat com uma conversa de verdade já aberta, esperando a atendente (a que o paciente deixa na tela).
const conversaAberta = async () => {
  const c = await rpcSql('chat_iniciar', { p_nome: 'Ana Souza Teste', p_telefone: '71991230001', p_email: 'ana@exemplo.invalid', p_aceite: true, p_paciente_tipo: 'proprio' });
  if (!c || !c.conversa_id) throw new Error('conversa de teste não abriu: ' + JSON.stringify(c));
  await q(`update public.conversas set status = 'aguardando' where id = '${c.conversa_id}'`);
  return { id: c.conversa_id, token: c.token, tipo: 'proprio', nomeCrianca: '', irmaos: [], irmaosModo: '' };
};
const chamadasPerfil = () => mundo.chamadas.filter((c) => c.nome === 'app_perfil').length;

await obrig('sim'); await completa(); await destrava();

await caso('30 minutos sem tocar na tela: o chat NÃO volta ao PIN e a página renovou a sessão sozinha (a cada 3 minutos)', async () => {
  await destrava();
  const { page, ctx } = await abrir({ clock: true });
  await page.waitForSelector('#formInicio', { state: 'visible', timeout: 10000 }); await aguardaTexto(page, /Olá, Ana!/);
  const antes = chamadasPerfil();
  await page.clock.runFor('31:00'); await espera(1500);
  const renovou = chamadasPerfil() - antes;
  await ctx.close(); return { ok: noChat(page) && renovou >= 8, detalhe: `renovações em 31 min: ${renovou}; ${page.url()}` };
});

await caso('conversa aberta esperando a atendente, 45 minutos sem tocar (tela apagada ou só olhando): continua na conversa, sem PIN', async () => {
  await destrava();
  const conversa = await conversaAberta();
  const { page, ctx } = await abrir({ clock: true, init: [[(c) => { try { localStorage.setItem('webchat.conversa.v1', JSON.stringify(c)); } catch { /* sem armazenamento */ } }, conversa]] });
  await page.waitForSelector('#msgs', { state: 'visible', timeout: 10000 });
  await aguardaTexto(page, /Aguardando um atendente|Atendimento|conversa/i).catch(() => {});
  const antes = chamadasPerfil();
  await page.clock.runFor('45:00'); await espera(1500);
  const renovou = chamadasPerfil() - antes, tecladoAberto = await page.locator('.pin-teclas').isVisible().catch(() => false);
  const naConversa = await page.locator('#msgs').isVisible();
  await ctx.close(); return { ok: noChat(page) && naConversa && !tecladoAberto && renovou >= 12, detalhe: `renovações em 45 min: ${renovou}; teclado=${tecladoAberto}; ${page.url()}` };
});

await caso('PIN venceu com a conversa aberta (celular dormiu): o PIN é pedido EM CIMA da conversa, sem sair dela; com o PIN certo ela segue do mesmo ponto', async () => {
  await destrava();
  const conversa = await conversaAberta();
  const { page, ctx } = await abrir({ init: [[(c) => { try { localStorage.setItem('webchat.conversa.v1', JSON.stringify(c)); } catch { /* sem armazenamento */ } }, conversa]] });
  await page.waitForSelector('#msgs', { state: 'visible', timeout: 10000 }); await espera(800);
  await trava();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForSelector('.pin-teclas', { state: 'visible', timeout: 8000 });
  const ficou = noChat(page);
  for (const d of '1357') await page.click(`.pin-teclas [data-tecla="${d}"]`);
  await page.waitForSelector('.pin-teclas', { state: 'hidden', timeout: 8000 });
  const aindaNaConversa = noChat(page) && await page.locator('#msgs').isVisible();
  const conversaGuardada = await page.evaluate(() => (JSON.parse(localStorage.getItem('webchat.conversa.v1') || 'null') || {}).id);
  await ctx.close(); return { ok: ficou && aindaNaConversa && conversaGuardada === conversa.id, detalhe: `${page.url()}` };
});

await caso('o servidor recusa uma chamada com "pin_obrigatorio" com a conversa aberta: pede o PIN aqui mesmo, em vez de ir à porta', async () => {
  await destrava();
  const conversa = await conversaAberta();
  const { page, ctx } = await abrir({ init: [[(c) => { try { localStorage.setItem('webchat.conversa.v1', JSON.stringify(c)); } catch { /* sem armazenamento */ } }, conversa]] });
  await page.waitForSelector('#msgs', { state: 'visible', timeout: 10000 }); await espera(800);
  await trava(); mundo.recusar = { chat_listar: 1 };
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForSelector('.pin-teclas', { state: 'visible', timeout: 8000 }).catch(() => {});
  const teclado = await page.locator('.pin-teclas').isVisible().catch(() => false);
  const ficou = noChat(page); mundo.recusar = {};
  await ctx.close(); return { ok: teclado && ficou, detalhe: `${page.url()} teclado=${teclado}` };
});

await caso('NOVA sessão com o PIN vencido continua exigindo o PIN: abrir o chat leva à porta, mesmo com conversa guardada no aparelho', async () => {
  await trava();
  const conversa = await conversaAberta();
  const { page, ctx } = await abrir({ init: [[(c) => { try { localStorage.setItem('webchat.conversa.v1', JSON.stringify(c)); } catch { /* sem armazenamento */ } }, conversa]] });
  await page.waitForURL(/\/acesso\//, { timeout: 8000 });
  await aguardaTexto(page, /Digite seu PIN/);
  await ctx.close(); return { ok: naPorta(page), detalhe: page.url() };
});

await caso('depois do PIN certo aparece NA HORA a tela grande "Bem-vindo(a), Ana!" cobrindo o teclado (não dá para digitar o PIN de novo) enquanto o chat abre', async () => {
  await trava(); mundo.atrasar = { app_acesso_registrar: 1800 };
  const { page, ctx } = await abrir();
  await page.waitForURL(/\/acesso\//, { timeout: 8000 }); await aguardaTexto(page, /Digite seu PIN/);
  const t0 = Date.now();
  for (const d of '1357') await page.locator(`.pad button[data-k="${d}"]`).click();
  await page.waitForSelector('#bv', { state: 'visible', timeout: 4000 });
  const viuEm = Date.now() - t0;
  const info = await page.evaluate(() => {
    const bv = document.getElementById('bv'), h1 = bv.querySelector('h1');
    const r = document.querySelector('.pad button[data-k="5"]').getBoundingClientRect();
    const topo = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { texto: bv.innerText.replace(/\s+/g, ' '), fonte: parseFloat(getComputedStyle(h1).fontSize), cobre: bv.contains(topo), url: location.pathname };
  });
  const aindaNaPorta = naPorta(page);   // o registro do acesso foi atrasado: a página ainda não saiu
  await page.waitForURL((u) => !/\/acesso\//.test(String(u)), { timeout: 10000 });
  mundo.atrasar = {}; await ctx.close();
  return { ok: /Bem-vindo\(a\), Ana!/.test(info.texto) && /Abrindo o chat/.test(info.texto) && info.fonte >= 28 && info.cobre && aindaNaPorta, detalhe: `${info.texto} | fonte ${info.fonte}px | cobre o teclado: ${info.cobre} | apareceu em ${viuEm} ms` };
});

await caso('a conferência do cadastro e o registro do acesso saem JUNTOS: com a conferência demorando 1,2 s, o registro começa antes dela terminar (antes ficava na fila, atrás)', async () => {
  await trava(); mundo.chegadas.length = 0; mundo.atrasar = { app_pendencias: 1200 };
  const { page, ctx } = await abrir();
  await page.waitForURL(/\/acesso\//, { timeout: 8000 }); await aguardaTexto(page, /Digite seu PIN/);
  mundo.chegadas.length = 0;
  await pinAcesso(page, '1357');
  await page.waitForURL((u) => !/\/acesso\//.test(String(u)), { timeout: 10000 });
  const pend = mundo.chegadas.find((c) => c.nome === 'app_pendencias'), reg = mundo.chegadas.find((c) => c.nome === 'app_acesso_registrar');
  mundo.atrasar = {}; await ctx.close();
  const dif = pend && reg ? reg.t - pend.t : null;
  return { ok: dif !== null && Math.abs(dif) < 900, detalhe: `diferença entre o início das duas chamadas: ${dif} ms` };
});

await caso('o chat também mostra o nome na tela de abertura (mesma mensagem do /acesso/), em vez de "Abrindo com segurança…"', async () => {
  await destrava();
  const { page, ctx } = await abrir({ init: [[() => { try { localStorage.setItem('csi_porta_v1', '1'); } catch { /* sem armazenamento */ } }, null]] });
  const t = await page.locator('#portaBv').textContent();
  await ctx.close(); return { ok: /Bem-vindo\(a\), Ana!/.test(t), detalhe: t };
});

await browser.close(); srv.close();
const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
