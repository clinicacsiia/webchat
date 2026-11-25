// FLUXOGRAMA: entrada (o chat de produção index.html + etapas.js num navegador de verdade, falando com o MOTOR REAL do banco: o retrato da produção num Postgres embutido + supabase/marcacao-etapas-parte1.sql)
//   -> validação (a chave marcacao_etapas_modo: "nao" mantém o chat de sempre; "piloto" só abre para quem está na lista; "sim" abre para todos)
//   -> lógica (o paciente percorre a tela por etapas até o fim; o teste confere o que ficou no banco: pedido, ciência da pré-marcação, conversa; e o caminho de volta ao chat de sempre)
//   -> saída (casos PASS/FAIL)
// Versão 1.0 — 24/11/2026 / Mudança: Implementação inicial (integração do sistema de marcação por etapas).
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

/* ---------- 1. a chave: "nao" é o chat de sempre ---------- */
await caso('chave "nao" (padrão): o botão Começar abre o chat de SEMPRE, a tela por etapas nem é carregada', async () => {
  const { page, ctx, erros } = await abrir('nao'); await page.click('#btnIniciar');
  await page.waitForSelector('#msgs .msg.agente', { timeout: 10000 });
  const etapas = await page.evaluate(() => !!window.CSI_ETAPAS || !!document.getElementById('marc')); const conv = await ultimaConversa();
  await ctx.close();
  return { ok: !etapas && conv.motor === 'fluxo' && erros.excecoes.length === 0, detalhe: `etapas=${etapas} erros=${erros.excecoes.join('|')}` };
});
await caso('chave ausente ou com valor estranho = "nao"', async () => {
  const { page, ctx } = await abrir('talvez'); await page.click('#btnIniciar');
  await page.waitForSelector('#msgs .msg.agente', { timeout: 10000 });
  const etapas = await page.evaluate(() => !!window.CSI_ETAPAS); await ctx.close();
  return { ok: !etapas };
});
await caso('chave "piloto" e telefone FORA da lista: chat de sempre', async () => {
  await cfg('marcacao_etapas_telefones', '71988880001');
  const { page, ctx } = await abrir('piloto', '71977770002'); await page.click('#btnIniciar');
  await page.waitForSelector('#msgs .msg.agente', { timeout: 10000 });
  const etapas = await page.evaluate(() => !!window.CSI_ETAPAS); await ctx.close();
  return { ok: !etapas };
});

/* ---------- 2. caminho feliz com o motor real ---------- */
let conv1;
await caso('chave "piloto" e telefone NA lista: abre a tela por etapas e percorre TODO o caminho (CPF > consulta > plano > horário > dados > conferir) até o pedido chegar à equipe', async () => {
  await cfg('marcacao_etapas_telefones', '71988880001');
  const { page, ctx, erros } = await abrir('piloto', '71988880001'); await page.click('#btnIniciar');
  await esperaPasso(page, 'cpf_nasc');
  const vistos = await ateOFim(page);
  conv1 = await ultimaConversa(); const pa = await pedidoDe(conv1.id);
  const html = await page.locator('#marc').innerText(); await ctx.close();
  const ordem = vistos.join(' > ');
  return { ok: pa.status === 'pronto' && pa.tipo === 'consulta' && pa.plano === 'Particular' && pa.horarios === 1 && pa.paciente.nome === 'Maria Teste da Silva' && /acompanhar|marcado|marcando/.test(vistos.at(-1))
    && /cpf_nasc > consulta/.test(ordem) && erros.excecoes.length === 0, detalhe: `${ordem} | pedido=${JSON.stringify({ s: pa.status, p: pa.plano, h: pa.horarios })} | erros=${erros.excecoes.join('|')} | ${html.slice(0, 60).replace(/\n/g, ' ')}` };
});
await caso('o motor guardou a conversa como sempre (a equipe vê a mesma coisa no painel): mensagens do paciente e do assistente em ordem', async () => {
  const ms = await q(`select autor from public.mensagens where conversa_id = $1 order by id`, [conv1.id]);
  const agente = ms.filter((m) => m.autor === 'agente').length, cliente = ms.filter((m) => m.autor === 'cliente').length;
  return { ok: ms[0].autor === 'agente' && agente >= 7 && cliente >= 7, detalhe: `${agente} do assistente, ${cliente} do paciente` };
});

/* ---------- 3. "Nenhum horário serve": pré-marcação com ciência gravada no servidor ---------- */
await caso('"Nenhum desses horários serve": mostra a pré-marcação, o botão vermelho grava a ciência NO SERVIDOR e o pedido segue para a equipe sem horário', async () => {
  await cfg('marcacao_etapas_modo', 'sim');
  const { page, ctx, erros } = await abrir('sim'); await page.click('#btnIniciar'); await esperaPasso(page, 'cpf_nasc');
  const antes = (await um(`select count(*)::int n from public.marcacao_ciencia`)).n;
  const vistos = await ateOFim(page, { horario: 'sem_horario', ciente: true });
  await page.waitForTimeout(400);
  const c = await ultimaConversa(), pa = await pedidoDe(c.id), ci = await q(`select ip, aparelho, motivo, versao_texto from public.marcacao_ciencia where conversa_id = $1`, [c.id]);
  const nota = await um(`select dados from public.conversa_fluxo where conversa_id = $1`, [c.id]);
  await ctx.close();
  return { ok: ci.length === 1 && ci[0].versao_texto === 'pre-marcacao-v1' && !!ci[0].aparelho.idioma && (nota.dados.notas || []).some((n) => /CIÊNCIA DA PRÉ-MARCAÇÃO/.test(n)) && pa.horarios === 0 && pa.status === 'pronto' && erros.excecoes.length === 0 && (await um(`select count(*)::int n from public.marcacao_ciencia`)).n === antes + 1,
    detalhe: `${vistos.join(' > ')} | ciências=${ci.length} | pedido=${pa.status}/${pa.horarios} horários | erros=${erros.excecoes.join('|')}` };
});
await caso('SEM tocar no botão vermelho, a ciência NÃO é gravada e o pedido NÃO segue (a pessoa pode voltar)', async () => {
  const { page, ctx } = await abrir('sim'); await page.click('#btnIniciar'); await esperaPasso(page, 'cpf_nasc');
  const antes = (await um(`select count(*)::int n from public.marcacao_ciencia`)).n;
  await ateOFim(page, { horario: 'sem_horario', ciente: false });
  const c = await ultimaConversa(), depois = (await um(`select count(*)::int n from public.marcacao_ciencia`)).n;
  const noPasso = await passo(page); const pa = await pedidoDe(c.id); await ctx.close();
  return { ok: depois === antes && noPasso === 'horario' && pa.status !== 'pronto', detalhe: `passo=${noPasso} pedido=${pa.status}` };
});

/* ---------- 4. a saída para o chat de sempre ---------- */
await caso('"Falar com a equipe" abre o chat de sempre NA MESMA conversa (nada se perde) e a conversa deixa de ser "por etapas"', async () => {
  const { page, ctx } = await abrir('sim'); await page.click('#btnIniciar'); await esperaPasso(page, 'cpf_nasc');
  const antes = await ultimaConversa();
  await page.click('#etpChat'); await page.waitForSelector('#msgs .msg.agente', { timeout: 8000 });
  const aberto = await page.evaluate(() => { const r = document.getElementById('marc'); return !r || r.hidden; });
  const salvo = await page.evaluate(() => JSON.parse(localStorage.getItem('teste.webchat.conversa.v1') || localStorage.getItem('webchat.conversa.v1') || 'null'));
  const msgs = await page.locator('#msgs .msg.agente').count(); await ctx.close();
  return { ok: aberto && msgs >= 1 && (salvo === null || salvo.etapas === false) && (await ultimaConversa()).id === antes.id, detalhe: `msgs=${msgs} etapas=${salvo && salvo.etapas}` };
});
await caso('recarregar a página no meio do caminho volta para a MESMA pergunta, na tela por etapas', async () => {
  const { page, ctx } = await abrir('sim'); await page.click('#btnIniciar'); await esperaPasso(page, 'cpf_nasc');
  const n1 = (await q(`select count(*)::int n from public.conversas`))[0].n;
  await page.reload(); await esperaPasso(page, 'cpf_nasc', 15000);
  const n2 = (await q(`select count(*)::int n from public.conversas`))[0].n; await ctx.close();
  return { ok: n2 === n1, detalhe: `conversas antes=${n1} depois=${n2}` };
});
await caso('com os irmãos (juntos), a tela por etapas NÃO abre: segue o chat de sempre', async () => {
  const { page, ctx } = await abrir('sim');
  await page.click('#fQuem .unidade >> nth=1'); await page.fill('#fFilho', 'Pedro Teste da Silva');
  await page.click('#btnAddIrmao').catch(() => {});
  const campos = page.locator('#listaIrmaos input'); if (await campos.count()) await campos.first().fill('Ana Teste da Silva');
  await page.click('#btnIniciar'); await page.waitForSelector('#msgs .msg.agente', { timeout: 10000 });
  const etapas = await page.evaluate(() => { const r = document.getElementById('marc'); return !!r && !r.hidden; });
  const c = await um(`select jsonb_array_length(irmaos)::int n from public.conversas order by criado_em desc limit 1`); await ctx.close();
  return { ok: !etapas && c.n >= 1, detalhe: `irmãos na conversa=${c.n}` };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
