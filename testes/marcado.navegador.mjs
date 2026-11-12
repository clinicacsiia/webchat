// FLUXOGRAMA: entrada (chat do paciente + Supabase simulado; o assistente manda "reservando…" e depois o cartão do agendamento) -> validação (o cartão mostra quando, o quê, onde, com quem e o protocolo; texto sempre como texto puro; botão para a agenda do celular)
//   -> saída (PASS/FAIL por caso)
// Versão 1.0 — 12/11/2026 / Mudança: primeira versão (autoatendimento com a API do Klingo: widgets "marcando" e "marcado")
import { chromium, servidor, criarMundo, novaPaginaChat, comecarConversa } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const TESTE = [[() => { window.__WEBCHAT_TESTE__ = {}; }, null]];

async function entregar(mundo, page, texto, opcoes) {
  const m = mundo.inserir('agente', texto, opcoes);
  await page.evaluate((x) => window.__WEBCHAT_TESTE__.adicionar(x, false), { id: m.id, autor: 'agente', texto: m.texto, opcoes: m.opcoes, criado_em: m.criado_em });
  await espera(400);
}
const VOUCHER = { id: '26700', data: '2026-11-20', hora: '09:40', procedimento: 'CONSULTA', unidade: 'DESENVOAR', profissional: 'GEANNE <b>PINHEIRO</b>' };

await caso('"Reservando o seu horário…" aparece como aviso de andamento (leitor de tela avisa) e não pede nenhuma resposta', async () => {
  const mundo = criarMundo();
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init: TESTE });
  await comecarConversa(page, base);
  await entregar(mundo, page, 'Perfeito! Estou reservando o seu horário no sistema da clínica.', { tipo: 'marcando', operacao: 'x' });
  const d = await page.evaluate(() => { const w = [...document.querySelectorAll('#msgs .widget[data-tipo="marcando"]')].pop(); const a = w && w.querySelector('.acomp');
    return { achou: !!w, texto: a ? a.innerText : '', papel: a ? a.getAttribute('role') : null, botoes: w ? w.querySelectorAll('button').length : -1 }; });
  await ctx.close();
  return { ok: d.achou && /Reservando o seu horário/.test(d.texto) && d.papel === 'status' && d.botoes === 0 && !erros.excecoes.length, detalhe: JSON.stringify(d) };
});

await caso('cartão do agendamento: quando, o quê, onde, com quem e protocolo; nome do médico como texto puro (nada de HTML)', async () => {
  const mundo = criarMundo();
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init: TESTE });
  await comecarConversa(page, base);
  await entregar(mundo, page, 'Pronto! Seu agendamento está confirmado.', { tipo: 'marcado', voucher: VOUCHER });
  const d = await page.evaluate(() => { const c = [...document.querySelectorAll('#msgs .cartao-marcado')].pop();
    return { achou: !!c, texto: c ? c.innerText : '', negrito: c ? [...c.querySelectorAll('b')].some((b) => b.innerText === 'PINHEIRO') : false, papel: c ? c.getAttribute('role') : null, rotulo: c ? c.getAttribute('aria-label') : null }; });
  await ctx.close();
  return { ok: d.achou && /Agendamento confirmado/.test(d.texto) && /09:40/.test(d.texto) && /sexta/i.test(d.texto) && /20 de novembro/i.test(d.texto) && /DESENVOAR/i.test(d.texto) && /26700/.test(d.texto) && /<b>PINHEIRO<\/b>/i.test(d.texto) && !d.negrito
    && d.papel === 'group' && /confirmado/i.test(d.rotulo || '') && !erros.excecoes.length, detalhe: d.texto.replace(/\n/g, ' | ').slice(0, 200) };
});

await caso('o botão "Adicionar à minha agenda" baixa um arquivo .ics com o horário certo e sem quebrar com vírgulas ou quebras de linha', async () => {
  const mundo = criarMundo();
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init: TESTE });
  await comecarConversa(page, base);
  await entregar(mundo, page, 'Pronto!', { tipo: 'marcado', voucher: { ...VOUCHER, unidade: 'CLÍNICA, UNIDADE 2\nlinha dois' } });
  const d = await page.evaluate(async () => { const a = [...document.querySelectorAll('#msgs a.btn-w[download]')].pop(); if (!a) return { achou: false };
    const t = await (await fetch(a.href)).text(); return { achou: true, nome: a.getAttribute('download'), href: a.href.slice(0, 5), t }; });
  await ctx.close();
  const linhas = (d.t || '').split('\r\n');
  return { ok: d.achou && d.nome === 'agendamento-csi.ics' && d.href === 'blob:' && linhas[0] === 'BEGIN:VCALENDAR' && linhas.includes('DTSTART:20261120T094000') && linhas.includes('DTEND:20261120T104000')
    && linhas.some((l) => l.startsWith('LOCATION:CLÍNICA  UNIDADE 2 linha dois')) && linhas.at(-1) === 'END:VCALENDAR' && !erros.excecoes.length, detalhe: linhas.slice(0, 9).join(' / ').slice(0, 220) };
});

await caso('cartão sem data ou hora (voucher incompleto): mostra o que tem e não oferece o botão da agenda, sem erro na tela', async () => {
  const mundo = criarMundo();
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init: TESTE });
  await comecarConversa(page, base);
  await entregar(mundo, page, 'Pronto!', { tipo: 'marcado', voucher: { id: '26701' } });
  const d = await page.evaluate(() => ({ cartao: !![...document.querySelectorAll('#msgs .cartao-marcado')].pop(), botao: document.querySelectorAll('#msgs a.btn-w[download]').length, texto: ([...document.querySelectorAll('#msgs .cartao-marcado')].pop() || {}).innerText }));
  await ctx.close();
  return { ok: d.cartao && d.botao === 0 && /26701/.test(d.texto) && !erros.excecoes.length, detalhe: JSON.stringify(d) };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
