// FLUXOGRAMA: entrada (chat do paciente + Supabase simulado com VÁRIAS conversas) -> validação (o aparelho guarda só as últimas 5; cada uma com o seu token) -> lógica (abre a lista "Conversas anteriores", volta a uma conversa antiga e confere as mensagens que o servidor devolve) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
//
// Pedido: "acesso ao histórico da conversa anterior, pelo menos 3 conversas disponíveis". Requer um Chromium (CHROMIUM_PATH).
import { chromium, servidor, criarMundo, novaPaginaChat, comecarConversa } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

// Um servidor de mentira com uma "conversa" por chat_iniciar. Cada conversa tem a sua própria pergunta, para saber qual abriu.
function criarVarias() {
  const mundos = {}; let n = 0, atual = null;
  return {
    mundos, chamadas: [],
    tratar: async (nome, corpo) => {
      if (nome === 'chat_iniciar') {
        n++;
        atual = criarMundo({ conversa: `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`, token: `token-${n}` });
        mundos[atual.conversa] = atual;
        const r = await atual.tratar(nome, corpo);
        atual.msgs[0].texto = `Pergunta da conversa ${n}`;
        return r;
      }
      const m = mundos[corpo.p_conversa] || atual || (atual = criarMundo());   // chat_config chega antes de qualquer conversa
      if (nome === 'chat_listar' && corpo.p_token !== m.token) return { status: 400, body: { code: '28000', message: 'Conversa não encontrada.' } };
      return m.tratar(nome, corpo);
    }
  };
}

// Abre uma conversa nova a partir do menu (a primeira vem do formulário completo).
async function novaDoMenu(page) {
  await page.click('#btnMenu'); await page.click('#btnNova');
  await page.waitForSelector('#formInicio', { state: 'visible' });
  await page.click('#fQuem .unidade >> nth=0');
  await page.click('#btnIniciar');
  await page.waitForSelector('#msgs .msg.agente .op', { timeout: 8000 });
}
const lerHist = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('webchat.historico.v1') || '[]'));

await caso('guarda as conversas deste aparelho: 3 conversas, as 3 aparecem em "Conversas anteriores", da mais nova para a mais antiga', async () => {
  const mundo = criarVarias();
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo);
  page.on('dialog', (d) => d.accept());
  await comecarConversa(page, base);
  await novaDoMenu(page); await novaDoMenu(page);
  await espera(500);
  await page.click('#btnMenu');
  const visivel = await page.isVisible('#btnHistorico');
  await page.click('#btnHistorico');
  await page.waitForSelector('.hist-item');
  const itens = await page.$$eval('.hist-item', (xs) => xs.map((x) => x.textContent));
  const atual = await page.$$eval('.hist-item.atual', (xs) => xs.length);
  await ctx.close();
  return { ok: visivel && itens.length === 3 && atual === 1 && erros.excecoes.length === 0, detalhe: `botão visível=${visivel}, itens=${itens.length}, aberta agora=${atual}${erros.excecoes[0] ? ', ' + erros.excecoes[0] : ''}` };
});

await caso('voltar a uma conversa antiga mostra as mensagens dela (vindas do servidor) e troca a conversa aberta', async () => {
  const mundo = criarVarias();
  const { page, ctx } = await novaPaginaChat(browser, mundo);
  page.on('dialog', (d) => d.accept());
  await comecarConversa(page, base);
  await novaDoMenu(page); await novaDoMenu(page);
  await espera(500);
  await page.click('#btnMenu'); await page.click('#btnHistorico');
  await page.waitForSelector('.hist-item');
  await page.click('.hist-item >> nth=2');   // a mais antiga (conversa 1)
  await page.waitForSelector('#msgs .msg.agente >> text=Pergunta da conversa 1', { timeout: 6000 });
  const texto = await page.$eval('#msgs', (n) => n.textContent);
  const salva = await page.evaluate(() => JSON.parse(localStorage.getItem('webchat.conversa.v1')));
  const folhaFechou = await page.$eval('#folha', (n) => n.hidden);
  await ctx.close();
  return { ok: texto.includes('Pergunta da conversa 1') && !texto.includes('Pergunta da conversa 3') && salva.token === 'token-1' && folhaFechou, detalhe: `token aberto=${salva.token}, janela fechou=${folhaFechou}` };
});

await caso('o aparelho guarda só as últimas 5 conversas (mais que o mínimo de 3)', async () => {
  const mundo = criarVarias();
  const { page, ctx } = await novaPaginaChat(browser, mundo);
  page.on('dialog', (d) => d.accept());
  await comecarConversa(page, base);
  for (let i = 0; i < 6; i++) await novaDoMenu(page);   // 7 conversas no total
  await espera(500);
  const hist = await lerHist(page);
  await ctx.close();
  const tokens = hist.map((x) => x.token).join(',');
  return { ok: hist.length === 5 && tokens === 'token-7,token-6,token-5,token-4,token-3', detalhe: `guardadas=${hist.length} (${tokens})` };
});

await caso('no formulário (depois de "Fazer um novo pedido") há o atalho para as conversas anteriores', async () => {
  const mundo = criarVarias();
  const { page, ctx } = await novaPaginaChat(browser, mundo);
  page.on('dialog', (d) => d.accept());
  await comecarConversa(page, base);
  await page.click('#btnMenu'); await page.click('#btnNova');
  await page.waitForSelector('#formInicio', { state: 'visible' });
  const atalho = await page.isVisible('#btnHistoricoForm');
  await page.click('#btnHistoricoForm');
  await page.waitForSelector('.hist-item');
  await page.click('.hist-item >> nth=0');
  await page.waitForSelector('#msgs .msg.agente >> text=Pergunta da conversa 1', { timeout: 6000 });
  await ctx.close();
  return { ok: atalho, detalhe: `atalho visível=${atalho}, reabriu a conversa 1` };
});

await caso('uma conversa de antes desta versão (só com a chave antiga) entra na lista ao abrir', async () => {
  const mundo = criarVarias();
  const { page, ctx } = await novaPaginaChat(browser, mundo);
  await comecarConversa(page, base);
  await page.evaluate(() => localStorage.removeItem('webchat.historico.v1'));   // como era antes: só webchat.conversa.v1
  await page.reload();
  await page.waitForSelector('#msgs .msg.agente', { timeout: 8000 });
  await espera(400);
  const hist = await lerHist(page);
  await ctx.close();
  return { ok: hist.length === 1 && hist[0].token === 'token-1', detalhe: `itens=${hist.length}` };
});

await caso('"Sair (não sou eu)" apaga também a lista de conversas anteriores', async () => {
  const mundo = criarVarias();
  const { page, ctx } = await novaPaginaChat(browser, mundo);
  page.on('dialog', (d) => d.accept());
  await comecarConversa(page, base);
  await novaDoMenu(page);
  await espera(400);
  await page.click('#btnMenu'); await page.click('#btnSair');
  await page.waitForSelector('#formInicio', { state: 'visible' });
  const hist = await page.evaluate(() => localStorage.getItem('webchat.historico.v1'));
  const atalho = await page.isVisible('#btnHistoricoForm');
  await ctx.close();
  return { ok: hist === null && !atalho, detalhe: `lista=${hist}, atalho visível=${atalho}` };
});

await caso('conversa que o servidor não reconhece mais (token inválido) sai da lista sem quebrar as outras', async () => {
  const mundo = criarVarias();
  const { page, ctx } = await novaPaginaChat(browser, mundo);
  page.on('dialog', (d) => d.accept());
  await comecarConversa(page, base);
  await novaDoMenu(page);
  await espera(400);
  await page.evaluate(() => {
    const h = JSON.parse(localStorage.getItem('webchat.historico.v1'));
    h.find((x) => x.token === 'token-1').token = 'token-errado';
    localStorage.setItem('webchat.historico.v1', JSON.stringify(h));
  });
  await page.click('#btnMenu'); await page.click('#btnHistorico');
  await page.waitForSelector('.hist-item');
  await page.click('.hist-item >> nth=1');   // a conversa 1, agora com token errado
  await page.waitForSelector('#formInicio', { state: 'visible', timeout: 6000 });
  const hist = await lerHist(page);
  await ctx.close();
  return { ok: hist.length === 1 && hist[0].token === 'token-2', detalhe: `restaram=${hist.map((x) => x.token)}` };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
