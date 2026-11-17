// FLUXOGRAMA: entrada (previsao/index.html num Chromium de celular; a API do Supabase vai para o banco de teste com o retrato da produção + previsao-marcacao-parte1..5.sql; catálogo, grade e pessoas INVENTADOS)
//   -> validação (faixa de horário invertida avisa; nada barra: escolher nada, não achar na lista e quem não tem link também enviam)
//   -> lógica (lista de exames/consultas com busca e abas; turno / a partir de / até; disponibilidade prevista; o pedido vira mensagem para a equipe)
//   -> saída (PASS/FAIL por caso) | ROLLBACK: apagar a pasta previsao/
// Versão 1.0 — 17/11/2026 / Mudança: primeira versão (tela "Pedir uma previsão"). Prova a página e o banco JUNTOS. Não fala com o Supabase de verdade.
import { readFileSync } from 'node:fs';
import { chromium } from './mock-chat.mjs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db } = await criarBancoProducao();
const { q } = ajudantes(db);
for (const n of ['parte1-tabelas', 'parte2-paciente', 'parte3-painel', 'parte4-carga', 'parte5-escolha']) await db.exec(readFileSync(`${REPO}/supabase/previsao-marcacao-${n}.sql`, 'utf8'));
await db.exec(`
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste') on conflict (chave) do update set valor = excluded.valor;
  update public.config set valor = 'sim' where chave = 'previsao_marcacao_modo';
  insert into public.jornada_coluna (id, nome, ordem, etapa, origem) values ('agendado', 'Agendado', 1, 'agendamento', 'klingo') on conflict do nothing;
  insert into public.jornada_paciente (prontuario, nome, fone_chave) values ('7001', 'MARIA TESTE DA SILVA', 'z1');
  insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna) values ('7001', (now() + interval '1 day')::date, 'CSI', 'agendado'), ('7001', (now() + interval '2 days')::date, 'RM/TC', 'agendado');
`);
const amanha = new Date(Date.now() + 86400e3).toISOString(), depois = new Date(Date.now() + 2 * 86400e3).toISOString();
const cardId = async (un) => (await q(`select id from public.jornada_card where paciente_chave = '7001' and unidade = $1`, [un]))[0].id;
await db.query(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, unidade, agendado_para, status, confirm_status) values
  ($1, 'm7001', 'CONSULTA CARDIOLOGIA', 'CSI', $3, 'agendado', 'A Confirmar'), ($2, 'm7002', 'RM JOELHO (NAO INCLUI ARTRO)', 'RM/TC', $4, 'confirmado', 'Confirmado')`, [await cardId('CSI'), await cardId('RM/TC'), amanha, depois]);
await db.exec(`select public.pmarc_lote('[{"p":"7001","n":"MARIA TESTE DA SILVA","c":"71991230001","v":"N"}]'::jsonb)`);
await db.exec(`select public.pmarc_enriquecer_lote('[{"m":"7001","e":"maria@exemplo.invalid","d":"1985-02-03","k":true}]'::jsonb)`);
await db.exec(`
  insert into public.catalogo_procedimento (id, nome, classe, busca, ativo, demanda_90d) values
    (9101, 'ULTRASSONOGRAFIA ABDOME TOTAL', 'ULTRASSONOGRAFIA', to_tsvector('simple', 'ultrassonografia abdome total'), true, 50),
    (9102, 'CONSULTA PEDIATRIA', 'CONSULTAS', to_tsvector('simple', 'consulta pediatria'), true, 80);
  insert into public.catalogo_agenda (unidade, local, profissional, procedimento_id, procedimento, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select 'CSI', 'SALA 1', 'DR FULANO', pid, pnome, dn, '07:00', '19:00', 30, current_date - 1, current_date + 60
    from (values (9101, 'ULTRASSONOGRAFIA ABDOME TOTAL'), (9102, 'CONSULTA PEDIATRIA')) p(pid, pnome), generate_series(0, 6) dn;
`);
const CODIGO = (await q(`select codigo from public.pmarc_pessoa where chave = '7001'`))[0].codigo;

const HTML = readFileSync(`${REPO}/previsao/index.html`, 'utf8');
const NOMES = readFileSync(`${REPO}/nomes-exame.js`, 'utf8');
const ORIGEM = 'https://previsao.teste.local';
const API = 'https://nrvuynjwcgwpjdptkiay.supabase.co';
const chamadasRede = [];

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
    valores.push(info.tipos[i] === 'jsonb' ? (v === null ? null : JSON.stringify(v)) : v === null ? null : String(v));
    partes.push(`${k} => $${valores.length}::${info.tipos[i]}`);
  });
  await db.exec('reset role; set role anon');
  try { return { status: 200, corpo: (await db.query(`select public.${nome}(${partes.join(', ')}) as r`, valores)).rows[0].r }; }
  catch (e) { return { status: 400, corpo: { message: e.message } }; }
  finally { await db.exec('reset role'); }
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const erros = [];
async function novaPagina(caminho) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 1, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push('console: ' + m.text()); });
  await ctx.route(`${ORIGEM}/**`, (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p === '/nomes-exame.js') return r.fulfill({ status: 200, contentType: 'application/javascript', body: NOMES });
    if (p.startsWith('/img/') || p.endsWith('.png')) return r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' });
    if (p === '/') return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>chat</title><body>CHAT-DE-MENTIRA</body>' });
    return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
  });
  await ctx.route(`${API}/**`, async (r) => {
    const req = r.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const nome = new URL(req.url()).pathname.split('/rpc/')[1];
    const corpo = req.postDataJSON();
    chamadasRede.push({ nome, auth: req.headers()['authorization'] });
    const res = await serializar(() => chamarFuncao(nome, corpo));
    return r.fulfill({ status: res.status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(res.corpo) });
  });
  await page.goto(`${ORIGEM}${caminho}`);
  return { ctx, page };
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const texto = (page) => page.locator('body').innerText();
const esperaTexto = (page, re, ms = 5000) => page.waitForFunction((s) => new RegExp(s, 's').test(document.body.innerText), re.source, { timeout: ms });
const AVISO = /PREVISÃO/;
const temAvisoCompleto = (t) => AVISO.test(t) && /webchat/.test(t) && /WhatsApp/.test(t) && /telefone/.test(t);


const clicaTexto = (page, rotulo) => page.locator('button', { hasText: rotulo }).first().click();

// ---------- 1) sem link: lista, filtro, disponibilidade e pedido com horário ----------
let a = await novaPagina('/previsao/');
await caso('a página inicial oferece "Escolher um exame ou consulta e ver a disponibilidade"', async () => {
  await esperaTexto(a.page, /Ache a sua previsão/);
  return { ok: /Escolher um exame ou consulta e ver a disponibilidade/.test(await texto(a.page)) };
});
await caso('a lista mostra exames e consultas com agenda, com o aviso de previsão; as abas separam e a busca acha', async () => {
  await a.page.click('#btnPedir'); await esperaTexto(a.page, /1\. O que você quer/);
  await esperaTexto(a.page, /[Pp]ediatria/);
  const t = await texto(a.page);
  await clicaTexto(a.page, 'Consultas'); await a.page.waitForFunction(() => (()=>{const l=document.querySelector('#lista');return l.querySelector('.proc')&&!/Abdome/i.test(l.innerText)})());
  const soCons = /Pediatria/i.test(await a.page.locator('#lista').innerText());
  await clicaTexto(a.page, 'Tudo'); await a.page.fill('#busca', 'ultra'); await a.page.waitForFunction(() => (()=>{const l=document.querySelector('#lista');return l.querySelector('.proc')&&!/Pediatria/i.test(l.innerText)})());
  const busca = /Abdome/i.test(await a.page.locator('#lista').innerText());
  return { ok: temAvisoCompleto(t) && /Abdome/i.test(t) && /Pediatria/i.test(t) && /Consulta/.test(t) && /Exame/.test(t) && soCons && busca };
});
await caso('escolher o exame abre "Quando você prefere?" com turno, a partir das, até as, até o dia e unidade', async () => {
  await a.page.locator('#lista button.proc').first().click(); await esperaTexto(a.page, /Quando você prefere/);
  const t = await texto(a.page);
  return { ok: /Abdome/i.test(t) && /Manhã/.test(t) && /Tarde/.test(t) && /Noite/.test(t) && /Sem preferência/.test(t) && /A partir das/.test(t) && /Até as/.test(t) && /Até o dia/.test(t) && /Unidade/.test(t) && /Ver a disponibilidade/.test(t) && temAvisoCompleto(t) };
});
await caso('faixa invertida (até antes de a partir) avisa e não consulta', async () => {
  await a.page.selectOption('#apos', '14:00'); await a.page.selectOption('#ate', '09:00'); await a.page.click('#fQuando button[type=submit]');
  await esperaTexto(a.page, /precisa ser depois/);
  return { ok: true };
});
await caso('tarde + a partir das 13:00: só mostra horários da tarde a partir de 13:00, com aviso de que é previsão', async () => {
  await a.page.selectOption('#ate', ''); await clicaTexto(a.page, 'Tarde'); await a.page.selectOption('#apos', '13:00'); await a.page.click('#fQuando button[type=submit]');
  await esperaTexto(a.page, /Disponibilidade prevista/); await esperaTexto(a.page, /Horários previstos|\d\d:\d\d/);
  const horas = await a.page.locator('button[data-k]').evaluateAll((bs) => bs.map((b) => b.dataset.k.split('|')[1]));
  const t = await texto(a.page);
  return { ok: horas.length > 0 && horas.every((h) => h >= '13:00' && h < '18:00') && /tarde/.test(t) && /a partir das 13:00/.test(t) && /PREVISÃO/.test(t) && /reservados nem confirmados/.test(t), detalhe: `${horas.length} horários, ${horas.slice(0, 4).join(',')}` };
});
await caso('tocar num horário o marca; "Pedir esta previsão" sem link pede só o celular, e o pedido chega à equipe com o horário visto', async () => {
  await a.page.locator('button[data-k]').first().click();
  const marcado = await a.page.locator('button[data-k][aria-pressed=true]').count();
  await a.page.click('#pedir'); await esperaTexto(a.page, /Para a equipe responder/);
  await a.page.fill('#i-nome', 'Dora Teste'); await a.page.fill('#i-cel', '71988880001'); await a.page.click('#fId button[type=submit]');
  await esperaTexto(a.page, /Pedido enviado/);
  const t = await texto(a.page);
  const m = (await q(`select m.autor, m.texto, cv.ia_ativa from public.mensagens m join public.pmarc_pessoa p on p.conversa_id = m.conversa_id join public.conversas cv on cv.id = p.conversa_id where p.celular = '71988880001' order by m.id`));
  const ped = m.find((x) => x.autor === 'cliente' && /Pedido de previsão/.test(x.texto));
  return { ok: marcado === 1 && /recebeu o seu pedido/.test(t) && temAvisoCompleto(t) && !!ped && /ULTRASSONOGRAFIA ABDOME TOTAL/.test(ped.texto) && /Turno: tarde/.test(ped.texto) && /A partir das: 13:00/.test(ped.texto) && /Horário que viu/.test(ped.texto) && m[0].ia_ativa === false, detalhe: ped && ped.texto.replace(/\n/g, ' | ') };
});
await caso('depois do envio dá para falar com a equipe (a conversa abre)', async () => {
  await clicaTexto(a.page, 'Falar com a equipe'); await esperaTexto(a.page, /Fale com a equipe/);
  return { ok: /Pedido de previsão|vista e confirmada/.test(await texto(a.page)) };
});
await a.ctx.close();

// ---------- 2) com o link: NÃO escolher nada e ver a disponibilidade ----------
let b = await novaPagina(`/previsao/?c=${CODIGO}`);
await caso('com o link: botão "Escolher e ver a disponibilidade" na tela da previsão', async () => {
  await esperaTexto(b.page, /Está certo/);
  return { ok: /Quer outro exame ou consulta/.test(await texto(b.page)) && /Escolher e ver a disponibilidade/.test(await texto(b.page)) };
});
await caso('sem escolher turno nem horário: "Ver a disponibilidade" mostra os próximos horários (de manhã e de tarde)', async () => {
  await b.page.click('#btnPedir'); await esperaTexto(b.page, /1\. O que você quer/); await esperaTexto(b.page, /[Pp]ediatria/);
  await clicaTexto(b.page, 'Consultas'); await b.page.waitForFunction(() => (()=>{const l=document.querySelector('#lista');return l.querySelector('.proc')&&!/Abdome/i.test(l.innerText)})());
  await b.page.locator('#lista button.proc').first().click(); await esperaTexto(b.page, /Quando você prefere/);
  await b.page.click('#fQuando button[type=submit]'); await esperaTexto(b.page, /Disponibilidade prevista/); await b.page.waitForSelector('button[data-k]');
  const horas = await b.page.locator('button[data-k]').evaluateAll((bs) => bs.map((x) => x.dataset.k.split('|')[1]));
  const t = await texto(b.page);
  return { ok: horas.length > 0 && horas.some((h) => h < '12:00') && horas.some((h) => h >= '12:00') && /sem preferência/.test(t) && /Pediatria/i.test(t), detalhe: `${horas.length} horários` };
});
await caso('pedir sem tocar em horário: vale; a equipe recebe "sem preferência" e a pessoa já identificada não precisa digitar nada', async () => {
  await b.page.click('#pedir'); await esperaTexto(b.page, /Pedido enviado/);
  const m = (await q(`select m.texto from public.mensagens m join public.pmarc_pessoa p on p.conversa_id = m.conversa_id where p.chave = '7001' and m.autor = 'cliente' and m.texto like 'Pedido de previsão%'`));
  return { ok: m.length === 1 && /Pediatria|PEDIATRIA/.test(m[0].texto) && /Sem preferência de horário/.test(m[0].texto) && !/Horário que viu/.test(m[0].texto), detalhe: m[0] && m[0].texto.replace(/\n/g, ' | ') };
});
await caso('"Pedir outra previsão" volta à lista; "Não achei o que procuro" aceita texto livre e envia', async () => {
  await clicaTexto(b.page, 'Pedir outra previsão'); await esperaTexto(b.page, /1\. O que você quer/);
  await b.page.click('#naoAchei'); await esperaTexto(b.page, /O que você procura/);
  await b.page.fill('#livre', 'exame de sangue'); await b.page.click('#fLivre button[type=submit]'); await esperaTexto(b.page, /Quando você prefere/);
  const semBotaoVer = (await b.page.locator('#fQuando button[type=submit]').count()) === 0;
  await clicaTexto(b.page, 'Pedir para a equipe'); await esperaTexto(b.page, /Pedido enviado/);
  const m = (await q(`select m.texto from public.mensagens m join public.pmarc_pessoa p on p.conversa_id = m.conversa_id where p.chave = '7001' and m.autor = 'cliente' and m.texto like 'Pedido de previsão: exame de sangue%'`));
  return { ok: semBotaoVer && m.length === 1, detalhe: `${m.length} mensagens` };
});
await b.ctx.close();

await caso('só chamou funções pmarc_* com a chave pública e sem erro de JavaScript', async () => {
  const fora = chamadasRede.filter((x) => !/^pmarc_/.test(x.nome)).map((x) => x.nome);
  const novas = new Set(chamadasRede.map((x) => x.nome));
  return { ok: fora.length === 0 && ['pmarc_catalogo', 'pmarc_disponibilidade', 'pmarc_pedido'].every((n) => novas.has(n)) && erros.length === 0, detalhe: JSON.stringify({ fora, erros }) };
});

await browser.close();
const falhas = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} casos passaram`);
process.exit(falhas ? 1 : 0);
