// FLUXOGRAMA: entrada (chat do paciente + Supabase simulado; mensagem de despedida chegando como mensagem de sistema com opcoes.tipo = 'despedida') -> validação (texto sempre como texto puro; imagem só quando a mensagem diz que há e só com o token da própria conversa) -> lógica (busca a imagem por chat_despedida_imagem, mostra com texto alternativo, e continua sem imagem se a busca falhar) -> saída (PASS/FAIL por caso).
// Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-06)
import { chromium, servidor, criarMundo, novaPaginaChat, comecarConversa } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const TESTE = [[() => { window.__WEBCHAT_TESTE__ = {}; }, null]];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Faz o banco "entregar" a despedida: grava a mensagem de sistema e a empurra para a tela como o aviso em tempo real faria.
async function entregar(mundo, page, texto, opcoes) {
  const m = mundo.inserir('sistema', texto, opcoes);
  await page.evaluate((x) => window.__WEBCHAT_TESTE__.adicionar(x, false), { id: m.id, autor: 'sistema', texto: m.texto, opcoes: m.opcoes, criado_em: m.criado_em });
  await espera(400);
}
function mundoComImagem(falha = false) {
  const mundo = criarMundo(); const tratar = mundo.tratar;
  mundo.tratar = async (nome, corpo, cab) => {
    if (nome === 'chat_despedida_imagem') {
      mundo.chamadas.push({ nome, corpo, t: Date.now() });
      return falha ? { status: 400, body: { code: 'XX000', message: 'falha simulada' } } : { body: { mime: 'image/png', base64: PNG } };
    }
    return tratar(nome, corpo, cab);
  };
  return mundo;
}

await caso('despedida com imagem: o texto aparece como texto puro e a imagem é buscada com o token da conversa', async () => {
  const mundo = mundoComImagem();
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init: TESTE });
  await comecarConversa(page, base);
  await entregar(mundo, page, '<b>Obrigado</b> pelo contato!', { tipo: 'despedida', versao: 7, imagem: true, encerrada_em: '2026-11-09T10:00:00Z' });
  await page.waitForSelector('#msgs img.desp-img:not([hidden])', { timeout: 5000 });
  const dados = await page.evaluate(() => { const n = [...document.querySelectorAll('#msgs .msg.sistema')].pop(); const i = n.querySelector('img.desp-img');
    return { texto: n.innerText, negrito: !!n.querySelector('b'), src: i.getAttribute('src').slice(0, 22), alt: i.getAttribute('alt') }; });
  const ch = mundo.chamadas.find((c) => c.nome === 'chat_despedida_imagem');
  await ctx.close();
  return { ok: /<b>Obrigado<\/b> pelo contato!/.test(dados.texto) && !dados.negrito && dados.src.startsWith('data:image/png;base64') && /Imagem enviada pela clínica/.test(dados.alt)
    && ch && ch.corpo.p_token === 'token-de-teste' && ch.corpo.p_versao === 7 && !erros.excecoes.length, detalhe: JSON.stringify(dados) };
});

await caso('despedida sem imagem: só o texto, nenhuma busca de imagem e nenhum bloco vazio', async () => {
  const mundo = mundoComImagem();
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init: TESTE });
  await comecarConversa(page, base);
  await entregar(mundo, page, 'Atendimento encerrado. Se precisar, é só mandar uma nova mensagem.', { tipo: 'despedida', versao: null, imagem: false, encerrada_em: '2026-11-09T10:00:00Z' });
  const dados = await page.evaluate(() => { const n = [...document.querySelectorAll('#msgs .msg.sistema')].pop(); return { texto: n.innerText, widgets: n.querySelectorAll('.widget').length, imgs: n.querySelectorAll('img').length }; });
  const buscou = mundo.chamadas.some((c) => c.nome === 'chat_despedida_imagem');
  await ctx.close();
  return { ok: /Atendimento encerrado/.test(dados.texto) && dados.widgets === 0 && dados.imgs === 0 && !buscou && !erros.excecoes.length, detalhe: JSON.stringify(dados) };
});

await caso('a busca da imagem falha: o texto da despedida continua na tela, sem erro', async () => {
  const mundo = mundoComImagem(true);
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init: TESTE });
  await comecarConversa(page, base);
  await entregar(mundo, page, 'Até logo!', { tipo: 'despedida', versao: 9, imagem: true, encerrada_em: '2026-11-09T10:00:00Z' });
  await espera(500);
  const dados = await page.evaluate(() => { const n = [...document.querySelectorAll('#msgs .msg.sistema')].pop(); return { texto: n.innerText, visiveis: n.querySelectorAll('img:not([hidden])').length }; });
  await ctx.close();
  return { ok: /Até logo!/.test(dados.texto) && dados.visiveis === 0 && !erros.excecoes.length, detalhe: JSON.stringify(dados) };
});

await caso('mensagens de sistema antigas (sem opcoes) continuam iguais', async () => {
  const mundo = mundoComImagem();
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init: TESTE });
  await comecarConversa(page, base);
  await entregar(mundo, page, 'Atendimento encerrado. Se precisar, é só mandar uma nova mensagem.', null);
  const t = await page.evaluate(() => [...document.querySelectorAll('#msgs .msg.sistema')].pop().innerText);
  await ctx.close();
  return { ok: /Atendimento encerrado/.test(t) && !erros.excecoes.length };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
