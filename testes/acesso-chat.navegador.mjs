// FLUXOGRAMA: entrada (o index.html REAL do chat num Chromium de celular; todas as chamadas ao Supabase vão para o banco de teste com o retrato da produção + as duas migrações do acesso rápido, ou seja, o motor REAL do chat) -> validação (a pessoa usa os botões: PIN, "Para mim", "Para <filho>", formulário, CPF) -> lógica (com o interruptor desligado nada muda; ligado, a 1ª conversa pergunta CPF e nascimento UMA vez e o cadastro aprende; da 2ª em diante o chat pula direto para "o que você precisa"; o filho tem o próprio CPF; PIN vencido pede o PIN no próprio chat) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 14/11/2026 / Mudança: Implementação inicial
// Prova a tela do chat e o motor JUNTOS. Dados inventados; nada fala com o Supabase de verdade.
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
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-pin-obrigatorio.sql`, 'utf8'));   // app_chat_dados_resumo e app_dados_atualizar ("seus dados continuam os mesmos?")
const modo = (v) => db.query(`update public.config set valor = $1 where chave = 'app_acesso_modo'`, [v]);

// O "Supabase" do chat: cada chamada rpc vai para a função de mesmo nome no banco de teste, como anon, com parâmetros nomeados.
let fila = Promise.resolve();
const infos = new Map();
const mundo = {
  chamadas: [], quedas: {},
  tratar: (nome, corpo) => { const r = fila.then(() => chamar(nome, corpo)); fila = r.catch(() => {}); return r; },
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

const abrir = async (opcoes = {}) => {
  await q(`update public.conversas set criado_em = criado_em - interval '2 hours'`);   // o chat limita 5 conversas por hora por celular
  const init = opcoes.token === null ? [] : [[(t) => { try { localStorage.setItem('csi_acesso_v2', JSON.stringify({ dev: t, nome1: 'Ana' })); } catch { /* sem armazenamento */ } }, ana.token]];
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo, { init });
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('#formInicio', { state: 'visible', timeout: 10000 });
  return { page, ctx, erros };
};
const texto = (page) => page.evaluate(() => document.body.innerText);
const aguardaTexto = (page, re, ms = 8000) => page.waitForFunction((s) => new RegExp(s).test(document.body.innerText), re.source, { timeout: ms });
const passoDaUltima = async (page) => page.evaluate(() => { const w = [...document.querySelectorAll('#msgs .widget')].pop(); return w ? w.dataset.tipo : null; });
const rotulosCampos = (page) => page.$$eval('#msgs .widget form label', (ls) => ls.map((l) => l.textContent.trim()));
const aceites = async (page) => { if (await page.locator('#fAceite').isVisible()) await page.check('#fAceite'); await page.check('#fPrevisao'); };

// ================================================================= interruptor desligado: o chat é o de sempre
await caso('interruptor DESLIGADO: nenhum bloco de acesso rápido, formulário igual ao de hoje (Para mim / Para meu filho)', async () => {
  await modo('nao');
  const { page, ctx } = await abrir();
  await espera(600);
  const oculto = await page.locator('#blocoAcesso').isHidden();
  const cartoes = await page.$$eval('#fQuem .unidade strong', (n) => n.map((x) => x.textContent));
  const nome = await page.isVisible('#fNome');
  await ctx.close();
  return { ok: oculto && cartoes.join('|') === 'Para mim|Para meu filho(a)' && nome, detalhe: cartoes.join('|') };
});
await modo('sim');

// ================================================================= sem cadastro neste aparelho
await caso('ligado, aparelho sem acesso rápido: convite para criar/entrar (link para /acesso/), formulário de sempre', async () => {
  const { page, ctx } = await abrir({ token: null });
  await espera(600);
  const href = await page.getAttribute('#acessoCriar', 'href');
  const cartoes = await page.$$eval('#fQuem .unidade strong', (n) => n.map((x) => x.textContent));
  await ctx.close();
  return { ok: href === 'acesso/?voltar=chat' && cartoes.join('|') === 'Para mim|Para meu filho(a)', detalhe: href };
});

// ================================================================= PIN dentro do chat
await caso('PIN vencido (30 min): o chat mostra "Digitar PIN"; PIN errado avisa; PIN certo libera e mostra Eu e os filhos', async () => {
  await q(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
  const { page, ctx } = await abrir();
  await page.waitForSelector('#acessoPin', { timeout: 8000 });
  const antes = await texto(page);
  await page.click('#acessoPin');
  const tecla = (d) => page.click(`.pin-teclas [data-tecla="${d}"]`);
  for (const d of '0000') await tecla(d);
  await aguardaTexto(page, /PIN incorreto/);
  for (const d of '1357') await tecla(d);
  await page.waitForSelector('#acessoSair', { timeout: 8000 });
  await aguardaTexto(page, /Acesso rápido: Ana/);
  const cartoes = await page.$$eval('#fQuem .unidade strong', (n) => n.map((x) => x.textContent));
  await ctx.close();
  return { ok: /Digite seu PIN/.test(antes) && cartoes.join('|') === 'Para mim|Para Leo|Para Lia|Todos os filhos', detalhe: cartoes.join('|') };
});

await caso('cadastro com informação pendente: a faixa NÃO mostra aviso nem cartão pedindo informação (só o link "Meus dados")', async () => {
  const { page, ctx } = await abrir();
  await aguardaTexto(page, /Acesso rápido: Ana/);
  const txt = await texto(page), link = await page.$eval('#acessoMeusDados', (e) => e.textContent + '|' + e.getAttribute('href')), pend = await page.locator('#acessoPend').count();
  await ctx.close();
  return { ok: !/Falta(m)? \d+ informaç/.test(txt) && !pend && link === 'Meus dados|acesso/?ir=dados', detalhe: link };
});

await caso('faixa do acesso rápido (fora da clínica): não escreve a palavra "null" na tela', async () => {
  const { page, ctx } = await abrir();
  await aguardaTexto(page, /Acesso rápido: Ana/);
  const faixa = await page.$eval('#blocoAcesso', (e) => e.textContent);
  await ctx.close();
  return { ok: !/null|undefined/.test(faixa), detalhe: faixa.replace(/\s+/g, ' ').trim() };
});

// ================================================================= 1ª conversa: pergunta uma vez
let sessaoAna;
await caso('1ª conversa "Para mim": nome e celular vêm do cadastro (travados); o chat pergunta CPF e nascimento (ainda não há CPF salvo)', async () => {
  sessaoAna = await abrir();
  const { page } = sessaoAna;
  await aguardaTexto(page, /Acesso rápido: Ana/);
  await page.click('#fQuem .unidade >> text=Para mim');
  const nomeTravado = await page.evaluate(() => { const n = document.getElementById('fNome'), t = document.getElementById('fTel'); return n.readOnly && t.readOnly && n.value === 'Ana Souza Teste' && /99123-0001/.test(t.value); });
  const email = await page.isVisible('#fEmail');
  await page.fill('#fEmail', 'ana@exemplo.invalid');
  await aceites(page);
  await page.click('#btnIniciar');
  await page.waitForSelector('#msgs .widget[data-tipo="campos"]', { timeout: 10000 });
  const rotulos = await rotulosCampos(page);
  return { ok: nomeTravado && email && rotulos.some((r) => /CPF/.test(r)) && rotulos.some((r) => /nascimento/i.test(r)), detalhe: rotulos.join(' | ') };
});
await caso('a pessoa digita o CPF e o nascimento: segue para a próxima pergunta e o cadastro aprende o CPF', async () => {
  const { page } = sessaoAna;
  const campos = page.locator('#msgs .widget form input');
  await campos.nth(0).fill(CPF_ANA); await campos.nth(1).fill('12/04/1988');
  await page.click('#msgs .widget form button[type="submit"]');
  await aguardaTexto(page, /(Exame|Consulta)/, 10000);
  await espera(800);
  const linha = (await q(`select cpf, email from public.app_paciente`))[0];
  return { ok: linha.cpf === '52998224725' && linha.email === 'ana@exemplo.invalid', detalhe: JSON.stringify({ cpf: !!linha.cpf, email: linha.email }) };
});
await caso('no cadastro (Meus dados) o CPF aparece só mascarado', async () => {
  const p = (await rpcSql('app_perfil', { p_token: ana.token })).perfil;
  return { ok: p.cpf_mascara === '***.***.***-25' && !JSON.stringify(p).includes('52998224725') };
});
await sessaoAna.ctx.close();

// ================================================================= 2ª conversa: não pergunta mais
await caso('2ª conversa "Para mim" (aparelho que já conhece o e-mail): sem pergunta de CPF/nascimento; vai direto para "o que você precisa"', async () => {
  const s = await abrir();
  const { page } = s;
  await aguardaTexto(page, /Acesso rápido: Ana/);
  await page.click('#fQuem .unidade >> text=Para mim');
  await aceites(page);
  const antes = mundo.chamadas.length;
  await page.click('#btnIniciar');
  // aparece "Exame/Consulta" sem passar por um formulário de CPF
  await aguardaTexto(page, /Seus dados continuam os mesmos/, 12000);
  const cartao = await texto(page);
  await page.click('#msgs .widget button:has-text("Sim, são os mesmos")');
  await aguardaTexto(page, /(Exame|Consulta)/, 12000);
  await espera(600);
  const mostrouCpf = await page.evaluate(() => [...document.querySelectorAll('#msgs .widget form label')].some((l) => /CPF/.test(l.textContent)));
  const msgs = await texto(page);
  const chamouDados = mundo.chamadas.slice(antes).some((c) => c.nome === 'app_chat_dados');
  const dup = await page.isVisible('#dupNova');
  s.dup = dup;
  await s.ctx.close();
  return { ok: !mostrouCpf && chamouDados && /dados salvos/.test(msgs) && /\*\*\*\.\*\*\*\.\*\*\*-25/.test(cartao) && !/529\.982/.test(cartao), detalhe: `form CPF: ${mostrouCpf}; pergunta de conversa aberta: ${dup}` };
});

// ================================================================= filho
let sessaoLeo;
await caso('conversa "Para Leo": o chat pergunta o CPF dele uma vez (o da mãe não é usado) e o cadastro aprende separado', async () => {
  sessaoLeo = await abrir();
  const { page } = sessaoLeo;
  await aguardaTexto(page, /Acesso rápido: Ana/);
  await page.click('#fQuem .unidade >> text=Para Leo');
  await aceites(page);
  await page.click('#btnIniciar');
  await page.waitForSelector('#msgs .widget[data-tipo="campos"]', { timeout: 10000 });
  const rotulos = await rotulosCampos(page);
  const campos = page.locator('#msgs .widget form input');
  await campos.nth(0).fill(CPF_LEO); await campos.nth(1).fill('30/08/2019');
  await page.click('#msgs .widget form button[type="submit"]');
  await aguardaTexto(page, /(Exame|Consulta)/, 10000);
  await espera(800);
  const f = (await q(`select nome, cpf from public.app_filho order by criado_em`));
  const eu = (await q(`select cpf from public.app_paciente`))[0].cpf;
  await sessaoLeo.ctx.close();
  return { ok: rotulos.some((r) => /CPF/.test(r)) && f[0].cpf === '11144477735' && f[1].cpf === null && eu === '52998224725', detalhe: `Leo ${!!f[0].cpf}, Lia ${!!f[1].cpf}` };
});
await caso('Leo de novo: não pergunta mais; Lia (sem CPF salvo) ainda pergunta', async () => {
  const s = await abrir(); const { page } = s;
  await aguardaTexto(page, /Acesso rápido: Ana/);
  await page.click('#fQuem .unidade >> text=Para Leo');
  await aceites(page);
  await page.click('#btnIniciar');
  if (await page.locator('#dupNova').isVisible({ timeout: 1500 }).catch(() => false)) await page.click('#dupNova');
  await aguardaTexto(page, /Os dados de Leo continuam os mesmos/, 12000);
  await page.click('#msgs .widget button:has-text("Sim, são os mesmos")');
  await aguardaTexto(page, /(Exame|Consulta)/, 12000);
  await espera(500);
  const leoPergunta = await page.evaluate(() => [...document.querySelectorAll('#msgs .widget form label')].some((l) => /CPF/.test(l.textContent)));
  await page.click('#btnVoltarInicio').catch(() => {});
  await s.ctx.close();
  const s2 = await abrir(); const p2 = s2.page;
  await aguardaTexto(p2, /Acesso rápido: Ana/);
  await p2.click('#fQuem .unidade >> text=Para Lia');
  await aceites(p2);
  await p2.click('#btnIniciar');
  await p2.waitForSelector('#msgs .widget[data-tipo="campos"]', { timeout: 10000 });
  const liaPergunta = await p2.evaluate(() => [...document.querySelectorAll('#msgs .widget form label')].some((l) => /CPF/.test(l.textContent)));
  await s2.ctx.close();
  return { ok: !leoPergunta && liaPergunta, detalhe: `Leo pergunta: ${leoPergunta}; Lia pergunta: ${liaPergunta}` };
});

// ================================================================= Todos os filhos
await caso('"Todos os filhos" usa os irmãos do chat: Leo primeiro, Lia na fila, com a escolha "mesmo pedido / um de cada vez"', async () => {
  const s = await abrir(); const { page } = s;
  await aguardaTexto(page, /Acesso rápido: Ana/);
  await page.click('#fQuem .unidade >> text=Todos os filhos');
  const modos = await page.$$eval('#fModoIrmaos .unidade strong', (n) => n.map((x) => x.textContent));
  const nomesDigitaveis = await page.isVisible('#fFilho');
  await page.click('#fModoIrmaos .unidade >> nth=1');
  await aceites(page);
  await page.click('#btnIniciar');
  if (await page.locator('#dupNova').isVisible({ timeout: 1500 }).catch(() => false)) await page.click('#dupNova');   // já há conversa aberta do Leo: abre outra mesmo assim
  await page.waitForSelector('#proximo:not([hidden])', { timeout: 12000 });
  const prox = await page.textContent('#proximoTxt');
  const conv = (await q(`select paciente_nome, irmaos, irmaos_modo from public.conversas order by criado_em desc limit 1`))[0];
  await s.ctx.close();
  return { ok: modos.length === 2 && !nomesDigitaveis && /Lia/.test(prox) && conv.paciente_nome === 'Leo Souza Teste' && conv.irmaos_modo === 'juntos', detalhe: `${modos.join('|')} / ${prox.trim()}` };
});

await caso('PIN de outro aparelho/código inválido: o chat apaga o código local e volta ao convite', async () => {
  await q(`delete from public.app_aparelho`);
  const { page, ctx } = await abrir();
  await espera(800);
  const convite = await page.isVisible('#acessoCriar');
  const guardado = await page.evaluate(() => localStorage.getItem('csi_acesso_v2'));
  await ctx.close();
  return { ok: convite && guardado === null };
});

await caso('nenhum erro de script durante todo o roteiro', async () => {
  const s = await abrir(); const e = s.erros.excecoes; await s.ctx.close();
  return { ok: e.length === 0, detalhe: e.join(' | ').slice(0, 200) };
});

await browser.close(); srv.close();
const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
