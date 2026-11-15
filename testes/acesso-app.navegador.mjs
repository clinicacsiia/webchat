// FLUXOGRAMA: entrada (acesso/index.html aberto num Chromium de celular; as chamadas à API do Supabase são desviadas para o banco de teste, que tem o retrato da produção + supabase/acesso-rapido-paciente.sql) -> validação (cada tela usada por quem aperta os botões de verdade: teclado do PIN, formulários, painéis) -> lógica (cadastro único em 5 passos, PIN no servidor, bloqueio, tela inicial Eu/filho/Todos juntos, marcação, filho novo a qualquer momento, número de confiança com código, aparelho novo, esqueci o PIN, trava em segundo plano, sair) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 14/11/2026 / Mudança: Implementação inicial
// Prova a página e o banco JUNTOS (a página real chamando as funções reais). Não fala com o Supabase de verdade. Dados inventados.
import { readFileSync } from 'node:fs';
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
async function novaPagina(caminho = '/') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
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
const AMANHA = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
const NASC_ANA = '1988-04-12', NASC_LEO = '2019-08-30', NASC_DAVI = '2022-01-10';

// ================================================================= Ana: primeiro acesso
let ana = await novaPagina();
await caso('aparelho sem cadastro abre no passo 1 (celular)', async () => ({ ok: /Vamos começar/.test(await texto(ana.page)) && /Já tenho cadastro/.test(await texto(ana.page)) }));
await caso('passo 1 recusa celular inválido, sem chamar o servidor', async () => {
  await ana.page.fill('#tel', '(71) 3333-0000'); await ana.page.click('[data-act="c1"]');
  return { ok: /Celular inválido/.test(await texto(ana.page)) && chamadasRede.filter((c) => c.nome !== 'app_porta').length === 0 };   // a página só pergunta a porta (app_porta) ao abrir
});
await caso('cadastro único: celular → nome/nascimento → filho → número de confiança → PIN', async () => {
  await ana.page.fill('#tel', '71991230001'); await ana.page.click('[data-act="c1"]');
  await ana.page.fill('#nome', 'Ana Souza Teste'); await ana.page.fill('#nasc', NASC_ANA); await ana.page.click('[data-act="c2"]');
  await ana.page.click('[data-act="tf"][data-v="1"]');
  await ana.page.fill('#fnome', 'Leo Souza Teste'); await ana.page.fill('#fnasc', NASC_LEO); await ana.page.click('[data-act="addf"]');
  const lista = await texto(ana.page);
  await ana.page.click('[data-act="c3"]');
  await ana.page.fill('#ctnome', 'Bia Amiga'); await ana.page.fill('#cttel', '71991230002'); await ana.page.selectOption('#ctrel', 'Irmão(ã)'); await ana.page.click('[data-act="c4"]');
  await pin(ana.page, '1357'); const confirme = await texto(ana.page);
  await pin(ana.page, '1357');
  await esperaTexto(ana.page, /Olá, Ana/);
  const c = (await q(`select (select count(*) from public.app_paciente)::int p, (select count(*) from public.app_filho)::int f, (select count(*) from public.app_contato_confianca)::int c`))[0];
  return { ok: /Leo Souza Teste/.test(lista) && /Confirme o PIN/.test(confirme) && c.p === 1 && c.f === 1 && c.c === 1, detalhe: JSON.stringify(c) };
});
await caso('o celular guarda só o código do aparelho e o primeiro nome (nenhum dado pessoal)', async () => {
  const st = JSON.parse(await ana.page.evaluate(() => localStorage.getItem('csi_acesso_v2')));
  const tudo = await ana.page.evaluate(() => JSON.stringify({ ...localStorage }));
  return { ok: /^[0-9a-f]{64}$/.test(st.dev) && st.nome1 === 'Ana' && Object.keys(st).sort().join() === 'dev,nome1' && !/1357|Souza|1988|71991230001|Leo/.test(tudo), detalhe: Object.keys(st).join() };
});
await caso('as chamadas usam só a chave pública (apikey) e mandam o PIN apenas ao servidor', async () => {
  const cad = chamadasRede.find((c) => c.nome === 'app_cadastrar');
  return { ok: !!cad && cad.apikey?.startsWith('sb_publishable_') && !cad.auth && cad.chaves.includes('p_pin') && cad.chaves.includes('p_filhos') && cad.chaves.includes('p_confianca'), detalhe: cad?.chaves.join() };
});
await caso('tela inicial: Eu, Leo e Todos juntos', async () => {
  const t = await texto(ana.page);
  return { ok: /Eu/.test(t) && /Leo/.test(t) && /Todos juntos/.test(t) && /Marcar pelo chat/.test(t) };
});

// ================================================================= marcação e filho novo
let grupoAna;
await caso('"Todos juntos" + Nova marcação gera uma solicitação para cada pessoa', async () => {
  await ana.page.click('[data-act="whoall"]');
  await ana.page.click('[data-act="go"][data-v="nova"]');
  await ana.page.fill('#dtm', AMANHA); await ana.page.selectOption('#turno', 'Tarde'); await ana.page.selectOption('#exame', 'Ultrassom'); await ana.page.fill('#obs', 'Pedido de teste');
  await ana.page.click('[data-act="nova"]');
  await esperaTexto(ana.page, /Solicitação registrada/);
  const resumo = await ana.page.locator('#resumo').innerText();
  const m = await q(`select grupo, pessoa_nome, status from public.app_marcacao order by pessoa_nome`);
  grupoAna = m[0].grupo;
  return { ok: m.length === 2 && m[0].grupo === m[1].grupo && m.every((x) => x.status === 'solicitada') && /Ana Souza Teste/.test(resumo) && /Leo Souza Teste/.test(resumo) && /Tarde/.test(resumo), detalhe: m.map((x) => x.pessoa_nome).join(' + ') };
});
await caso('a solicitação aparece na tela inicial como "Aguardando confirmação"; a última escolha fica lembrada', async () => {
  await ana.page.click('[data-act="go"][data-v="home"]');
  const t = await texto(ana.page);
  const sel = (await q(`select ultima_selecao from public.app_paciente`))[0].ultima_selecao;
  return { ok: /Ana \+ Leo/.test(t) && /Aguardando confirmação/.test(t) && sel.length === 2, detalhe: JSON.stringify(sel) };
});
await caso('data passada é recusada pela tela', async () => {
  await ana.page.click('[data-act="go"][data-v="nova"]'); await ana.page.evaluate(() => { document.getElementById('dtm').removeAttribute('min'); });
  await ana.page.fill('#dtm', '2020-01-01'); await ana.page.click('[data-act="nova"]');
  const t = await texto(ana.page); await ana.page.click('[data-act="go"][data-v="home"]');
  return { ok: /a partir de hoje/.test(t) };
});
await caso('Meus dados → adicionar mais um filho a qualquer momento (painel funciona)', async () => {
  await ana.page.click('[data-act="go"][data-v="dados"]');
  await ana.page.click('[data-act="sheet"][data-t="filho"]');
  await ana.page.fill('#fnome', 'Davi Souza Teste'); await ana.page.fill('#fnasc', NASC_DAVI); await ana.page.click('[data-act="sf"]');
  await esperaTexto(ana.page, /Davi Souza Teste/);
  return { ok: (await n(`select count(*)::int n from public.app_filho where removido_em is null`)) === 2 };
});
await caso('o filho novo já aparece na tela inicial para a próxima marcação', async () => {
  await ana.page.click('[data-act="go"][data-v="home"]');
  return { ok: /Davi/.test(await texto(ana.page)) };
});
await caso('painel: tocar dentro do painel não fecha; tocar no fundo fecha', async () => {
  await ana.page.click('[data-act="go"][data-v="dados"]'); await ana.page.click('[data-act="sheet"][data-t="filho"]');
  await ana.page.click('#fnome');
  const aberto = await ana.page.locator('.sheet').count();
  await ana.page.mouse.click(190, 20);
  const fechado = await ana.page.locator('.sheet').count();
  return { ok: aberto === 1 && fechado === 0, detalhe: `${aberto}/${fechado}` };
});
await caso('cancelar a solicitação pede confirmação e depois cancela no banco', async () => {
  await ana.page.click('[data-act="go"][data-v="home"]');
  await ana.page.click('[data-act="canc"]'); const pede = await texto(ana.page);
  await ana.page.click('[data-act="confirmar"]');
  await esperaTexto(ana.page, /Nenhuma solicitação ainda/);
  const st = await q(`select status from public.app_marcacao where grupo = $1`, [grupoAna]);
  return { ok: /Cancelar a solicitação/.test(pede) && st.every((x) => x.status === 'cancelada') };
});

// ================================================================= PIN ao reabrir
await caso('reabrir o app: abre direto no PIN, sem pedir login nem cadastro', async () => {
  await ana.page.reload(); const t = await texto(ana.page);
  return { ok: /Olá, Ana/.test(t) && /Digite seu PIN/.test(t) && !/Vamos começar/.test(t) && !/Marcar pelo chat/.test(t) };
});
await caso('PIN errado: mostra quantas tentativas restam; no 5º erro bloqueia 1 minuto', async () => {
  await pin(ana.page, '0000'); const um = await texto(ana.page);
  for (let i = 0; i < 3; i++) await pin(ana.page, '0000');
  const quatro = await texto(ana.page);
  await pin(ana.page, '0000'); const cinco = await texto(ana.page);
  await pin(ana.page, '1357'); const certoBloqueado = await texto(ana.page);
  return { ok: /Restam 4 tentativas/.test(um) && /Resta 1 tentativa/.test(quatro) && /Aguarde 1 minuto/.test(cinco) && /Aguarde 1 minuto/.test(certoBloqueado) && !/Marcar pelo chat/.test(certoBloqueado),
    detalhe: [um, quatro, cinco, certoBloqueado].map((x) => (x.match(/PIN incorreto[^\n]*|Muitas[^\n]*/) || ['?'])[0]).join(' | ') };
});
await caso('passado o bloqueio, o PIN certo abre e a escolha anterior volta marcada', async () => {
  await q(`update public.app_paciente set pin_bloqueado_ate = now() - interval '1 second'`);
  await pin(ana.page, '1357'); await esperaTexto(ana.page, /Marcar pelo chat/);
  return { ok: /Todos juntos/.test(await texto(ana.page)) };
});
await caso('mais de 5 minutos em segundo plano: a tela trava e pede o PIN de novo (e some o conteúdo)', async () => {
  await ana.page.evaluate(() => { S.hiddenAt = Date.now() - 6 * 60000; document.dispatchEvent(new Event('visibilitychange')); });
  const t = await texto(ana.page);
  await pin(ana.page, '1357'); await esperaTexto(ana.page, /Marcar pelo chat/);
  return { ok: /Digite seu PIN/.test(t) && !/Leo|Davi/.test(t) };
});
await caso('menos de 5 minutos em segundo plano: não trava', async () => {
  await ana.page.evaluate(() => { S.hiddenAt = Date.now() - 2 * 60000; document.dispatchEvent(new Event('visibilitychange')); });
  return { ok: /Marcar pelo chat/.test(await texto(ana.page)) };
});
await caso('passados 30 min o servidor também exige o PIN: ao enviar, a tela volta ao teclado em vez de mostrar erro técnico', async () => {
  await q(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
  await ana.page.click('[data-act="go"][data-v="nova"]');
  await ana.page.fill('#dtm', AMANHA); await ana.page.click('[data-act="nova"]');
  await esperaTexto(ana.page, /Digite seu PIN/);
  const t = await texto(ana.page);
  await pin(ana.page, '1357'); await esperaTexto(ana.page, /Marcar pelo chat/);
  return { ok: /Digite seu PIN/.test(t) && !/erro|Erro/.test(t) };
});
await caso('trocar o PIN: PIN atual → novo → confirma; o antigo deixa de valer', async () => {
  await ana.page.click('[data-act="go"][data-v="dados"]'); await ana.page.click('[data-act="trocapin"]');
  await pin(ana.page, '1357'); await pin(ana.page, '2468'); await pin(ana.page, '2468');
  await esperaTexto(ana.page, /Meus dados/);
  const ev = await n(`select count(*)::int n from public.app_evento where tipo = 'pin_trocado'`);
  return { ok: ev === 1 };
});
await caso('trocar o PIN com o atual errado avisa e recomeça', async () => {
  await ana.page.click('[data-act="trocapin"]');
  await pin(ana.page, '9999'); await pin(ana.page, '2468'); await pin(ana.page, '2468');
  await esperaTexto(ana.page, /PIN incorreto/);
  const t = await texto(ana.page);
  await ana.page.click('[data-act="go"][data-v="dados"]');
  return { ok: /PIN atual/.test(t) };
});

// ================================================================= número de confiança
let codigo;
await caso('adicionar número de confiança em Meus dados mostra o código de 6 dígitos para passar à pessoa', async () => {
  await ana.page.click('[data-act="go"][data-v="dados"]').catch(() => {});
  const t = await texto(ana.page);
  codigo = (await q(`select codigo from public.app_contato_confianca`))[0].codigo;
  return { ok: new RegExp(codigo).test(t) && /Bia Amiga/.test(t), detalhe: codigo };
});
let bia = await novaPagina();
await caso('a pessoa de confiança faz o próprio cadastro (celular dela) e AINDA não vê nada de Ana', async () => {
  await bia.page.fill('#tel', '71991230002'); await bia.page.click('[data-act="c1"]');
  await bia.page.fill('#nome', 'Beatriz Amiga Teste'); await bia.page.fill('#nasc', '1990-02-20'); await bia.page.click('[data-act="c2"]');
  await bia.page.click('[data-act="tf"][data-v="0"]'); await bia.page.click('[data-act="c3"]');
  await bia.page.click('[data-act="c4skip"]');
  await pin(bia.page, '8642'); await pin(bia.page, '8642');
  await esperaTexto(bia.page, /Olá, Beatriz/);
  const t = await texto(bia.page);
  return { ok: !/Ana Souza|Leo|Davi/.test(t) && !/Você acompanha/.test(t) };
});
await caso('código errado é recusado com mensagem; código certo vincula e ela passa a ver a Ana, os filhos e as solicitações', async () => {
  await bia.page.click('[data-act="go"][data-v="dados"]');
  await bia.page.click('[data-act="sheet"][data-t="codigo"]'); await bia.page.fill('#cod', codigo === '000000' ? '111111' : '000000'); await bia.page.click('[data-act="scod"]');
  await esperaTexto(bia.page, /Código inválido/);
  await bia.page.fill('#cod', codigo); await bia.page.click('[data-act="scod"]');
  await esperaTexto(bia.page, /Você acompanha: Ana Souza Teste/);
  const t = await texto(bia.page);
  return { ok: /Leo/.test(t) && /Davi/.test(t) && /Só leitura/.test(t) };
});
await caso('quem acompanha vê só leitura: não há botão de cancelar nem de marcar para a Ana', async () => {
  const x = await bia.page.locator('[data-act="canc"]').count();
  return { ok: x === 0 };
});
await caso('o titular vê que a pessoa já acompanha; remover tira o acesso dela na hora', async () => {
  await ana.page.click('[data-act="go"][data-v="home"]'); await ana.page.click('[data-act="go"][data-v="dados"]');
  const antes = await texto(ana.page);
  await ana.page.click('[data-act="delc"]'); await ana.page.click('[data-act="confirmar"]');
  await esperaTexto(ana.page, /Ninguém ainda/);
  await bia.page.click('[data-act="go"][data-v="home"]').catch(() => {});
  await bia.page.reload(); await pin(bia.page, '8642'); await esperaTexto(bia.page, /Olá, Beatriz/);
  return { ok: /Já acompanha/.test(antes) && !/Você acompanha/.test(await texto(bia.page)) };
});

// ================================================================= aparelho novo, esqueci o PIN, sair
let novo = await novaPagina();
await caso('aparelho novo: "Já tenho cadastro" → celular → PIN entra e traz tudo do banco', async () => {
  await novo.page.click('[data-act="go"][data-v="entrar"]');
  await novo.page.fill('#tel', '(71) 99123-0001'); await novo.page.click('[data-act="entrar"]');
  await pin(novo.page, '1357'); const errado = await texto(novo.page);
  await pin(novo.page, '2468'); await esperaTexto(novo.page, /Olá, Ana/);
  const t = await texto(novo.page);
  return { ok: /Celular ou PIN incorretos/.test(errado) && /Leo/.test(t) && /Davi/.test(t) };
});
await caso('"Sair deste aparelho" apaga o código do celular e volta ao cadastro; o cadastro continua no banco', async () => {
  await novo.page.click('[data-act="go"][data-v="dados"]'); await novo.page.click('[data-act="sheet"][data-t="sair"]'); await novo.page.click('[data-act="sair"]');
  await esperaTexto(novo.page, /Vamos começar/);
  const st = await novo.page.evaluate(() => localStorage.getItem('csi_acesso_v2'));
  return { ok: st === null && (await n(`select count(*)::int n from public.app_paciente`)) === 2 };
});
await caso('o aparelho que saiu perde o acesso no servidor; o outro aparelho da Ana continua valendo', async () => {
  const ap = await n(`select count(*)::int n from public.app_aparelho`);
  return { ok: ap === 2, detalhe: `${ap} aparelhos (o da Ana e o da Bia; o que saiu foi apagado)` };
});
await caso('"Esqueci o PIN" (aparelho sem cadastro): pelo "Já tenho cadastro", dados errados são recusados; dados certos criam PIN novo e entram', async () => {
  await novo.page.click('[data-act="go"][data-v="entrar"]');
  await novo.page.fill('#tel', '71991230001'); await novo.page.click('[data-act="entrar"]');
  await novo.page.click('[data-act="esqueci"]');
  const tel = await novo.page.inputValue('#tel');
  await novo.page.fill('#nome', 'Ana Outra Teste'); await novo.page.fill('#nasc', NASC_ANA); await novo.page.click('[data-act="esqueci2"]');
  await pin(novo.page, '7391'); await pin(novo.page, '7391');
  await esperaTexto(novo.page, /não conferem/);
  const manteve = (await novo.page.inputValue('#nasc')) === NASC_ANA && (await novo.page.inputValue('#nome')) === 'Ana Outra Teste';
  await novo.page.fill('#nome', 'ana  SOUZA teste'); await novo.page.click('[data-act="esqueci2"]');
  await pin(novo.page, '7391'); await pin(novo.page, '7391');
  await esperaTexto(novo.page, /Olá, Ana/);
  const ev = await n(`select count(*)::int n from public.app_evento where tipo = 'pin_redefinido'`);
  const antigo = await ana.page.evaluate(async () => (await rpc('app_desbloquear', { p_token: S.dev, p_pin: '7391' })).erro);
  const login = await q(`select (select count(*) from public.app_aparelho a join public.app_paciente p on p.id = a.paciente_id where p.telefone = '71991230001')::int n`);
  return { ok: manteve && tel === '(71) 99123-0001' && ev === 1 && antigo === 'sessao' && login[0].n === 1, detalhe: `outros aparelhos derrubados: ${antigo}` };
});
await caso('desligar o interruptor mostra "ainda não disponível" em vez de erro técnico', async () => {
  await db.exec(`update public.config set valor = 'nao' where chave = 'app_acesso_modo'`);
  const off = await novaPagina();
  await off.page.fill('#tel', '71991230009'); await off.page.click('[data-act="c1"]');
  await off.page.fill('#nome', 'Caio Teste Silva'); await off.page.fill('#nasc', '1980-01-01'); await off.page.click('[data-act="c2"]');
  await off.page.click('[data-act="tf"][data-v="0"]'); await off.page.click('[data-act="c3"]'); await off.page.click('[data-act="c4skip"]');
  await pin(off.page, '7392'); await pin(off.page, '7392');
  await esperaTexto(off.page, /Ainda não disponível/);
  await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);
  return { ok: (await n(`select count(*)::int n from public.app_paciente where telefone = '71991230009'`)) === 0 };
});
await caso('cadastro com celular que já existe volta ao passo 1 com a explicação e o atalho "Já tenho cadastro"', async () => {
  const dup = await novaPagina();
  await dup.page.fill('#tel', '71991230001'); await dup.page.click('[data-act="c1"]');
  await dup.page.fill('#nome', 'Outra Pessoa Teste'); await dup.page.fill('#nasc', '1980-01-01'); await dup.page.click('[data-act="c2"]');
  await dup.page.click('[data-act="tf"][data-v="0"]'); await dup.page.click('[data-act="c3"]'); await dup.page.click('[data-act="c4skip"]');
  await pin(dup.page, '8264'); await pin(dup.page, '8264');
  await esperaTexto(dup.page, /já tem cadastro/);
  return { ok: /Vamos começar/.test(await texto(dup.page)) && /Já tenho cadastro/.test(await texto(dup.page)) };
});
await caso('PIN óbvio (0000, 1234, 1111, 1212...) é recusado na hora, com a explicação, e a pessoa continua na etapa de criar o PIN; um PIN bom segue', async () => {
  const p = await novaPagina();
  await p.page.fill('#tel', '71990000099'); await p.page.click('[data-act="c1"]');
  await p.page.fill('#nome', 'Pessoa Nova Teste'); await p.page.fill('#nasc', '1985-05-05'); await p.page.click('[data-act="c2"]');
  await p.page.click('[data-act="tf"][data-v="0"]'); await p.page.click('[data-act="c3"]'); await p.page.click('[data-act="c4skip"]');
  const msgs = [];
  for (const fraco of ['0000', '1234', '4321', '1212']) { await pin(p.page, fraco); msgs.push(/menos óbvio/.test(await texto(p.page)) && /Crie seu PIN/.test(await texto(p.page))); }
  await pin(p.page, '8264');
  const segue = /Confirme o PIN/.test(await texto(p.page));
  return { ok: msgs.every(Boolean) && segue, detalhe: `recusou=${msgs.join(',')} segue=${segue}` };
});
// ================================================================= integração com o chat
await caso('tela inicial: "Marcar pelo chat da clínica" leva ao chat (a marcação de verdade); a solicitação sem chat continua como opção', async () => {
  const p = await novaPagina();
  await p.page.click('[data-act="go"][data-v="entrar"]');
  await p.page.fill('#tel', '71991230001'); await p.page.click('[data-act="entrar"]');
  await pin(p.page, '7391'); await esperaTexto(p.page, /Marcar pelo chat/);
  const href = await p.page.getAttribute('a.btn[href]', 'href');
  const sec = /Deixar uma solicitação/.test(await texto(p.page));
  ana = p;
  return { ok: href === '../' && sec, detalhe: href };
});
await caso('Meus dados: CPF por pessoa (informar, ver só a máscara, alterar, apagar); CPF inválido é recusado', async () => {
  const { page } = ana;
  await page.click('[data-act="go"][data-v="dados"]');
  const antes = await texto(page);
  await page.click('[data-act="sheet"][data-t="cpf"][data-p="eu"]');
  await page.fill('#cpfn', '11111111111'); await page.click('[data-act="scpf"]');
  await esperaTexto(page, /não conferem/);
  await page.fill('#cpfn', '52998224725'); const mascarado = await page.inputValue('#cpfn');
  await page.click('[data-act="scpf"]');
  await esperaTexto(page, /\*\*\*\.\*\*\*\.\*\*\*-25/);
  const depois = await texto(page);
  const banco = (await q(`select cpf from public.app_paciente where telefone = '71991230001'`))[0].cpf;
  const naTela = await page.evaluate(() => JSON.stringify(S.perfil));
  await page.click('[data-act="sheet"][data-t="cpf"][data-p="eu"]'); await page.click('[data-act="apagacpf"]');
  await esperaTexto(page, /CPF: ainda não salvo/);
  const apagado = (await q(`select cpf from public.app_paciente where telefone = '71991230001'`))[0].cpf;
  return { ok: /ainda não salvo/.test(antes) && mascarado === '529.982.247-25' && /\*\*\*-25/.test(depois) && banco === '52998224725' && !naTela.includes('52998224725') && apagado === null, detalhe: mascarado };
});
await caso('veio do chat (?voltar=chat): depois do PIN a página devolve para o chat', async () => {
  const p = await novaPagina('/?voltar=chat');
  await p.page.click('[data-act="go"][data-v="entrar"]');
  await p.page.fill('#tel', '71991230001'); await p.page.click('[data-act="entrar"]');
  await pin(p.page, '7391');
  await p.page.waitForURL((u) => !String(u).includes('voltar'), { timeout: 5000 });
  return { ok: !p.page.url().includes('voltar'), detalhe: p.page.url() };
});
await caso('nenhum erro de script nem violação da política de segurança do navegador durante todo o roteiro', async () => ({ ok: erros.length === 0, detalhe: erros.slice(0, 3).join(' | ') }));

await browser.close();
const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
