// FLUXOGRAMA: entrada (o chat de produção index.html + etapas.js num navegador de verdade, falando com o MOTOR REAL do banco: o retrato da produção + supabase/marcacao-etapas-parte1.sql)
//   -> validação (pessoas ligadas: filho sozinho; conversa antiga reaberta com a chave ligada; a mesma pessoa em duas conversas, uma do chat de sempre e outra por etapas)
//   -> lógica (o teste confere o que ficou no banco: tipo do paciente, número de conversas, grupo da pessoa; e que NADA muda na conversa antiga)
//   -> saída (casos PASS/FAIL)
// Versão 1.0 — 25/11/2026 / Mudança: Implementação inicial (revisão das pessoas ligadas e das conversas antigas na tela por etapas).
// Dados: nenhum dado real; nomes e telefones inventados. Nada vai ao Klingo nem ao Supabase de verdade.
// Dados: nenhum dado real; nomes e telefones inventados. Nada vai ao Klingo nem ao Supabase de verdade: cada chamada do navegador é respondida pelo clone do banco.
import { readFileSync } from 'node:fs';
import { chromium, servidor, criarMundo, novaPaginaChat } from './mock-chat.mjs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } }

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo } = ajudantes(db);
const UNIDADE = 'CLÍNICA DE SAÚDE E IMAGEM - CSI';
await db.exec(`
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo'), ('nome_empresa', 'Clínica de Teste'), ('boas_vindas', 'Olá!'), ('reabrir_dias', '2')
    on conflict (chave) do update set valor = excluded.valor;
  insert into public.unidade_config (chave, catalogo, rotulo, descricao, fluxo, instrucao, ordem, ativo) values ('csi', '${UNIDADE}', 'CSI', 'x', 'exame_consulta', 'x', 1, true)
    on conflict (chave) do update set ativo = true, catalogo = excluded.catalogo, fluxo = excluded.fluxo;
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values (301, 'CONSULTA', 'CONSULTAS', true, 20, '');
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select 301, 'CONSULTA', '${UNIDADE}', 'CONSULTORIO 1', 'DR EXEMPLO UM', 'CARDIOLOGIA', d, '08:00', '12:00', 30, current_date - 30, current_date + 300 from generate_series(0, 6) d;
`);
await db.exec(readFileSync(`${REPO}/supabase/marcacao-etapas-parte1.sql`, 'utf8'));
const cfg = (chave, valor) => db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]);
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));

/* ---------- o "Supabase" do navegador = o clone do banco (motor real). Uma chamada por vez (o clone tem uma conexão só). ---------- */
const dia = (n) => new Date(Date.now() + n * 864e5).toLocaleString('sv-SE', { timeZone: 'America/Bahia' }).slice(0, 10);
const tipos = new Map();
async function tiposDe(nome) {
  if (!tipos.has(nome)) {
    const r = await q(`select a.n as nome, format_type(a.t, null) as tipo from pg_proc p join pg_namespace s on s.oid = p.pronamespace,
      unnest(p.proargnames, string_to_array(p.proargtypes::text, ' ')::oid[]) as a(n, t) where s.nspname = 'public' and p.proname = $1`, [nome]);
    tipos.set(nome, new Map(r.map((x) => [x.nome, x.tipo])));
  }
  return tipos.get(nome);
}
let fila = Promise.resolve();
const serie = (fn) => { const r = fila.then(fn, fn); fila = r.catch(() => {}); return r; };
const semearOfertas = async (conversa) => {   // o papel da Edge Function chat-agenda-api: grava as ofertas da API e a consulta que as originou
  await db.exec('reset role');
  const it = await um(`select i.procedimento_id id from public.pre_agendamento_itens i where i.conversa_id = $1 and i.ativo and i.procedimento_id is not null order by i.id limit 1`, [conversa]);
  if (!it) return false;
  const lista = [1, 2, 3].flatMap((n) => ['08:30', '10:00'].map((h) => ({ chave: `${dia(n)}|63|308|2|${h}`, data: dia(n), hora: h, profissional: 'DR EXEMPLO UM', unidade: UNIDADE })));
  await db.query(`select public.klingo_oferta_gravar_v2($1, $2, 1, $3::jsonb, false, true)`, [conversa, it.id, JSON.stringify(lista)]);
  await db.query(`select public.klingo_consulta_registrar($1, 'sim', 'consulta', $2, 1, 'ok_com_horarios', 200, 6, 6, 0, 6, 900, null)`, [conversa, it.id]);
  return true;
};
const chamadasBanco = [];
function mundoReal() {
  const m = criarMundo();
  m.tratar = (nome, corpo) => serie(async () => {
    chamadasBanco.push(nome);
    try {
      const tp = await tiposDe(nome), ks = Object.keys(corpo || {}).filter((k) => tp.has(k));
      const args = ks.map((k, i) => `${k} => $${i + 1}::${tp.get(k)}`).join(', ');
      const vals = ks.map((k) => { const v = corpo[k], t = tp.get(k); return t === 'jsonb' ? JSON.stringify(v) : (v !== null && typeof v === 'object' ? JSON.stringify(v) : v); });
      await db.exec('reset role; set role anon');
      const r = await q(`select public.${nome}(${args}) r`, vals);
      await db.exec('reset role');
      return { body: r[0] ? r[0].r : null };
    } catch (e) {
      await db.exec('reset role').catch(() => {});
      return { status: 400, body: { code: e.code || 'XX000', message: String(e.message).split('\n')[0] } };
    }
  });
  m.tratarFuncao = (nome, corpo) => serie(async () => {
    if (nome !== 'chat-agenda-api') return { body: {} };
    const ok = await semearOfertas(corpo.conversa);
    return { body: { ok, modo: 'sim', estado: ok ? 'com_horarios' : 'sem_horarios' } };
  });
  return m;
}

const srv = await servidor(); const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
let nTel = 0;
const telefone = () => '7198' + String(7100000 + ++nTel);
async function abrir(modo, tel = telefone()) {
  await cfg('marcacao_etapas_modo', modo);
  const mundo = mundoReal();
  const { page, ctx, erros } = await novaPaginaChat(browser, mundo);
  await page.goto(`${base}/index.html`); await page.waitForSelector('#formInicio', { state: 'visible', timeout: 10000 });
  await page.click('#fQuem .unidade >> nth=0');
  await page.fill('#fNome', 'Maria Teste da Silva'); await page.fill('#fTel', tel); await page.fill('#fEmail', 'maria@exemplo.invalid');
  await page.check('#fAceite'); await page.check('#fPrevisao');
  return { page, ctx, erros, tel, mundo };
}
const passo = (page) => page.evaluate(() => { const r = document.getElementById('marc'); return r && !r.hidden ? r.dataset.passo || '' : null; });
const esperaPasso = async (page, ps, ms = 12000) => {
  const lista = [].concat(ps), t0 = Date.now();
  for (;;) { const p = await passo(page); if (p !== null && lista.includes(p)) return p; if (Date.now() - t0 > ms) throw new Error(`esperava ${lista.join('|')}, está em ${p}`); await page.waitForTimeout(80); }
};
const clicaOpcao = (page, texto) => page.locator('#marc .marc-op', { hasText: texto }).first().click();
const doPasso = async (page, ctxDados) => {   // percorre as perguntas do motor como um paciente
  const p = await esperaPasso(page, ['cpf_nasc', 'cpf_confirma', 'consulta', 'medico', 'plano', 'horario', 'dados_ident', 'dados_contato', 'mudou', 'confirmar', 'valor', 'acompanhar', 'marcando', 'marcado', 'texto', 'previsao_turno', 'previsao_periodo', 'previsao_decide', 'previsao_antecedencia', 'atalho', 'dados_endereco', 'dados_carteira']);
  return p;
};
async function ateOFim(page, { horario = 'escolher', ciente = false } = {}) {
  const vistos = [];
  for (let i = 0; i < 25; i++) {
    const p = await doPasso(page); vistos.push(p);
    if (['acompanhar', 'marcado', 'marcando', 'texto'].includes(p)) break;
    if (p === 'cpf_nasc') { await page.fill('#etp_cpf', '11144477735'); await page.fill('#etp_dt_nasc', '25031980'); await page.click('#etpContinuar'); }
    else if (p === 'consulta') await page.locator('#marc .marc-op').first().click();
    else if (p === 'medico') await page.locator('#marc .marc-op').first().click();
    else if (p === 'plano') await clicaOpcao(page, 'Particular');
    else if (p === 'horario') {
      await page.waitForSelector('#marc .marc-hora, #etpNenhum, #marc .marc-bt', { timeout: 12000 });
      if (horario === 'sem_horario') {
        await page.click('#etpNenhum'); await esperaPasso(page, 'horario');   // a tela da pré-marcação mantém o passo do motor
        await page.waitForSelector('#etpCiente', { timeout: 5000 });
        if (ciente) { await page.click('#etpCiente'); } else break;
      } else { await page.locator('#marc .marc-hora').first().click(); await page.click('#etpContinuar'); }
    } else if (p === 'dados_ident') { await page.fill('#etp_nome', 'Maria Teste da Silva'); await page.locator('#marc .marc-op', { hasText: 'Feminino' }).click(); await page.click('#etpContinuar'); }
    else if (p === 'dados_contato') { await page.fill('#etp_celular', '71999990001'); await page.fill('#etp_email', 'maria@exemplo.invalid'); await page.click('#etpContinuar'); }
    else if (p === 'mudou') await clicaOpcao(page, 'continuam os mesmos');
    else if (p === 'confirmar') await clicaOpcao(page, 'Está tudo certo');
    else if (p === 'dados_endereco' || p === 'dados_carteira') await page.click('#etpPular');
    else { await clicaOpcao(page, 'Continuar').catch(() => {}); }
    await page.waitForTimeout(150);
  }
  return vistos;
}
const ultimaConversa = () => um(`select c.id, c.status, c.ia_ativa, c.motor, f.passo from public.conversas c left join public.conversa_fluxo f on f.conversa_id = c.id order by c.criado_em desc limit 1`);
const pedidoDe = (c) => um(`select status, tipo, plano, jsonb_array_length(coalesce(escolha_horario, '[]'::jsonb))::int as horarios, paciente from public.pre_agendamentos where conversa_id = $1`, [c]);

// Criança: na produção a consulta vai para a unidade de pediatria (fluxo "pediatria"); o clone só tinha a CSI.
await db.exec(`
  insert into public.unidade_config (chave, catalogo, rotulo, descricao, fluxo, instrucao, ordem, ativo) values ('desenvoar', 'DESENVOAR', 'Desenvoar', 'x', 'pediatria', 'x', 2, true)
    on conflict (chave) do update set ativo = true, catalogo = excluded.catalogo, fluxo = excluded.fluxo;
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values (302, 'CONSULTA PEDIATRICA', 'CONSULTAS', true, 20, '') on conflict (id) do nothing;
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select 302, 'CONSULTA PEDIATRICA', 'DESENVOAR', 'CONSULTORIO 2', 'DRA EXEMPLO DOIS', 'PEDIATRIA', d, '08:00', '12:00', 30, current_date - 30, current_date + 300 from generate_series(0, 6) d;
`);
const gruposDe = (a, b) => um(`select count(distinct grupo_id)::int n, count(*)::int m from public.conversa_grupo where conversa_id in ($1, $2)`, [a, b]);

/* ---------- 1. filho sozinho (92% das conversas da produção são de filho) ---------- */
await caso('filho(a) sozinho(a): a tela por etapas abre, fala "Atendimento para <criança>" e a conversa fica como "filho" com o nome da criança', async () => {
  const { page, ctx, erros } = await abrir('sim');
  await page.click('#fQuem .unidade >> nth=1'); await page.fill('#fFilho', 'Pedro Teste da Silva');
  await page.click('#btnIniciar'); await esperaPasso(page, 'cpf_nasc');
  const textoCpf = await page.locator('#marc').innerText();
  let vistos; try { vistos = await ateOFim(page); } catch (e) { const t = await page.locator('#marc').innerText().catch(() => ''); const p = await passo(page); throw new Error(`parou em ${p}: ${t.replace(/\n+/g, ' | ').slice(0, 400)} :: ${String(e.message).split('\n')[0]}`); }
  const c = await um(`select id, paciente_tipo, paciente_nome from public.conversas order by criado_em desc limit 1`);
  const pa = await pedidoDe(c.id); await ctx.close();
  return { ok: c.paciente_tipo === 'filho' && c.paciente_nome === 'Pedro Teste da Silva' && pa.status === 'pronto' && erros.excecoes.length === 0,
    detalhe: `${vistos.join(' > ')} | tipo=${c.paciente_tipo} nome=${c.paciente_nome} pedido=${pa.status} | erros=${erros.excecoes.join('|')} | cpf_nasc fala da criança? ${/Pedro|crian/i.test(textoCpf)}` };
});

/* ---------- 2. conversa ANTIGA (começada no chat de sempre) com a chave ligada depois ---------- */
await caso('conversa antiga (começada com a chave "nao") continua no chat de sempre quando a chave passa para "sim": sem conversa nova, sem perder mensagens', async () => {
  const { page, ctx, erros } = await abrir('nao'); await page.click('#btnIniciar');
  await page.waitForSelector('#msgs .msg.agente', { timeout: 10000 });
  const c0 = await ultimaConversa(); const m0 = (await um(`select count(*)::int n from public.mensagens where conversa_id = $1`, [c0.id])).n;
  const n0 = (await um(`select count(*)::int n from public.conversas`)).n;
  await cfg('marcacao_etapas_modo', 'sim');                     // o dono liga a chave com a conversa ainda aberta no aparelho
  await page.reload(); await page.waitForSelector('#msgs .msg.agente', { timeout: 15000 });
  const etapas = await page.evaluate(() => { const r = document.getElementById('marc'); return !!r && !r.hidden; });
  const n1 = (await um(`select count(*)::int n from public.conversas`)).n; const m1 = (await um(`select count(*)::int n from public.mensagens where conversa_id = $1`, [c0.id])).n;
  const msgsNaTela = await page.locator('#msgs .msg').count(); await ctx.close();
  return { ok: !etapas && n1 === n0 && m1 >= m0 && msgsNaTela >= 1 && erros.excecoes.length === 0, detalhe: `etapas=${etapas} conversas ${n0}>${n1} mensagens ${m0}>${m1} na tela=${msgsNaTela} erros=${erros.excecoes.join('|')}` };
});
await caso('conversa por etapas com a chave desligada depois ("nao"): a pessoa continua no chat de sempre, na MESMA conversa', async () => {
  const { page, ctx } = await abrir('sim'); await page.click('#btnIniciar'); await esperaPasso(page, 'cpf_nasc');
  const c0 = await ultimaConversa(), n0 = (await um(`select count(*)::int n from public.conversas`)).n;
  await cfg('marcacao_etapas_modo', 'nao');
  await page.reload(); await page.waitForSelector('#msgs .msg.agente', { timeout: 15000 });
  const etapas = await page.evaluate(() => { const r = document.getElementById('marc'); return !!r && !r.hidden; });
  const n1 = (await um(`select count(*)::int n from public.conversas`)).n; await ctx.close(); await cfg('marcacao_etapas_modo', 'sim');
  return { ok: !etapas && n1 === n0, detalhe: `etapas=${etapas} conversas ${n0}>${n1}` };
});

/* ---------- 3. a mesma pessoa em duas conversas (uma antiga do chat, outra por etapas) ---------- */
await caso('a mesma pessoa (mesmo celular, criança e nascimento) em uma conversa do chat de sempre e outra por etapas cai no MESMO grupo de pessoa', async () => {
  const tel = telefone();
  // A: chat de sempre (chave "nao"), responde CPF e nascimento pelo motor
  const A = await abrir('nao', tel);
  await A.page.click('#fQuem .unidade >> nth=1'); await A.page.fill('#fFilho', 'Pedro Teste da Silva');
  await A.page.click('#btnIniciar'); await A.page.waitForSelector('#msgs .msg.agente', { timeout: 10000 });
  const ca = await ultimaConversa();
  await db.exec('reset role');
  await db.query(`select public.chat_responder($1, (select token from public.conversa_segredo where conversa_id = $1), 'cpf_nasc', $2::jsonb, null)`, [ca.id, JSON.stringify({ cpf: '11144477735', dt_nasc: '25/03/2020' })]).catch(() => {});
  await A.ctx.close();
  // B: por etapas, mesma pessoa
  const B = await abrir('sim', tel);
  await B.page.click('#fQuem .unidade >> nth=1'); await B.page.fill('#fFilho', 'Pedro Teste da Silva');
  await B.page.click('#btnIniciar'); await esperaPasso(B.page, 'cpf_nasc');
  await B.page.fill('#etp_cpf', '11144477735'); await B.page.fill('#etp_dt_nasc', '25032020'); await B.page.click('#etpContinuar');
  await esperaPasso(B.page, ['consulta', 'medico', 'plano']);
  const cb = await ultimaConversa(); await B.ctx.close();
  await db.exec('reset role');
  await db.query(`select public.pessoa_agrupar($1)`, [cb.id]).catch(() => {});
  const g = await gruposDe(ca.id, cb.id);
  return { ok: ca.id !== cb.id && g.m === 2 && g.n === 1, detalhe: `conversas=${ca.id.slice(0, 8)} e ${cb.id.slice(0, 8)} | linhas no grupo=${g.m} grupos distintos=${g.n}` };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
