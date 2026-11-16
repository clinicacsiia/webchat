// FLUXOGRAMA: entrada (o minha-vez/index.html REAL num Chromium de celular; o Supabase e a Edge Function app-laudos são simulados por interceptação de rede) -> validação (cartão só aparece com algo a mostrar; PIN vencido volta ao teclado;
//   nada de PDF nem CPF fica guardado no aparelho) -> lógica (listar, baixar quantas vezes quiser, laudo retirado pela equipe, em revisão, aguardando, sem CPF, cadastro não confirmado, queda de rede) -> saída (PASS/FAIL por caso)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (laudos no aplicativo). O banco é provado em sql-laudos-no-app.test.mjs e a função em supabase/functions/app-laudos/laudos.test.ts.
// Dados inventados. Requer Chromium (CHROMIUM_PATH ou o do Playwright).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium } from './mock-chat.mjs';
import { REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, d = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, 'exceção: ' + String(e.message).split('\n')[0]); } };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  const f = resolve(REPO, '.' + new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html'));
  if (!f.startsWith(REPO) || !existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TIPOS[extname(f)] || 'application/octet-stream' }).end(readFileSync(f));
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const lib = readFileSync(resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'), 'utf8');

const DEV = 'dispositivo-de-teste';
const PDF_TXT = '%PDF-1.4 laudo de teste';
const PDF_B64 = Buffer.from(PDF_TXT).toString('base64');
const dia = (n) => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const pedidos = () => ({
  ok: true, nome: 'Ana Souza Teste', telefone_final: '0001', email_salvo: true,
  pessoas: [{ nome: 'Ana Souza Teste', eu: true }, { nome: 'Leo Souza Teste', eu: false }],
  pedidos: [], novidades: 0, resultados: [],
});
const lista = (extra = {}) => ({
  ok: true,
  pessoas: [{ nome: 'Ana Souza Teste', eu: true, situacao: 'confere' }, { nome: 'Leo Souza Teste', eu: false, situacao: 'confere' }],
  itens: [
    { id: '501', pessoa: 'Ana Souza Teste', eu: true, nome: 'RM JOELHO DIREITO', data: dia(-5), unidade: 'Centro', estado: 'disponivel' },
    { id: '502', pessoa: 'Ana Souza Teste', eu: true, nome: 'US ABDOME TOTAL', data: dia(-3), unidade: 'Centro', estado: 'em_revisao' },
    { id: '601', pessoa: 'Leo Souza Teste', eu: false, nome: 'RX TORAX', data: dia(-1), unidade: 'Centro', estado: 'aguardando' },
  ], ...extra,
});

async function abrirPortal({ listar = () => lista(), baixar = () => ({ ok: true, arquivos: [{ nome: 'laudo-rm-joelho.pdf', mime: 'application/pdf', base64: PDF_B64 }] }), bloqueado = false } = {}) {
  const ctx = await browser.newContext({ permissions: [], viewport: { width: 390, height: 780 }, acceptDownloads: true });
  await ctx.addInitScript((t) => { try { localStorage.setItem('csi_acesso_v2', JSON.stringify({ dev: t, nome1: 'Ana' })); } catch { /* sem armazenamento */ } }, DEV);
  const estado = { listar: [], baixar: [], rpcs: [], bloqueado, pinCerto: '1357' };
  await ctx.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: lib }));
  await ctx.route('**/*.supabase.co/**', async (r) => {
    const u = new URL(r.request().url());
    const cab = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const j = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: cab, body: JSON.stringify(body) });
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cab });
    if (u.pathname === '/functions/v1/app-laudos') {
      const c = JSON.parse(r.request().postData() || '{}');
      if (c.acao === 'listar') { estado.listar.push(c); const x = listar(estado.listar.length, c); return x === 'queda' ? r.abort() : j(x); }
      if (c.acao === 'baixar') { estado.baixar.push(c); const x = baixar(estado.baixar.length, c); return x === 'queda' ? r.abort() : j(x); }
      return j({ ok: false });
    }
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const nome = u.pathname.split('/').pop(); let c = {}; try { c = JSON.parse(r.request().postData() || '{}'); } catch { /* sem corpo */ }
      estado.rpcs.push(nome);
      switch (nome) {
        case 'app_pedidos': return estado.bloqueado ? j({ ok: false, erro: 'bloqueado', mensagem: 'Digite seu PIN para continuar.' }) : j(pedidos());
        case 'app_desbloquear': if (c.p_pin === estado.pinCerto) { estado.bloqueado = false; return j({ ok: true }); } return j({ ok: false, erro: 'pin', mensagem: 'PIN incorreto.' });
        case 'app_perfil': return j({ ok: true, perfil: { nome: 'Ana Souza Teste' } });
        case 'app_pedido_visto': return j({ ok: true });
        case 'fila_config_publica': return j({ vapid: null });
        default: return j(null);
      }
    }
    return j([]);
  });
  const page = await ctx.newPage();
  const erros = []; page.on('pageerror', (e) => erros.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${base}/minha-vez/?acompanhar=1`);
  await espera(900);
  return { page, ctx, estado, erros };
}
const textoDe = (page) => page.$eval('#raiz', (n) => n.innerText);

await caso('paciente que nunca usou o chat: ao abrir o portal os laudos já aparecem (a função recebe o código do aparelho, sem CPF)', async () => {
  const { page, ctx, estado, erros } = await abrirPortal();
  const t = await textoDe(page);
  await ctx.close();
  return { ok: /Meus laudos/.test(t) && /Baixar laudo \(PDF\)/.test(t) && estado.listar.length === 1 && estado.listar[0].token === DEV && !('cpf' in estado.listar[0]) && erros.length === 0, detalhe: t.slice(0, 160).replace(/\n/g, ' | ') };
});
await caso('cada estado tem o seu texto: disponível (botão), em revisão (aviso, sem botão), aguardando (aviso, sem botão); o filho aparece com o nome', async () => {
  const { page, ctx } = await abrirPortal();
  const botoes = await page.$$eval('#laudos button[data-laudo]', (ns) => ns.map((n) => n.dataset.laudo));
  const rev = await page.$eval('#laudos .exame[data-id="502"]', (n) => n.innerText);
  const agu = await page.$eval('#laudos .exame[data-id="601"]', (n) => n.innerText);
  await ctx.close();
  return { ok: botoes.join() === '501' && /em revisão pela equipe/.test(rev) && !/Baixar/.test(rev) && /Aguardando a liberação/.test(agu) && /Leo/.test(agu) && !/Baixar/.test(agu), detalhe: JSON.stringify({ botoes, rev: rev.slice(0, 60) }) };
});
await caso('o disponível vem primeiro, depois "em revisão", depois "aguardando"', async () => {
  const { page, ctx } = await abrirPortal({ listar: () => lista({ itens: lista().itens.slice().reverse() }) });
  const ids = await page.$$eval('#laudos .exame', (ns) => ns.map((n) => n.dataset.id));
  await ctx.close();
  return { ok: ids.join() === '501,502,601', detalhe: ids.join() };
});
await caso('Baixar: chama a função com o id, o arquivo é um PDF de verdade e o nome vem do servidor', async () => {
  const { page, ctx, estado } = await abrirPortal();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('button[data-laudo="501"]')]);
  const bytes = readFileSync(await dl.path()).toString();
  await ctx.close();
  return { ok: dl.suggestedFilename() === 'laudo-rm-joelho.pdf' && bytes === PDF_TXT && estado.baixar.length === 1 && estado.baixar[0].id === '501' && estado.baixar[0].token === DEV, detalhe: dl.suggestedFilename() + ' ' + bytes.slice(0, 10) };
});
await caso('exame com 2 laudos: não dispara 2 downloads de uma vez; mostra um link para cada e cada link baixa o seu PDF', async () => {
  const dois = () => ({ ok: true, arquivos: [{ nome: 'laudo-a.pdf', mime: 'application/pdf', base64: PDF_B64 }, { nome: 'laudo-b-2.pdf', mime: 'application/pdf', base64: PDF_B64 }] });
  const { page, ctx } = await abrirPortal({ baixar: dois });
  let auto = 0; page.on('download', () => { auto++; });
  await page.click('button[data-laudo="501"]');
  await espera(900);
  const antes = auto;
  const links = await page.$$eval('#laudos a.abrir-laudo', (ns) => ns.map((n) => n.textContent));
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#laudos a.abrir-laudo >> nth=1')]);
  await ctx.close();
  return { ok: antes === 0 && links.length === 2 && /laudo 1 de 2/.test(links[0]) && /laudo 2 de 2/.test(links[1]) && dl.suggestedFilename() === 'laudo-b-2.pdf', detalhe: JSON.stringify({ antes, links, nome: dl.suggestedFilename() }) };
});
await caso('baixar quantas vezes quiser: cada toque faz uma nova conferência com a clínica (3 toques = 3 chamadas) e 3 downloads', async () => {
  const { page, ctx, estado } = await abrirPortal();
  let baixados = 0;
  for (let i = 0; i < 3; i++) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('button[data-laudo="501"]')]);
    if (readFileSync(await dl.path()).toString() === PDF_TXT) baixados++;
    await espera(200);
  }
  await ctx.close();
  return { ok: baixados === 3 && estado.baixar.length === 3, detalhe: `${baixados} downloads, ${estado.baixar.length} chamadas` };
});
await caso('a equipe RETIROU o laudo para ajuste: o download é recusado, nenhum arquivo sai, o aviso aparece e o cartão passa a "em revisão" sozinho', async () => {
  let retirado = false;
  const { page, ctx, estado } = await abrirPortal({
    listar: () => (retirado ? lista({ itens: lista().itens.map((i) => (i.id === '501' ? { ...i, estado: 'em_revisao' } : i)) }) : lista()),
    baixar: () => { retirado = true; return { ok: false, erro: 'indisponivel', mensagem: 'Este laudo está em revisão pela equipe e não pode ser baixado agora. Assim que for liberado de novo, ele volta a aparecer aqui.' }; },
  });
  let baixou = false; page.on('download', () => { baixou = true; });
  await page.click('button[data-laudo="501"]');
  await espera(900);
  const t = await textoDe(page);
  const botoes = await page.$$eval('#laudos button[data-laudo]', (ns) => ns.length);
  await ctx.close();
  return { ok: !baixou && /em revisão pela equipe e não pode ser baixado/.test(t) && botoes === 0 && estado.listar.length === 2, detalhe: JSON.stringify({ baixou, botoes, listar: estado.listar.length }) };
});
await caso('Klingo/servidor fora do ar no download: aviso, nada baixado e o botão continua disponível para tentar de novo', async () => {
  const { page, ctx } = await abrirPortal({ baixar: () => ({ ok: false, erro: 'klingo', mensagem: 'Não foi possível consultar a clínica agora. Tente de novo em instantes.' }) });
  let baixou = false; page.on('download', () => { baixou = true; });
  await page.click('button[data-laudo="501"]');
  await espera(700);
  const t = await textoDe(page), ainda = await page.$('button[data-laudo="501"]:not([disabled])');
  await ctx.close();
  return { ok: !baixou && /Não foi possível consultar a clínica agora/.test(t) && !!ainda, detalhe: t.slice(0, 120).replace(/\n/g, ' | ') };
});
await caso('PIN vencido ao abrir a lista: volta ao teclado do PIN; com o PIN certo os laudos carregam', async () => {
  let n = 0;
  const { page, ctx, estado } = await abrirPortal({ listar: () => (++n === 1 ? { ok: false, erro: 'bloqueado', mensagem: 'Digite seu PIN para continuar.' } : lista()) });
  const pedePin = /PIN/.test(await textoDe(page)) && !!(await page.$('.pin-teclas'));
  for (const d of '1357') await page.click(`.pin-teclas [data-tecla="${d}"]`);
  await espera(1200);
  const t = await textoDe(page);
  await ctx.close();
  return { ok: pedePin && /Meus laudos/.test(t) && estado.listar.length === 2, detalhe: `pede=${pedePin} listar=${estado.listar.length}` };
});
await caso('PIN vencido no meio do download: volta ao teclado do PIN e nada é baixado', async () => {
  const { page, ctx } = await abrirPortal({ baixar: () => ({ ok: false, erro: 'bloqueado', mensagem: 'Digite seu PIN para continuar.' }) });
  let baixou = false; page.on('download', () => { baixou = true; });
  await page.click('button[data-laudo="501"]');
  await espera(700);
  const pedePin = !!(await page.$('.pin-teclas'));
  await ctx.close();
  return { ok: pedePin && !baixou };
});
await caso('titular sem CPF: aviso com link para Meus dados (e nenhum CPF na tela); filho conferido continua aparecendo', async () => {
  const { page, ctx } = await abrirPortal({ listar: () => ({ ok: true, pessoas: [{ nome: 'Ana Souza Teste', eu: true, situacao: 'sem_cpf' }, { nome: 'Leo Souza Teste', eu: false, situacao: 'confere' }], itens: [lista().itens[2]] }) });
  const t = await textoDe(page), link = await page.$eval('#laudos a[href*="ir=dados"]', (a) => a.getAttribute('href')).catch(() => null);
  await ctx.close();
  return { ok: /Para ver os seus laudos, informe o CPF em/.test(t) && !!link && /Leo/.test(t), detalhe: t.slice(0, 200).replace(/\n/g, ' | ') };
});
await caso('cadastro que a clínica não confirmou ("divergente"): pede para conferir os dados, sem dizer qual dado errou', async () => {
  const { page, ctx } = await abrirPortal({ listar: () => ({ ok: true, pessoas: [{ nome: 'Ana Souza Teste', eu: true, situacao: 'divergente' }], itens: [] }) });
  const t = await textoDe(page);
  await ctx.close();
  return { ok: /Não conseguimos confirmar na clínica o seu cadastro\./.test(t) && /CPF, a data de nascimento e o nome/.test(t), detalhe: t.slice(0, 200).replace(/\n/g, ' | ') };
});
await caso('paciente novo (a clínica ainda não tem cadastro, sem exames): nenhum cartão de laudos aparece (nada de aviso assustador)', async () => {
  const { page, ctx } = await abrirPortal({ listar: () => ({ ok: true, pessoas: [{ nome: 'Ana Souza Teste', eu: true, situacao: 'nao_encontrado' }, { nome: 'Leo Souza Teste', eu: false, situacao: 'sem_cadastro' }], itens: [] }) });
  const tem = await page.$('#laudos');
  const t = await textoDe(page);
  await ctx.close();
  return { ok: !tem && /Acompanhe seus pedidos/.test(t) };
});
await caso('a função dos laudos fora do ar não derruba a página: os pedidos continuam, o cartão mostra o erro e o botão "Atualizar laudos" tenta de novo (forcar=true)', async () => {
  let n = 0;
  const { page, ctx, estado, erros } = await abrirPortal({ listar: () => (++n === 1 ? 'queda' : lista()) });
  const t1 = await textoDe(page);
  await page.click('#laudosAtualizar');
  await espera(900);
  const t2 = await textoDe(page);
  await ctx.close();
  return { ok: /Acompanhe seus pedidos/.test(t1) && /Sem conexão para consultar os laudos/.test(t1) && /Baixar laudo/.test(t2) && estado.listar[1].forcar === true && erros.length === 0, detalhe: `forcar=${estado.listar[1] && estado.listar[1].forcar}` };
});
await caso('o aparelho não guarda laudo: depois do download não há PDF nem CPF no localStorage nem no HTML da página', async () => {
  const { page, ctx } = await abrirPortal();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('button[data-laudo="501"]')]);
  await dl.path(); await espera(300);
  const guardado = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  const html = await page.content();
  await ctx.close();
  return { ok: !guardado.includes(PDF_B64) && !html.includes(PDF_B64) && !/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/.test(guardado), detalhe: guardado.slice(0, 80) };
});
await caso('chamada à função leva só o código do aparelho e a chave pública (nunca e-mail, CPF ou nome)', async () => {
  const { page, ctx, estado } = await abrirPortal();
  await page.click('button[data-laudo="501"]').catch(() => {});
  await espera(500);
  const chaves = [...new Set([...estado.listar, ...estado.baixar].flatMap((c) => Object.keys(c)))].sort();
  await ctx.close();
  return { ok: chaves.every((k) => ['acao', 'token', 'forcar', 'id'].includes(k)), detalhe: chaves.join() };
});

await browser.close(); srv.close();
const falhou = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhou} de ${resultados.length} casos passaram`);
process.exit(falhou ? 1 : 0);
