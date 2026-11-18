// FLUXOGRAMA: entrada (previsao/index.html aberto num Chromium de celular; as chamadas à API do Supabase vão para o banco de teste, que tem o retrato da produção + supabase/previsao-marcacao-parte1..4.sql) -> validação (link, celular + nascimento, link inválido, canal desligado)
//   -> lógica ("não sei" e "pode seguir" nunca barram; o aviso de previsão aparece em toda tela; a resposta da atendente chega na conversa)
//   -> saída (PASS/FAIL por caso) | ROLLBACK: apagar a pasta previsao/
// Versão 1.0 — 17/11/2026 / Mudança: primeira versão (Webchat de Previsão de marcação). Prova a página e o banco JUNTOS. Não fala com o Supabase de verdade. Dados inventados.
import { readFileSync } from 'node:fs';
import { chromium } from './mock-chat.mjs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db } = await criarBancoProducao();
const { q } = ajudantes(db);
for (const n of ['parte1-tabelas', 'parte2-paciente', 'parte3-painel', 'parte4-carga']) await db.exec(readFileSync(`${REPO}/supabase/previsao-marcacao-${n}.sql`, 'utf8'));
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

// ---------- 1) pelo link ----------
let a = await novaPagina(`/previsao/?c=${CODIGO}`);
await caso('o link mostra o nome, as marcações em português claro e o aviso de previsão', async () => {
  await esperaTexto(a.page, /Está certo/);
  const t = await texto(a.page);
  return { ok: /Olá, Maria!/.test(t) && /Consulta/.test(t) && /Cardiologia/i.test(t) && /Exame/.test(t) && /Joelho/i.test(t) && /CSI RM\/TC/.test(t) && temAvisoCompleto(t) && !/CPF/.test(t), detalhe: t.slice(0, 300).replace(/\n/g, ' | ') };
});
await caso('as 3 respostas existem e "Não sei / pode seguir" está ao alcance', async () => {
  const t = await texto(a.page);
  return { ok: /Sim, está certo/.test(t) && /Tem algo diferente/.test(t) && /Não sei \/ pode seguir/.test(t) };
});
await caso('"Não sei / pode seguir" NÃO barra: vai para o passo seguinte, com o aviso, e pular também segue', async () => {
  await a.page.click('button[data-r="nao_sei"]');
  await esperaTexto(a.page, /Quase pronto/);
  const t1 = await texto(a.page);
  const faltam = /Data de nascimento/.test(t1) === false && /CPF/.test(t1) === false;   // Maria já tem nascimento e CPF no Klingo
  await a.page.click('#pular');
  await esperaTexto(a.page, /Fale com a equipe/);
  const t2 = await texto(a.page);
  const p = (await q(`select resposta, conversa_id from public.pmarc_pessoa where chave = '7001'`))[0];
  return { ok: temAvisoCompleto(t1) && temAvisoCompleto(t2) && faltam && /Anotamos o que você nos contou/.test(t2) && p.resposta === 'nao_sei' && !!p.conversa_id, detalhe: JSON.stringify({ faltam, resp: p.resposta }) };
});
await caso('a conversa abre com o aviso final da clínica e o paciente escreve para a equipe', async () => {
  await esperaTexto(a.page, /vista e confirmada pela nossa equipe/);
  await a.page.fill('#texto', 'Bom dia! Posso mudar para sexta?');
  await a.page.click('#fEnviar button');
  await esperaTexto(a.page, /Posso mudar para sexta/);
  const msgs = (await q(`select autor, texto from public.mensagens m join public.pmarc_pessoa p on p.conversa_id = m.conversa_id where p.chave = '7001' order by m.id`));
  return { ok: msgs.some((m) => m.autor === 'cliente' && /mudar para sexta/.test(m.texto)) && msgs.some((m) => m.autor === 'agente' && /vista e confirmada/.test(m.texto)), detalhe: `${msgs.length} mensagens` };
});
await caso('a resposta da atendente chega sozinha na conversa (sem recarregar)', async () => {
  const conv = (await q(`select conversa_id from public.pmarc_pessoa where chave = '7001'`))[0].conversa_id;
  await db.query(`insert into public.mensagens (conversa_id, autor, texto) values ($1, 'agente', 'Oi Maria! Sexta às 9h, pode ser?')`, [conv]);
  await esperaTexto(a.page, /Sexta às 9h, pode ser/, 12000);
  return { ok: true };
});
await caso('voltar sem o link abre direto na conversa (o aparelho lembra)', async () => {
  await a.page.goto(`${ORIGEM}/previsao/`);
  await esperaTexto(a.page, /Fale com a equipe/);
  return { ok: /Sexta às 9h/.test(await texto(a.page)) };
});
await caso('o link pessoal (?c=) sai do endereço depois de aceito, e o código continua guardado só neste aparelho (18/11/2026)', async () => {
  await a.page.goto(`${ORIGEM}/previsao/?c=${CODIGO}`);
  await esperaTexto(a.page, /Fale com a equipe/);
  const r = await a.page.evaluate(() => ({ url: location.href, guardado: localStorage.getItem('pmarc.codigo') }));
  return { ok: !/[?&]c=/.test(r.url) && r.guardado === CODIGO, detalhe: JSON.stringify(r) };
});
await caso('"Sair deste aparelho" esquece o código e volta para a tela de achar a previsão; ao recarregar não reabre a conversa (18/11/2026)', async () => {
  await a.page.click('#btnSair');
  await esperaTexto(a.page, /Ache a sua previsão/);
  const guardado = await a.page.evaluate(() => localStorage.getItem('pmarc.codigo'));
  await a.page.goto(`${ORIGEM}/previsao/`);
  await esperaTexto(a.page, /Ache a sua previsão/);
  const t = await texto(a.page);
  return { ok: guardado === null && !/Sexta às 9h/.test(t) && !/Fale com a equipe/.test(t), detalhe: String(guardado) };
});
await a.ctx.close();

// ---------- 2) sem link: celular + nascimento ----------
let b = await novaPagina('/previsao/');
await caso('sem link: pede celular e nascimento, com o aviso de previsão e a saída "falar com a equipe"', async () => {
  await esperaTexto(b.page, /Ache a sua previsão/);
  const t = await texto(b.page);
  return { ok: temAvisoCompleto(t) && /Não achei \/ quero falar com a equipe/.test(t) };
});
await caso('celular + nascimento certos acham a previsão', async () => {
  await b.page.fill('#cel', '71991230001'); await b.page.fill('#nasc', '03/02/1985'); await b.page.click('#fAchar button[type=submit]');
  await esperaTexto(b.page, /Fale com a equipe|Está certo/);
  return { ok: /Maria/.test(await texto(b.page)) || /Sua previsão/.test(await texto(b.page)) };
});
await b.ctx.close();

// ---------- 3) não achou: entra assim mesmo ----------
let c = await novaPagina('/previsao/');
await caso('dados que não batem NÃO travam: oferecem deixar os dados e falar com a equipe', async () => {
  await esperaTexto(c.page, /Ache a sua previsão/);
  await c.page.fill('#cel', '71988880000'); await c.page.fill('#nasc', '01/01/2000'); await c.page.click('#fAchar button[type=submit]');
  await esperaTexto(c.page, /Não encontramos uma previsão/);
  const t = await texto(c.page);
  return { ok: /Enviar para a equipe/.test(t) && temAvisoCompleto(t) };
});
await caso('o pré-cadastro espontâneo aceita nome incompleto e vira conversa para a atendente', async () => {
  await c.page.fill('#nome', 'Dora'); await c.page.fill('#cel2', '71988880000'); await c.page.fill('#txt', 'Marquei por telefone um ultrassom');
  await c.page.click('#fNovo button[type=submit]');
  await esperaTexto(c.page, /Fale com a equipe[\s\S]*Anotamos|Anotamos[\s\S]*Fale com a equipe/);
  const p = (await q(`select p.origem, p.informado->>'observacao' obs, p.resposta, cv.ia_ativa, cv.status from public.pmarc_pessoa p join public.conversas cv on cv.id = p.conversa_id where p.celular = '71988880000'`))[0];
  return { ok: p && p.origem === 'espontaneo' && /ultrassom/.test(p.obs) && p.resposta === null && p.ia_ativa === false && p.status === 'aguardando', detalhe: JSON.stringify(p) };
});
await c.ctx.close();

// ---------- 4) link inválido e canal desligado ----------
let d = await novaPagina('/previsao/?c=codigoquenaoexiste123');
await caso('link que não vale volta para o formulário com uma explicação (sem tela de erro)', async () => {
  await esperaTexto(d.page, /Esse link não está mais valendo/);
  return { ok: /Ache a sua previsão/.test(await texto(d.page)) };
});
await d.ctx.close();
await db.exec(`update public.config set valor = 'nao' where chave = 'previsao_marcacao_modo'`);
let e = await novaPagina(`/previsao/?c=${CODIGO}`);
await caso('canal desligado: avisa com calma e leva ao chat do site', async () => {
  await esperaTexto(e.page, /ainda não está disponível/);
  return { ok: /Ir para o chat/.test(await texto(e.page)) };
});
await e.ctx.close();

await caso('só chamou funções pmarc_*, com a chave pública (sem login) e sem erro de JavaScript', async () => {
  const fora = chamadasRede.filter((x) => !/^pmarc_/.test(x.nome)).map((x) => x.nome);
  const comLogin = chamadasRede.filter((x) => x.auth && x.auth !== undefined && /Bearer (?!sb_publishable)/.test(x.auth));
  return { ok: fora.length === 0 && comLogin.length === 0 && erros.length === 0, detalhe: JSON.stringify({ fora, comLogin: comLogin.length, erros }) };
});

await browser.close();
const falhas = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} casos passaram`);
process.exit(falhas ? 1 : 0);
