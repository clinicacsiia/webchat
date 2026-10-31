// FLUXOGRAMA: entrada (chat do paciente + Supabase simulado com atrasos controlados) -> validação (a resposta do assistente chega ANTES da chamada do paciente voltar) -> lógica (confere a ordem na tela, a pergunta nova ativa, o cursor de consulta e a recuperação do cache antigo) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
//
// Reproduz o defeito relatado por uma paciente em teste (31/10/2026): ela tocou em "Exame" e a resposta do assistente
// apareceu antes da mensagem dela; a pergunta nova ficou apagada e a conversa "bugou". Requer um Chromium (CHROMIUM_PATH).
import { chromium, servidor, criarMundo, novaPaginaChat, comecarConversa, ordemNaTela } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const TESTE = [[() => { window.__WEBCHAT_TESTE__ = {}; }, null]];

await caso('a resposta chega antes da chamada do paciente voltar: a mensagem dele continua em cima e a pergunta nova fica ativa', async () => {
  const mundo = criarMundo({ escondeCliente: true, atraso: { chat_responder: 0 }, atrasoDepois: 1500 });
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo);
  await comecarConversa(page, base);
  await page.click('#msgs .op >> text=Exame');
  await espera(350);
  await page.evaluate(() => dispatchEvent(new Event('online')));   // a consulta de rotina traz a resposta antes da chamada do paciente voltar
  await page.waitForSelector('#msgs .msg.agente >> text=particular ou por convênio', { timeout: 6000 });
  await page.waitForFunction(() => !document.querySelector('#msgs .msg.pendente'), null, { timeout: 6000 });
  await espera(300);
  const ordem = await ordemNaTela(page);
  const textos = ordem.map(([q]) => q).join('');
  const ativa = await page.$$eval('#msgs .msg.agente:last-of-type .widget .op', (bs) => bs.length > 0 && bs.every((b) => !b.disabled));
  await ctx.close();
  return { ok: textos === 'ACA' && ativa && erros.excecoes.length === 0, detalhe: `ordem=${textos} (esperado ACA), pergunta nova ativa=${ativa}${erros.excecoes[0] ? ', ' + erros.excecoes[0] : ''}` };
});

await caso('a mensagem do paciente que chegou depois da resposta é encaixada na ordem do banco (outro aparelho)', async () => {
  const mundo = criarMundo();
  const { page, ctx } = await novaPaginaChat(browser, mundo, { init: TESTE });
  await comecarConversa(page, base);
  const ok = await page.evaluate(() => {
    const t = window.__WEBCHAT_TESTE__;
    if (!t || !t.adicionar) return false;
    const agora = new Date().toISOString();
    t.adicionar({ id: 202, autor: 'agente', texto: 'segunda', opcoes: null, criado_em: agora }, false);
    t.adicionar({ id: 201, autor: 'cliente', texto: 'primeira', opcoes: null, criado_em: agora }, false);
    return true;
  });
  await espera(200);
  const ordem = (await ordemNaTela(page)).map(([q, t]) => q + ':' + t);
  await ctx.close();
  const certo = ordem.join('|').endsWith('C:primeira|A:segunda');
  return { ok: ok && certo, detalhe: ordem.join(' | ') };
});

await caso('o cursor de consulta só avança pela consulta ao servidor: mensagem anterior a uma que chegou por aviso instantâneo não se perde', async () => {
  const mundo = criarMundo();
  const { page, ctx } = await novaPaginaChat(browser, mundo, { init: TESTE });
  await comecarConversa(page, base);
  // Simula o aviso instantâneo trazendo só a resposta (id 301) enquanto a mensagem do paciente (id 300) ainda está a caminho.
  mundo.prox = 299;
  const cli = mundo.inserir('cliente', 'texto que o aviso não trouxe');
  const ag = mundo.inserir('agente', 'resposta que o aviso trouxe', null);
  await page.evaluate((a) => window.__WEBCHAT_TESTE__.adicionar(a, false), { id: ag.id, autor: 'agente', texto: ag.texto, opcoes: null, criado_em: ag.criado_em });
  const antes = mundo.chamadas.filter((c) => c.nome === 'chat_listar').length;
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await page.waitForFunction((n) => true, null);
  await espera(600);
  const listagens = mundo.chamadas.filter((c) => c.nome === 'chat_listar').slice(antes);
  const apos = listagens.length ? listagens[listagens.length - 1].corpo.p_apos : null;
  const ordem = (await ordemNaTela(page)).map(([q]) => q).join('');
  await ctx.close();
  return { ok: apos !== null && apos < cli.id && ordem.endsWith('CA'), detalhe: `p_apos=${apos} (precisa ser menor que ${cli.id}), ordem final=${ordem}` };
});

await caso('abrir com cópia guardada de outra versão do chat: ignora a cópia e busca a conversa do servidor', async () => {
  const mundo = criarMundo();
  const { page, ctx } = await novaPaginaChat(browser, mundo);
  await comecarConversa(page, base);
  // Guarda uma cópia "velha" (sem a marca da versão atual) com uma pergunta que o servidor não conhece mais.
  await page.evaluate(([conversa]) => {
    const c = JSON.parse(localStorage.getItem('webchat.msgs.v1') || '{}');
    c.v = 'versao-antiga';
    c.msgs = [{ id: 1, autor: 'agente', texto: 'PERGUNTA VELHA', opcoes: { tipo: 'escolha', passo: 'velho', itens: [{ valor: 'x', rotulo: 'Velho' }] }, criado_em: new Date(Date.now() - 864e5).toISOString(), agente: 'Assistente virtual' }];
    c.conversa = conversa; localStorage.setItem('webchat.msgs.v1', JSON.stringify(c));
  }, [mundo.conversa]);
  await page.reload();
  await page.waitForSelector('#msgs .msg.agente', { timeout: 8000 });
  await espera(500);
  const texto = await page.$eval('#msgs', (n) => n.textContent);
  await ctx.close();
  return { ok: !texto.includes('PERGUNTA VELHA') && texto.includes('O que você precisa?'), detalhe: texto.includes('PERGUNTA VELHA') ? 'a cópia velha apareceu' : 'cópia velha descartada' };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
