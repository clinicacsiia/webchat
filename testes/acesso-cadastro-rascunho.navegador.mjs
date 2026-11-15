// FLUXOGRAMA: entrada (acesso/index.html REAL num Chromium de celular, banco de teste com o retrato da produção + migrações do acesso rápido, PIN obrigatório ligado) -> validação (quem digita de verdade: cabeçalho com a logo, CPF conferido a cada letra com os dígitos verificadores, voltar/avançar no cadastro) -> lógica (nada do que a pessoa já digitou some ao voltar, ao trocar Sim/Não ou ao ir e voltar do PIN; CPF errado nem chega ao servidor) -> saída (PASS/FAIL por caso)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (padrão visual do site + CPF na hora + cadastro que não apaga o que já foi digitado)
// Dados inventados. Nada fala com o Supabase de verdade.
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from './mock-chat.mjs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db } = await criarBancoProducao();
const { q } = ajudantes(db);
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-paciente.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-chat.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-pendencias.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-filhos.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-pin-obrigatorio.sql`, 'utf8'));
await db.exec(`update public.config set valor = 'sim' where chave = 'app_pin_obrigatorio'`);
await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);

const HTML = readFileSync(`${REPO}/acesso/index.html`, 'utf8');
const ORIGEM = 'https://acesso.teste.local';
const API = 'https://nrvuynjwcgwpjdptkiay.supabase.co';
const chamadasRede = [];

// Fila única: o banco de teste tem uma conexão só.
let fila = Promise.resolve();
const serializar = (fn) => { const r = fila.then(fn, fn); fila = r.catch(() => {}); return r; };
const infoCache = new Map();
async function chamarFuncao(nome, corpo) {
  let info = infoCache.get(nome);
  if (!info) {
    info = (await db.query(`select p.proargnames as nomes, (select array_agg(format_type(t, null) order by o) from unnest(p.proargtypes::oid[]) with ordinality as x(t, o)) as tipos
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [nome])).rows[0];
    infoCache.set(nome, info);
  }
  if (!info) return { status: 404, corpo: { message: 'função inexistente' } };
  const partes = [], valores = [];
  Object.entries(corpo || {}).forEach(([k, v]) => {
    const i = info.nomes.indexOf(k);
    if (i < 0) throw new Error(`parâmetro desconhecido em ${nome}: ${k}`);
    valores.push(info.tipos[i] === 'jsonb' ? (v === null ? null : JSON.stringify(v)) : info.tipos[i] === 'boolean' ? v === true : v === null ? null : String(v));
    partes.push(`${k} => $${valores.length}::${info.tipos[i]}`);
  });
  await db.exec('reset role; set role anon');
  try { return { status: 200, corpo: (await db.query(`select public.${nome}(${partes.join(', ')}) as r`, valores)).rows[0].r }; }
  catch (e) { return { status: 400, corpo: { message: e.message } }; }
  finally { await db.exec('reset role'); }
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const erros = [];
async function novaPagina(caminho = '/', opcoes = {}, antes = null) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', ...opcoes });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push('console: ' + m.text()); });
  await ctx.route(`${ORIGEM}/**`, (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML }));
  await ctx.route(`${API}/**`, async (r) => {
    const req = r.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const nome = new URL(req.url()).pathname.split('/rpc/')[1];
    const corpo = req.postDataJSON();
    chamadasRede.push({ nome, chaves: Object.keys(corpo || {}), apikey: req.headers()['apikey'], auth: req.headers()['authorization'] });
    const res = await serializar(() => chamarFuncao(nome, corpo));
    return r.fulfill({ status: res.status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(res.corpo) });
  });
  if (antes) await ctx.addInitScript(antes);
  await page.goto(`${ORIGEM}${caminho}`);
  return { ctx, page };
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const texto = (page) => page.locator('#app').innerText();
async function pin(page, digitos) {
  for (const d of digitos) await page.locator(`.pad button[data-k="${d}"]`).click();
  await espera(450);
}
const esperaTexto = (page, re, ms = 4000) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById('app').innerText + document.body.innerText), re.source, { timeout: ms });
const n = async (sqlTexto) => (await q(sqlTexto))[0].n;

const CPF_OK = '529.982.247-25', CPF_FILHO = '111.444.777-35', CPF_ERRADO = '529.982.247-24';
const ult = (nome) => chamadasRede.filter((c) => c.nome === nome).length;
const msgCpf = (page, sel) => page.locator(sel).evaluate((i) => (i.nextElementSibling && i.nextElementSibling.classList.contains('cpfmsg') ? i.nextElementSibling.textContent : ''));

let ana = await novaPagina('/');
const { page } = ana;
await caso('padrão do site: cabeçalho com a logo da CSI no alto, com o mesmo arquivo do chat, e paleta azul', async () => {
  const d = await page.evaluate(() => { const h = document.querySelector('header.topo'), i = h && h.querySelector('img.topo-logo'); return { tem: !!i, src: i && i.getAttribute('src'), alt: i && i.alt, topo: h && h.getBoundingClientRect().top, cor: getComputedStyle(document.documentElement).getPropertyValue('--csi-primary').trim(), borda: h && getComputedStyle(h).borderBottomColor }; });
  const arquivo = existsSync(`${REPO}/img/logo-csi-simbolo.svg`);
  return { ok: d.tem && d.src === '../img/logo-csi-simbolo.svg' && /CSI/.test(d.alt) && d.topo === 0 && d.cor === '#0088cc' && d.borda === 'rgb(0, 136, 204)' && arquivo, detalhe: JSON.stringify(d) };
});
await caso('o cabeçalho continua nas outras telas (nome e nascimento)', async () => {
  await page.fill('#tel', '71991230001'); await page.click('[data-act="c1"]'); await esperaTexto(page, /Confirme quem é você/);
  return { ok: (await page.locator('header.topo img.topo-logo').count()) === 1 };
});
await caso('voltar do passo 2 ao 1 e avançar de novo: celular, nome e nascimento continuam preenchidos (mesmo sem apertar Continuar)', async () => {
  await page.fill('#nome', 'Ana Souza Teste'); await page.fill('#nasc', '1988-04-12');
  await page.click('[data-act="go"][data-v="c1"]'); const tel = await page.inputValue('#tel');
  await page.click('[data-act="c1"]'); await esperaTexto(page, /Confirme quem é você/);
  const nome = await page.inputValue('#nome'), nasc = await page.inputValue('#nasc');
  return { ok: tel === '(71) 99123-0001' && nome === 'Ana Souza Teste' && nasc === '1988-04-12', detalhe: `${tel} | ${nome} | ${nasc}` };
});
await caso('filho meio digitado: trocar Sim/Não/Sim e ir e voltar não apaga o que estava no formulário', async () => {
  await page.click('[data-act="c2"]'); await esperaTexto(page, /Você tem filhos/);
  await page.click('[data-act="tf"][data-v="1"]');
  await page.fill('#fnome', 'Leo Souza Teste'); await page.fill('#fnasc', '2019-08-30');
  await page.click('[data-act="tf"][data-v="0"]'); await page.click('[data-act="tf"][data-v="1"]');
  const a = [await page.inputValue('#fnome'), await page.inputValue('#fnasc')];
  await page.click('[data-act="go"][data-v="c2"]'); await page.click('[data-act="c2"]'); await esperaTexto(page, /Você tem filhos/);
  const b = [await page.inputValue('#fnome'), await page.inputValue('#fnasc')];
  return { ok: a.join() === 'Leo Souza Teste,2019-08-30' && b.join() === 'Leo Souza Teste,2019-08-30', detalhe: a.join() + ' / ' + b.join() };
});
await caso('adicionar o filho limpa o formulário (o rascunho não volta a aparecer)', async () => {
  await page.click('[data-act="addf"]'); await esperaTexto(page, /Leo Souza Teste/);
  return { ok: (await page.inputValue('#fnome')) === '' && (await page.inputValue('#fnasc')) === '' };
});
await caso('tela do CPF: um por pessoa (ela e o filho), ainda sem aviso de erro', async () => {
  await page.click('[data-act="c3"]'); await esperaTexto(page, /Seu CPF/);
  return { ok: (await page.locator('input[data-cp]').count()) === 2 && (await msgCpf(page, 'input[data-cp="eu"]')) === '' };
});
await caso('CPF com 11 números errado é acusado na hora, sem apertar nada; o certo mostra "confere"; incompleto não acusa enquanto digita', async () => {
  const eu = 'input[data-cp="eu"]';
  await page.fill(eu, '5299822'); const parcial = await msgCpf(page, eu);
  await page.fill(eu, CPF_ERRADO.replace(/\D/g, '')); const errado = await msgCpf(page, eu); const inv = await page.locator(eu).getAttribute('aria-invalid');
  await page.fill(eu, '111.111.111-11'); const iguais = await msgCpf(page, eu);
  await page.fill(eu, CPF_OK); const certo = await msgCpf(page, eu); const inv2 = await page.locator(eu).getAttribute('aria-invalid');
  return { ok: parcial === '' && /não conferem/.test(errado) && inv === 'true' && /não conferem/.test(iguais) && /confere/.test(certo) && !/não/.test(certo) && inv2 === 'false', detalhe: JSON.stringify({ parcial, errado, iguais, certo }) };
});
await caso('CPF errado não passa nem vai ao servidor; a mensagem diz de quem é e o cursor vai para o campo', async () => {
  const antes = ult('app_pin_criar') + ult('app_pre_cadastro') + ult('app_cadastrar');
  await page.fill('input[data-cp="0"]', CPF_ERRADO);
  await page.click('[data-act="c3b"]'); const t = await texto(page);
  const foco = await page.evaluate(() => document.activeElement && document.activeElement.dataset.cp);
  const depois = ult('app_pin_criar') + ult('app_pre_cadastro') + ult('app_cadastrar');
  return { ok: /CPF de Leo não confere/.test(t) && /Seu CPF/.test(t) && foco === '0' && antes === depois, detalhe: t.replace(/\s+/g, ' ').slice(0, 160) };
});
await caso('o que já foi digitado nos CPFs não some ao voltar e avançar (nem o do filho, mesmo errado)', async () => {
  await page.click('[data-act="go"][data-v="c3"]'); await esperaTexto(page, /Você tem filhos/);
  await page.click('[data-act="c3"]'); await esperaTexto(page, /Seu CPF/);
  const eu = await page.inputValue('input[data-cp="eu"]'), filho = await page.inputValue('input[data-cp="0"]');
  const aviso = await msgCpf(page, 'input[data-cp="0"]');
  return { ok: eu === CPF_OK && filho === CPF_ERRADO && /não conferem/.test(aviso), detalhe: `${eu} | ${filho} | ${aviso}` };
});
await caso('corrigido o CPF do filho, segue; o contato de confiança digitado sobrevive à ida ao PIN e volta', async () => {
  await page.fill('input[data-cp="0"]', CPF_FILHO); await page.click('[data-act="c3b"]'); await esperaTexto(page, /Número de confiança/);
  await page.fill('#ctnome', 'Maria Teste'); await page.fill('#cttel', '71988887777'); await page.selectOption('#ctrel', 'Irmão(ã)');
  await page.click('[data-act="c4"]'); await esperaTexto(page, /Crie seu PIN/);
  await page.click('[data-act="go"][data-v="c4"]'); await esperaTexto(page, /Número de confiança/);
  const v = [await page.inputValue('#ctnome'), await page.inputValue('#cttel'), await page.inputValue('#ctrel')];
  return { ok: v.join() === 'Maria Teste,(71) 98888-7777,Irmão(ã)', detalhe: v.join() };
});
await caso('cadastro termina com os dois CPFs certos gravados', async () => {
  await page.click('[data-act="c4"]'); await esperaTexto(page, /Crie seu PIN/);
  await pin(page, '1357'); await pin(page, '1357'); await esperaTexto(page, /Olá, Ana/);
  const eu = (await q(`select cpf from public.app_paciente where telefone = '71991230001'`))[0].cpf;
  const f = (await q(`select cpf from public.app_filho order by criado_em`))[0].cpf;
  return { ok: eu === '52998224725' && f === '11144477735', detalhe: `${eu} ${f}` };
});
await caso('terminado o cadastro, os rascunhos são apagados da memória da página', async () => ({ ok: (await page.evaluate(() => Object.keys(S.rasc).length)) === 0 }));
await caso('Meus dados: o CPF é conferido na hora no painel de baixo; errado não vai ao servidor', async () => {
  await page.click('[data-act="go"][data-v="dados"]');
  await page.click('[data-act="sheet"][data-t="cpf"][data-p="eu"]');
  const antes = ult('app_pessoa_cpf_salvar');
  await page.fill('#cpfn', CPF_ERRADO.replace(/\D/g, '')); const m = await msgCpf(page, '#cpfn');
  await page.click('[data-act="scpf"]'); await espera(300);
  return { ok: /não conferem/.test(m) && ult('app_pessoa_cpf_salvar') === antes, detalhe: m };
});
await caso('logo também aparece na tela do PIN (aparelho já cadastrado)', async () => {
  await page.reload(); await esperaTexto(page, /Digite seu PIN/);
  return { ok: (await page.locator('header.topo img.topo-logo').count()) === 1 };
});
await caso('nenhum erro de script nem violação da política de segurança', async () => ({ ok: erros.length === 0, detalhe: erros.slice(0, 3).join(' | ') }));

await browser.close();
const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
