// FLUXOGRAMA: entrada (acesso/index.html aberto num Chromium de celular com config.app_pin_obrigatorio = sim; as chamadas ao Supabase vão para o banco de teste com o retrato da produção + as migrações do acesso rápido + acesso-rapido-pin-obrigatorio.sql) -> validação (quem aperta os botões de verdade: celular, nome, CPF só do que falta, teclado do PIN, tela "Falta pouco") -> lógica (celular que já tem PIN vai direto ao PIN; cadastro novo exige CPF antes do PIN; o que a clínica já sabe não é perguntado; entrada com cadastro incompleto é barrada até completar; cada entrada é registrada, com a posição só se permitida) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (PIN obrigatório na porta do chat)
// Dados inventados. Nada fala com o Supabase de verdade.
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
const AMANHA = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
const NASC_ANA = '1988-04-12', NASC_LEO = '2019-08-30', NASC_DAVI = '2022-01-10';


const C1 = '52998224725', C1_TXT = '529.982.247-25';
const ult = (nome) => chamadasRede.filter((c) => c.nome === nome).length;
// Bia já é conhecida da clínica (celular + nome + nascimento); Ana é nova.
await db.exec(`insert into public.pacientes (nome, nome_norm, telefones, dt_nasc, cpf) values ('Bia Costa Teste', 'bia costa teste', array['71991230002'], '1990-02-03', '${C1_TXT}')`);

// ================================================================= Ana: nova, sem nada salvo
let ana = await novaPagina('/?voltar=chat');
await caso('com o PIN obrigatório a página abre no passo 1, sem erro', async () => ({ ok: /Vamos começar/.test(await texto(ana.page)) && ult('app_porta') === 1 }));
await caso('celular novo segue para nome e nascimento; cadastro: nome → sem filhos → pede o CPF dela', async () => {
  await ana.page.fill('#tel', '71991230001'); await ana.page.click('[data-act="c1"]');
  await esperaTexto(ana.page, /Confirme quem é você/);
  await ana.page.fill('#nome', 'Ana Souza Teste'); await ana.page.fill('#nasc', '1988-04-12'); await ana.page.click('[data-act="c2"]');
  await ana.page.click('[data-act="tf"][data-v="0"]'); await ana.page.click('[data-act="c3"]');
  await esperaTexto(ana.page, /Seu CPF/);
  const t = await texto(ana.page);
  return { ok: /O CPF é obrigatório para criar o PIN/.test(t) && (await ana.page.locator('input[data-cp]').count()) === 1, detalhe: t.slice(0, 60) };
});
await caso('CPF vazio ou curto não passa; com máscara automática', async () => {
  await ana.page.click('[data-act="c3b"]'); const vazio = await texto(ana.page);
  await ana.page.fill('input[data-cp="eu"]', '5299822'); await ana.page.click('[data-act="c3b"]'); const curto = await texto(ana.page);
  await ana.page.fill('input[data-cp="eu"]', C1); const mask = await ana.page.inputValue('input[data-cp="eu"]');
  return { ok: /Informe o seu CPF/.test(vazio) && /Informe o seu CPF/.test(curto) && mask === C1_TXT };
});
await caso('CPF → número de confiança (pular) → PIN → cadastro e CPF gravados juntos, e volta para o chat', async () => {
  await ana.page.click('[data-act="c3b"]'); await esperaTexto(ana.page, /Número de confiança/);
  await ana.page.click('[data-act="c4skip"]');
  await pin(ana.page, '1357'); await pin(ana.page, '1357');
  await ana.page.waitForURL((u) => !String(u).includes('voltar'), { timeout: 6000 });
  const l = (await q(`select cpf from public.app_paciente where telefone = '71991230001'`))[0];
  return { ok: l.cpf === C1 && ult('app_pin_criar') === 1 && ult('app_cadastrar') === 0, detalhe: ana.page.url() };
});
await caso('a entrada ficou registrada com os dados do aparelho (sem posição: o interruptor está desligado)', async () => {
  const l = (await q(`select evento, idioma, fuso, lat, na_clinica from public.app_acesso_log order by id desc limit 1`))[0];
  return { ok: l.evento === 'cadastro' && l.idioma === 'pt-BR' && !!l.fuso && l.lat === null && l.na_clinica === null, detalhe: JSON.stringify(l) };
});

// ================================================================= Bia: a clínica já conhece
let bia = await novaPagina('/');
await caso('quem a clínica já conhece não digita o CPF: filhos → direto ao número de confiança', async () => {
  await bia.page.fill('#tel', '71991230002'); await bia.page.click('[data-act="c1"]'); await esperaTexto(bia.page, /Confirme quem é você/);
  await bia.page.fill('#nome', 'Bia Costa Teste'); await bia.page.fill('#nasc', '1990-02-03'); await bia.page.click('[data-act="c2"]');
  await bia.page.click('[data-act="tf"][data-v="0"]'); await bia.page.click('[data-act="c3"]');
  await esperaTexto(bia.page, /Número de confiança/);
  return { ok: !/Seu CPF/.test(await texto(bia.page)) };
});
await caso('só falta criar o PIN: o cadastro nasce com o CPF da clínica e a tela nunca recebeu o CPF', async () => {
  await bia.page.click('[data-act="c4skip"]'); await pin(bia.page, '2468'); await pin(bia.page, '2468');
  await esperaTexto(bia.page, /Olá, Bia/);
  const l = (await q(`select cpf from public.app_paciente where telefone = '71991230002'`))[0];
  const naRede = JSON.stringify(chamadasRede);
  return { ok: l.cpf === C1 && !/529\.?982/.test(await texto(bia.page)) && !naRede.includes(C1), detalhe: '' };
});

// ================================================================= celular que já tem PIN
let ja = await novaPagina('/');
await caso('celular que já tem PIN vai direto ao teclado do PIN (sem refazer cadastro)', async () => {
  await ja.page.fill('#tel', '71991230001'); await ja.page.click('[data-act="c1"]');
  await esperaTexto(ja.page, /Seu PIN/);
  return { ok: /já tem cadastro/.test(await texto(ja.page)) };
});

// ================================================================= cadastro antigo incompleto: barrado até completar
// Cora entrou pelo caminho antigo (sem CPF, com filho sem CPF). Com o PIN obrigatório não passa do PIN sem completar.
const cora = (await q(`select public.app_cadastrar(p_telefone => '71991230003', p_nome => 'Cora Alves Teste', p_nascimento => '1985-06-15', p_pin => '3579', p_filhos => '[{"nome":"Leo Alves Teste","nascimento":"2019-08-30"}]'::jsonb, p_aparelho => 'T') r`))[0].r;
await q(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
let co = await novaPagina('/?voltar=chat', {}, `localStorage.setItem('csi_acesso_v2', JSON.stringify({dev: '${cora.token}', nome1: 'Cora'}))`);
await caso('cadastro incompleto: depois do PIN aparece "Falta pouco" com o CPF dela e o do filho, sem "Agora não"', async () => {
  await pin(co.page, '3579'); await esperaTexto(co.page, /Falta pouco/);
  const t = await texto(co.page);
  return { ok: /CPF/.test(t) && /Leo/.test(t) && !/Agora não/.test(t) && /Salvar e continuar/.test(t) && co.page.url().includes('voltar'), detalhe: t.slice(0, 80) };
});
await caso('não deixa seguir sem preencher o que é obrigatório; e-mail é opcional', async () => {
  await co.page.click('[data-act="completarsalvar"]'); const vazio = await texto(co.page);
  await co.page.fill('#pd0', '123.456.789-00'); await co.page.fill('#pd2', '111.444.777-35'); await co.page.click('[data-act="completarsalvar"]');
  await esperaTexto(co.page, /não conferem/);
  return { ok: /Preencha o CPF/.test(vazio) && /Os números do CPF não conferem/.test(await texto(co.page)) && (await q(`select count(*)::int n from public.app_paciente where cpf is not null and telefone = '71991230003'`))[0].n === 0 };
});
await caso('completou (CPF dela e do filho): registra a entrada e devolve para o chat', async () => {
  const campos = await co.page.locator('#pend input').count();
  const inputs = co.page.locator('#pend input[data-pc="cpf"]');
  await inputs.nth(0).fill('52998224725'); await inputs.nth(1).fill('11144477735');
  await co.page.click('[data-act="completarsalvar"]');
  await co.page.waitForURL((u) => !String(u).includes('voltar'), { timeout: 6000 });
  const l = (await q(`select a.cpf, (select cpf from public.app_filho where responsavel_id = a.id) f from public.app_paciente a where telefone = '71991230003'`))[0];
  const ev = (await q(`select evento from public.app_acesso_log order by id desc limit 1`))[0].evento;
  return { ok: campos >= 3 && l.cpf === '52998224725' && l.f === '11144477735' && ev === 'desbloqueio', detalhe: `${campos} campos; ${ev}` };
});

// ================================================================= posição
await db.exec(`update public.config set valor = 'sim' where chave = 'app_local_ativo'; update public.config set valor = '-12.9714' where chave = 'clinica_lat'; update public.config set valor = '-38.5012' where chave = 'clinica_lng';`);
await q(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
const tokAna = (await q(`select public.app_login(p_telefone => '71991230001', p_pin => '1357', p_aparelho => 'T') r`))[0].r.token;
await q(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
let po = await novaPagina('/', { permissions: ['geolocation'], geolocation: { latitude: -12.97141, longitude: -38.50121, accuracy: 25 } }, `localStorage.setItem('csi_acesso_v2', JSON.stringify({dev: '${tokAna}', nome1: 'Ana'}))`);
await caso('com a posição ligada o teclado avisa o motivo, e a posição permitida vai ao servidor: "na clínica"', async () => {
  const t = await texto(po.page);
  await pin(po.page, '1357'); await esperaTexto(po.page, /Marcar pelo chat/);
  const l = (await q(`select evento, na_clinica, distancia_m, precisao_m from public.app_acesso_log order by id desc limit 1`))[0];
  const pres = await po.page.evaluate(() => sessionStorage.getItem('csi_presenca'));
  return { ok: /pedir a sua localização/.test(t) && l.evento === 'desbloqueio' && l.na_clinica === true && l.distancia_m < 50 && !!pres, detalhe: JSON.stringify(l) };
});
await q(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
let neg = await novaPagina('/', { permissions: [] }, `localStorage.setItem('csi_acesso_v2', JSON.stringify({dev: '${tokAna}', nome1: 'Ana'}))`);
await caso('localização negada: entra do mesmo jeito e a recusa fica registrada', async () => {
  await pin(neg.page, '1357'); await esperaTexto(neg.page, /Marcar pelo chat/);
  const l = (await q(`select na_clinica, local_negado from public.app_acesso_log order by id desc limit 1`))[0];
  return { ok: l.na_clinica === null && l.local_negado === true, detalhe: JSON.stringify(l) };
});

// ================================================================= preenchimento pelo celular
let cache = await novaPagina('/', {}, `localStorage.setItem('webchat.perfil.v1', JSON.stringify({nome: 'Gabi Ramos Teste', telefone: '(71) 99123-0009', email: 'gabi@exemplo.invalid', aceite: true}))`);
await caso('quem já usou o chat neste aparelho começa com celular e nome preenchidos', async () => {
  const tel = await cache.page.inputValue('#tel');
  await cache.page.click('[data-act="c1"]'); await esperaTexto(cache.page, /Confirme quem é você/);
  return { ok: tel === '(71) 99123-0009' && (await cache.page.inputValue('#nome')) === 'Gabi Ramos Teste' };
});
await caso('o e-mail guardado no chat vai junto no cadastro (opcional)', async () => {
  await cache.page.fill('#nasc', '1993-09-09'); await cache.page.click('[data-act="c2"]');
  await cache.page.click('[data-act="tf"][data-v="0"]'); await cache.page.click('[data-act="c3"]');
  await esperaTexto(cache.page, /Seu CPF/);
  await cache.page.fill('input[data-cp="eu"]', C1); await cache.page.click('[data-act="c3b"]'); await esperaTexto(cache.page, /Número de confiança/);
  await cache.page.click('[data-act="c4skip"]'); await pin(cache.page, '1470'); await pin(cache.page, '1470');
  await esperaTexto(cache.page, /Olá, Gabi/);
  const l = (await q(`select email from public.app_paciente where telefone = '71991230009'`))[0];
  return { ok: l.email === 'gabi@exemplo.invalid' };
});

// ================================================================= com o interruptor desligado tudo volta ao jeito antigo
await db.exec(`update public.config set valor = 'nao' where chave = 'app_pin_obrigatorio'`);
let velho = await novaPagina('/');
await caso('PIN obrigatório DESLIGADO: o cadastro volta ao jeito antigo (sem passo de CPF, app_cadastrar)', async () => {
  await velho.page.fill('#tel', '71991230010'); await velho.page.click('[data-act="c1"]'); await esperaTexto(velho.page, /Confirme quem é você/);
  await velho.page.fill('#nome', 'Davi Lima Teste'); await velho.page.fill('#nasc', '1991-01-01'); await velho.page.click('[data-act="c2"]');
  await velho.page.click('[data-act="tf"][data-v="0"]'); await velho.page.click('[data-act="c3"]');
  await esperaTexto(velho.page, /Número de confiança/);
  await velho.page.click('[data-act="c4skip"]'); await pin(velho.page, '7391'); await pin(velho.page, '7391');
  await esperaTexto(velho.page, /Olá, Davi/);
  return { ok: ult('app_cadastrar') === 1 && (await q(`select cpf from public.app_paciente where telefone = '71991230010'`))[0].cpf === null };
});
await caso('nenhum erro de script nem violação da política de segurança durante todo o roteiro', async () => ({ ok: erros.length === 0, detalhe: erros.slice(0, 3).join(' | ') }));

await browser.close();
const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
