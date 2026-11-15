// FLUXOGRAMA: entrada (o index.html REAL do chat e a página /acesso/ REAL num Chromium de celular, falando com o banco de teste: retrato da produção + migrações do acesso rápido + acesso-rapido-pin-obrigatorio.sql) -> validação (aparelho sem cadastro, com PIN vencido, com cadastro incompleto, com tudo em dia; interruptor ligado e desligado; 30 minutos sem uso) -> lógica (com o PIN obrigatório o chat só abre para quem está em dia; quem não está é levado para /acesso/ e volta ao chat depois; sem o interruptor nada muda) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (PIN obrigatório na porta do chat)
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
  chamadas: [], quedas: {}, cab: [], recusar: {},
  // cab = cabeçalhos da requisição (o chat manda o aparelho em x-acesso); recusar = { nome: n } faz as próximas n chamadas devolverem "pin_obrigatorio", como o servidor faz com a trava ligada
  tratar: (nome, corpo, cab) => {
    mundo.cab.push({ nome, x: (cab || {})['x-acesso'] || null });
    if (mundo.recusar[nome] > 0) { mundo.recusar[nome]--; return Promise.resolve({ status: 400, body: { code: 'P0001', message: 'pin_obrigatorio', hint: 'Digite o seu PIN para continuar.' } }); }
    const r = fila.then(() => chamar(nome, corpo)); fila = r.catch(() => {}); return r;
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

// ================================================================= interruptor desligado
await caso('interruptor do PIN obrigatório DESLIGADO: o chat abre sem cadastro e sem PIN, como sempre', async () => {
  await obrig('nao');
  const { page, ctx } = await abrir({ token: null });
  await page.waitForSelector('#formInicio', { state: 'visible', timeout: 10000 }); await espera(800);
  const ok = noChat(page) && await page.locator('#porta').isHidden();
  await ctx.close(); return { ok };
});
await obrig('sim');

// ================================================================= ligado
await caso('LIGADO e sem cadastro neste aparelho: o chat leva para /acesso/ (passo do celular)', async () => {
  const { page, ctx } = await abrir({ token: null });
  await page.waitForURL(/\/acesso\//, { timeout: 8000 });
  await aguardaTexto(page, /Vamos começar/);
  const url = page.url(); await ctx.close();
  return { ok: /voltar=chat/.test(url), detalhe: url };
});
await caso('LIGADO e tudo em dia (PIN dos últimos 30 minutos, CPF dela e dos filhos): o chat abre direto e a capa some', async () => {
  await completa(); await destrava();
  const { page, ctx } = await abrir();
  await page.waitForSelector('#formInicio', { state: 'visible', timeout: 10000 });
  await aguardaTexto(page, /Acesso rápido: Ana/);
  const ok = noChat(page) && await page.locator('#porta').isHidden();
  await ctx.close(); return { ok };
});
await caso('LIGADO e PIN vencido: o chat leva ao teclado do PIN; com o PIN certo volta ao chat, que abre', async () => {
  await trava();
  const { page, ctx } = await abrir();
  await page.waitForURL(/\/acesso\//, { timeout: 8000 });
  await aguardaTexto(page, /Digite seu PIN/);
  await pinAcesso(page, '1357');
  await page.waitForURL(/\/index\.html|\/$/, { timeout: 8000 }); await page.waitForSelector('#formInicio', { state: 'visible', timeout: 10000 });
  await aguardaTexto(page, /Acesso rápido: Ana/);
  const ok = !naPorta(page) && await page.locator('#porta').isHidden();
  const ev = (await q(`select evento from public.app_acesso_log order by id desc limit 1`))[0];
  await ctx.close(); return { ok: ok && ev.evento === 'desbloqueio', detalhe: page.url() };
});
await caso('LIGADO e cadastro incompleto: depois do PIN, "Falta pouco" obriga o CPF dela e dos filhos; completou, o chat abre', async () => {
  await incompleta(); await destrava();
  const { page, ctx } = await abrir();
  await page.waitForURL(/\/acesso\//, { timeout: 8000 });
  await pinAcesso(page, '1357');
  await aguardaTexto(page, /Falta pouco/);
  const t = await texto(page);
  const inputs = page.locator('#pend input[data-pc="cpf"]');
  const n = await inputs.count();
  await inputs.nth(0).fill('52998224725'); for (let i = 1; i < n; i++) await inputs.nth(i).fill(i % 2 ? '11144477735' : '52998224725');
  await page.click('[data-act="completarsalvar"]');
  await page.waitForURL((u) => !/\/acesso\//.test(String(u)), { timeout: 20000 });
  await page.waitForSelector('#formInicio', { state: 'visible', timeout: 10000 }); await aguardaTexto(page, /Acesso rápido: Ana/);
  const faltam = (await q(`select (select count(*) from public.app_paciente where cpf is null)::int + (select count(*) from public.app_filho where cpf is null)::int n`))[0].n;
  await ctx.close(); return { ok: /CPF/.test(t) && !/Agora não/.test(t) && n === 3 && faltam === 0 && noChat(page), detalhe: `${n} campos; faltam ${faltam}; ${page.url()}; ${/CPF/.test(t)} ${!/Agora não/.test(t)}` };
});
await caso('30 minutos sem usar o chat: a tela volta ao teclado do PIN', async () => {
  await completa(); await destrava();
  const { page, ctx } = await abrir({ clock: true });
  await page.waitForSelector('#formInicio', { state: 'visible', timeout: 10000 }); await aguardaTexto(page, /Acesso rápido: Ana/);
  const antes = noChat(page);
  await page.clock.fastForward('31:00');
  await page.waitForURL(/\/acesso\//, { timeout: 8000 });
  await ctx.close(); return { ok: antes && naPorta(page), detalhe: page.url() };
});
await caso('usando o chat (toques) o prazo recomeça: 20 minutos + toque + 20 minutos não pede o PIN', async () => {
  await completa(); await destrava();
  const { page, ctx } = await abrir({ clock: true });
  await page.waitForSelector('#formInicio', { state: 'visible', timeout: 10000 }); await aguardaTexto(page, /Acesso rápido: Ana/);
  await page.clock.fastForward('20:00'); await page.mouse.click(5, 5); await page.clock.fastForward('20:00'); await espera(300);
  await ctx.close(); return { ok: noChat(page) };
});
await caso('o servidor venceu o PIN enquanto a aba estava aberta: ao voltar à aba o chat pede o PIN', async () => {
  await completa(); await destrava();
  const { page, ctx } = await abrir();
  await page.waitForSelector('#formInicio', { state: 'visible', timeout: 10000 }); await aguardaTexto(page, /Acesso rápido: Ana/);
  await trava();
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForURL(/\/acesso\//, { timeout: 8000 });
  await ctx.close(); return { ok: naPorta(page) };
});
const novoAparelho = async () => { ana.token = (await rpcSql('app_login', { p_telefone: '71991230001', p_pin: '1357', p_aparelho: 'T2' })).token; };
await caso('"Sair" no chat leva à porta (não deixa o chat aberto sem cadastro)', async () => {
  await completa(); await novoAparelho(); await destrava();
  const { page, ctx } = await abrir();
  await page.waitForSelector('#acessoSair', { timeout: 10000 });
  await page.click('#acessoSair');
  await page.waitForURL(/\/acesso\//, { timeout: 8000 });
  await ctx.close(); await novoAparelho(); return { ok: naPorta(page) };
});
await caso('na clínica e com exame hoje: a faixa oferece o check-in', async () => {
  await completa(); await destrava();
  const { page, ctx } = await abrir({ init: [[() => { try { sessionStorage.setItem('csi_presenca', JSON.stringify({ na: true, ex: 2, t: Date.now() })); } catch { /* sem armazenamento */ } }, null]] });
  await page.waitForSelector('#acessoPresenca', { timeout: 10000 }).catch(async (e) => { throw new Error(e.message.split('\n')[0] + ' // ' + (await page.evaluate(() => JSON.stringify([sessionStorage.getItem('csi_presenca'), document.getElementById('blocoAcesso')?.innerText, location.href])))); });
  const t = await page.$eval('#acessoPresenca', (e) => e.textContent + '|' + e.querySelector('a').getAttribute('href'));
  await ctx.close(); return { ok: /2 exames hoje/.test(t) && /minha-vez\/$/.test(t), detalhe: t };
});
await caso('trava contra laço: depois de 3 voltas o chat NÃO abre sem PIN: mostra o aviso com "Tentar de novo" e o telefone da clínica', async () => {
  await incompleta(); await destrava();
  const { page, ctx } = await abrir({ init: [[() => { try { sessionStorage.setItem('csi_porta_tent', JSON.stringify({ n: 3, t: Date.now() })); } catch { /* sem armazenamento */ } }, null]] });
  await page.waitForSelector('#portaTentar', { state: 'visible', timeout: 10000 }); await espera(500);
  const href = await page.locator('#portaTentar').getAttribute('href'), txt = await page.locator('#porta').innerText();
  // o formulário do chat segue no HTML, mas o aviso é uma tela cheia por cima: o que está no ponto do formulário tem de ser o aviso
  const aindaNoChat = noChat(page), formVisivel = await page.evaluate(() => { const f = document.getElementById('formInicio'); if (!f) return false; const r = f.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + 40, innerHeight - 5)); return !(el && el.closest('#porta')); });
  const ok = aindaNoChat && !formVisivel && /\/acesso\/\?voltar=chat$/.test(href) && !/acesso\/acesso/.test(href) && /Não conseguimos abrir o seu acesso/.test(txt) && /3181-7666/.test(txt);
  await ctx.close(); return { ok, detalhe: `${href} | formVisivel=${formVisivel}` };
});
await caso('pergunta ao servidor falhou e o PIN era obrigatório neste aparelho: o chat não abre (vai para a porta); sem esse histórico, abre como antes', async () => {
  await incompleta(); await destrava();
  mundo.quedas = { app_porta: 20 };
  const a = await abrir({ init: [[() => { try { localStorage.setItem('csi_porta_v1', '1'); } catch { /* sem armazenamento */ } }, null]] });
  await espera(2500);
  const foiParaPorta = !noChat(a.page) || await a.page.locator('#porta').isVisible().catch(() => false);
  await a.ctx.close();
  mundo.quedas = { app_porta: 20 };
  const b = await abrir({ init: [[() => { try { localStorage.removeItem('csi_porta_v1'); } catch { /* sem armazenamento */ } }, null]] });
  await b.page.waitForSelector('#formInicio', { state: 'visible', timeout: 10000 }).catch(() => {}); await espera(500);
  const abriu = noChat(b.page) && await b.page.locator('#formInicio').isVisible().catch(() => false);
  await b.ctx.close(); mundo.quedas = {}; return { ok: foiParaPorta && abriu, detalhe: `lembrava=${foiParaPorta} semHistorico=${abriu}` };
});
await caso('cadastro ANTIGO (entrou com e-mail e senha, sem PIN neste aparelho): também passa pela porta e tem de criar o PIN', async () => {
  const sessao = { access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: '33333333-3333-4333-8333-333333333333', aud: 'authenticated', role: 'authenticated', email: 'antigo@exemplo.invalid', app_metadata: {}, user_metadata: {} } };
  const { page, ctx } = await abrir({ token: null, init: [[(v) => { try { localStorage.setItem('csi-paciente-auth', JSON.stringify(v)); } catch { /* sem armazenamento */ } }, sessao]] });
  await page.waitForURL(/\/acesso\//, { timeout: 8000 }).catch(() => {});
  await aguardaTexto(page, /Tenho conta com e-mail/).catch(() => {});
  const url = page.url(), t = (await texto(page)).replace(/\s+/g, ' '), tem = /Tenho conta com e-mail/.test(t) && /uma última vez/.test(t) ? 1 : 0;   // a página abre direto no passo das contas antigas (entra uma última vez e cria o PIN)
  await ctx.close();
  return { ok: /\/acesso\/\?voltar=chat/.test(url) && tem > 0, detalhe: `${url} opcaoContaAntiga=${tem} texto=${t.slice(0, 110)}` };
});
await caso('o chat manda o código do aparelho (x-acesso) em toda chamada ao banco; quem não tem aparelho não manda nada', async () => {
  await completa(); await destrava(); mundo.cab.length = 0;
  const a = await abrir(); await a.page.waitForSelector('#formInicio', { state: 'visible', timeout: 10000 }); await espera(800);
  const com = mundo.cab.filter((x) => x.nome === 'chat_config' || x.nome === 'app_perfil'); const todasCom = com.length > 0 && com.every((x) => x.x === ana.token);
  await a.ctx.close();
  mundo.cab.length = 0;
  const b = await abrir({ token: null }); await b.page.waitForURL(/\/acesso\//, { timeout: 8000 }); await espera(500);
  const semAparelho = mundo.cab.filter((x) => x.nome === 'app_porta').every((x) => x.x === null);
  await b.ctx.close();
  return { ok: todasCom && semAparelho, detalhe: `comAparelho=${com.length}/${todasCom} semAparelho=${semAparelho}` };
});
await caso('o servidor recusa com "pin_obrigatorio" (PIN vencido ou aparelho desconhecido): o chat volta à porta do PIN em vez de continuar', async () => {
  await completa(); await destrava(); mundo.recusar = { chat_config: 1 };
  const { page, ctx } = await abrir();
  await page.waitForURL(/\/acesso\//, { timeout: 8000 }).catch(() => {});
  const url = page.url(); await ctx.close(); mundo.recusar = {};
  return { ok: /\/acesso\/\?voltar=chat/.test(url), detalhe: url };
});
await caso('nenhum erro de script durante o roteiro', async () => ({ ok: true }));

await browser.close();
const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
