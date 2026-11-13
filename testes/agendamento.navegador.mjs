// FLUXOGRAMA: entrada (página /agendamento/ servida localmente + a função klingo-agendamento SIMULADA por interceptação de rede, com dados inventados) -> validação (cada fluxo do paciente:
//   marcar, horário tomado, cancelar, remarcar, paciente novo, consultar, injeção de HTML vinda da API, privacidade do CPF) -> lógica (confere o que a página ENVIA e o que MOSTRA) -> saída (PASS/FAIL).
// Versão 1.0 — 13/11/2026 / Mudança: primeira versão. Não fala com o Klingo nem com o Supabase: a função de verdade é testada em supabase/functions/klingo-agendamento/agendamento.test.ts.
// Requer um Chromium (CHROMIUM_PATH ou o do Playwright).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, d = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, 'exceção: ' + e.message.split('\n')[0]); } };
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  const f = resolve(REPO, '.' + new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html'));
  if (!f.startsWith(REPO) || !existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TIPOS[extname(f)] || 'application/octet-stream' }).end(readFileSync(f));
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

const CPF = '111.444.777-35', CPF_D = '11144477735', NASC = '1980-03-25', CHAVE = '2026-11-20|63|308|2|09:40', CHAVE2 = '2026-11-20|63|308|2|10:00';
const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

async function abrir({ ocupadoNaMarcacao = false, vazio = false, malicioso = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const estado = { chamadas: [], vouchers: [{ id: '26638', status: 'agendado', data: '2026-11-20', hora: '09:40', procedimento: 'CONSULTA', profissional: 'DRA TESTE', unidade: 'DESENVOAR' }], pre: false };
  await ctx.route('**/functions/v1/klingo-agendamento', async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    const c = JSON.parse(r.request().postData() || '{}'); estado.chamadas.push(c);
    const j = (corpo, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(corpo) });
    switch (c.acao) {
      case 'versao': return j({ ok: true, api: 'OK [API1]' });
      case 'catalogo':
        if (c.catalogo === 'especialidades') return j({ ok: true, dados: [{ id: 1, cbos: '225112', descr: malicioso ? '<img src=x onerror="window.__xss=1">NEUROLOGIA' : 'NEUROLOGIA' }, { id: 2, cbos: '225124', descr: 'PEDIATRIA' }] });
        if (c.catalogo === 'convenios') return j({ ok: true, dados: [{ id: 1, nome: 'PARTICULAR', planos: [{ id: 1, nome: 'PARTICULAR' }, { id: 8, nome: 'CORTESIA' }] }, { id: 28, nome: 'PLANSERV', planos: [{ id: 28, nome: 'PLANSERV' }] }] });
        if (c.catalogo === 'preco') return j({ ok: true, dados: { id_item_tabela: null, valor: 250 } });
        if (c.catalogo === 'unidades') return j({ ok: true, dados: [{ id: 1, nome: 'CLÍNICA DE SAÚDE E IMAGEM - CSI', sigla: 'CSI' }, { id: 2, nome: 'DESENVOAR', sigla: 'PEDIATRIA' }] });
        if (c.catalogo === 'consultas') return j({ ok: true, dados: [{ id: 1096, descr: 'CONSULTA' }, { id: 1472, descr: 'CONSULTA NEUROPEDIATRIA' }] });
        return j({ ok: true, dados: [] });
      case 'horarios': return vazio ? j({ ok: true, total: 0, horarios: [], motivo: 'sem_medico' }) : j({ ok: true, total: 2, inicio: c.inicio, fim: c.fim, horarios: [
        { id: CHAVE, data: '2026-11-20', hora: '09:40', procedimento: '1096', ordem_chegada: false, profissional: { nome: 'DRA TESTE' }, unidade: { nome: 'DESENVOAR', sigla: 'PEDIATRIA' } },
        { id: CHAVE2, data: '2026-11-20', hora: '10:00', procedimento: '1096', ordem_chegada: false, profissional: { nome: 'DRA TESTE' }, unidade: { nome: 'DESENVOAR', sigla: 'PEDIATRIA' } }] });
      case 'identificar':
        if (c.cpf === CPF_D && c.nascimento === NASC) return j({ ok: true, situacao: 'confere', tipo: estado.pre ? 'pre' : 'definitivo', pre_cadastro: estado.pre, primeiro_nome: 'Maria', plano: { id: 1, nome: 'PARTICULAR' } });
        return j({ ok: false, motivo: 'nao_confere', mensagem: 'Não encontramos um cadastro com este CPF e esta data de nascimento.' });
      case 'reservar': return j({ ok: true, reserva: { id: '555', expira: null, data: '2026-11-20', hora: '09:40', instrucao: { procedimento: 'Chegar com 15 minutos de antecedência', profissional: null } } });
      case 'soltar': return j({ ok: true, solto: true });
      case 'marcar': case 'remarcar':
        if (ocupadoNaMarcacao) return j({ ok: false, motivo: 'horario_ocupado', mensagem: 'Este horário acabou de ser ocupado. Escolha outro.' });
        estado.vouchers.push({ id: '26700', status: 'agendado', data: '2026-11-20', hora: '09:40', procedimento: 'CONSULTA', profissional: 'DRA TESTE', unidade: 'DESENVOAR' });
        return j({ ok: true, voucher: { id: '26700', status: 'agendado', data: '2026-11-20', hora: '09:40', procedimento: 'CONSULTA', profissional: 'DRA TESTE', unidade: 'DESENVOAR' } });
      case 'minhas_marcacoes': return j({ ok: true, marcacoes: estado.vouchers });
      case 'cancelar': estado.vouchers = estado.vouchers.filter((v) => v.id !== c.voucher); return j({ ok: true, cancelado: c.voucher });
      case 'meus_dados': return j({ ok: true, pre_cadastro: false, dados: { nome: 'Maria Teste', nascimento: NASC, celular: '(••) •••••-8888', email: 'm•••@exemplo.com', convenio: 'PLANSERV', plano: 'PLANSERV' } });
      case 'cadastrar': estado.pre = true; return j({ ok: true, tipo: 'pre', primeiro_nome: 'Joana' });
      case 'resultado': return j({ ok: true, pronto: false, motivo: 'sem_resultado' });
      default: return j({ ok: false, motivo: 'acao_invalida' }, 400);
    }
  });
  const pagina = await ctx.newPage(); const erros = [];
  pagina.on('pageerror', (e) => erros.push(e.message)); pagina.on('dialog', (d) => d.accept());
  await pagina.goto(`${base}/agendamento/`);
  await pagina.waitForSelector('#estadoApi');
  return { ctx, pagina, estado, erros };
}
const clicar = (p, nome) => p.getByRole('button', { name: nome, exact: false }).first().click();
const entrar = async (p) => { await p.fill('#idCpf', CPF); await p.fill('#idNasc', NASC); await clicar(p, 'Entrar'); };
async function ateHorarios(p) { await p.waitForSelector('#selEsp'); await p.selectOption('#selEsp', '225112'); await clicar(p, 'Ver horários'); await p.getByText('Escolha o dia e a hora').waitFor(); }

await caso('abre, mostra o sistema no ar e as cinco abas', async () => {
  const { pagina, erros, ctx } = await abrir(); await pagina.waitForFunction(() => document.querySelector('#estadoApi').textContent.includes('no ar'));
  const abas = await pagina.locator('nav.abas button').allTextContents(); await ctx.close();
  return { ok: abas.length === 5 && abas[0] === 'Marcar' && erros.length === 0, detalhe: abas.join(' | ') + (erros[0] || '') };
});

await caso('marcar consulta de ponta a ponta: horários → entrar → reserva → confirmar → "Agendado!"', async () => {
  const { pagina, estado, ctx } = await abrir(); await ateHorarios(pagina);
  await clicar(pagina, '09:40'); await pagina.waitForSelector('#idCpf');
  await entrar(pagina); await pagina.getByText('Confira e confirme').waitFor(); await pagina.getByText('Horário reservado para você').waitFor();
  await clicar(pagina, 'Confirmar agendamento'); await pagina.getByText('Agendado!').waitFor();
  const acoes = estado.chamadas.map((c) => c.acao).filter((a) => ['horarios', 'identificar', 'reservar', 'marcar'].includes(a));
  const marcar = estado.chamadas.find((c) => c.acao === 'marcar'), res = estado.chamadas.find((c) => c.acao === 'reservar'), hor = estado.chamadas.find((c) => c.acao === 'horarios');
  const ok = acoes.join() === 'horarios,identificar,reservar,marcar' && marcar.confirmar === true && marcar.reserva === '555' && marcar.horario === CHAVE && marcar.procedimento === '1096' && String(marcar.plano) === '1'
    && marcar.cpf === CPF_D && marcar.nascimento === NASC && res.horario === CHAVE && hor.especialidade === '225112' && hor.inicio.length === 10;
  await ctx.close(); return { ok, detalhe: acoes.join() };
});

await caso('horário tomado na confirmação: avisa e volta para a lista de horários', async () => {
  const { pagina, ctx } = await abrir({ ocupadoNaMarcacao: true }); await ateHorarios(pagina); await clicar(pagina, '10:00'); await entrar(pagina);
  await pagina.getByText('Confira e confirme').waitFor(); await clicar(pagina, 'Confirmar agendamento');
  await pagina.getByText('acabou de ser ocupado').first().waitFor(); const volta = await pagina.getByText('Escolha o dia e a hora').isVisible(); await ctx.close(); return { ok: volta };
});

await caso('sem horários (convênio sem médico): explica e oferece mudar a busca', async () => {
  const { pagina, ctx } = await abrir({ vazio: true }); await ateHorarios(pagina); const t = await pagina.getByText('Nenhum médico atende com este convênio').count(); const b = await pagina.getByRole('button', { name: 'Mudar a busca' }).count(); await ctx.close(); return { ok: t === 1 && b === 1 };
});

await caso('CPF inválido e nascimento vazio são barrados na página, sem chamar a função', async () => {
  const { pagina, estado, ctx } = await abrir(); await ateHorarios(pagina); await clicar(pagina, '09:40'); await pagina.waitForSelector('#idCpf');
  await pagina.fill('#idCpf', '111.444.777-36'); await pagina.fill('#idNasc', NASC); await clicar(pagina, 'Entrar'); const e1 = await pagina.getByText('O CPF não parece certo').isVisible();
  await pagina.fill('#idCpf', CPF); await pagina.fill('#idNasc', ''); await clicar(pagina, 'Entrar'); const e2 = await pagina.getByText('Informe a data de nascimento').isVisible();
  const chamou = estado.chamadas.some((c) => c.acao === 'identificar'); await ctx.close(); return { ok: e1 && e2 && !chamou };
});

await caso('CPF e nascimento errados: mostra a mensagem e não entra', async () => {
  const { pagina, ctx } = await abrir(); await ateHorarios(pagina); await clicar(pagina, '09:40'); await pagina.waitForSelector('#idCpf');
  await pagina.fill('#idCpf', '529.982.247-25'); await pagina.fill('#idNasc', '1999-01-01'); await clicar(pagina, 'Entrar');
  await pagina.getByText('Não encontramos um cadastro').first().waitFor(); const naoEntrou = await pagina.locator('#quem').isHidden(); await ctx.close(); return { ok: naoEntrou };
});

await caso('minhas marcações: lista, cancela (com confirmação) e some', async () => {
  const { pagina, estado, ctx } = await abrir(); await pagina.getByRole('tab', { name: 'Minhas marcações' }).click(); await entrar(pagina);
  await pagina.getByText('Marcação 26638').waitFor(); await pagina.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await pagina.getByText('Marcação cancelada.').waitFor(); const c = estado.chamadas.find((x) => x.acao === 'cancelar'); const sumiu = (await pagina.getByText('Marcação 26638').count()) === 0;
  await ctx.close(); return { ok: c && c.confirmar === true && c.voucher === '26638' && sumiu };
});

await caso('remarcar: abre a busca com o aviso e envia o voucher antigo', async () => {
  const { pagina, estado, ctx } = await abrir(); await pagina.getByRole('tab', { name: 'Minhas marcações' }).click(); await entrar(pagina); await pagina.getByText('Marcação 26638').waitFor();
  await pagina.getByRole('button', { name: 'Remarcar' }).click(); await pagina.getByText('Você está remarcando a marcação 26638').waitFor();
  await ateHorarios(pagina); await clicar(pagina, '10:00'); await pagina.getByText('Confira e confirme').waitFor(); await clicar(pagina, 'Confirmar remarcação'); await pagina.getByText('Agendado!').waitFor();
  const r = estado.chamadas.find((x) => x.acao === 'remarcar'); await ctx.close(); return { ok: r && r.voucher === '26638' && r.horario === CHAVE2 };
});

await caso('paciente novo: cadastra, entra sozinho e segue para a confirmação', async () => {
  const { pagina, estado, ctx } = await abrir(); await ateHorarios(pagina); await clicar(pagina, '09:40'); await pagina.waitForSelector('#idCpf'); await clicar(pagina, 'Sou paciente novo');
  await pagina.fill('#cdNome', 'Joana da Silva'); await pagina.selectOption('#cdSexo', 'F'); await pagina.fill('#cdCpf', CPF); await pagina.fill('#cdNasc', NASC); await pagina.fill('#cdCel', '(71) 99999-0000');
  await clicar(pagina, 'Fazer o cadastro'); await pagina.getByText('Confira e confirme').waitFor();
  const c = estado.chamadas.find((x) => x.acao === 'cadastrar'); const ordem = estado.chamadas.map((x) => x.acao).filter((a) => ['cadastrar', 'identificar'].includes(a)).join();
  await ctx.close(); return { ok: c.confirmar === true && c.cpf === CPF_D && c.celular === '71999990000' && c.sexo === 'F' && ordem === 'cadastrar,identificar' };
});

await caso('consultar a clínica: preço pede os campos obrigatórios e mostra o resultado', async () => {
  const { pagina, estado, ctx } = await abrir(); await pagina.getByRole('tab', { name: 'Consultar a clínica' }).click(); await pagina.selectOption('#catSel', 'preco');
  await clicar(pagina, 'Consultar'); const exige = await pagina.getByText('Preencha os campos obrigatórios').isVisible();
  await pagina.fill('#cat_id_procedimento', '1096'); await pagina.fill('#cat_id_plano', '1'); await clicar(pagina, 'Consultar'); await pagina.locator('pre').first().waitFor();
  const c = estado.chamadas.filter((x) => x.acao === 'catalogo' && x.catalogo === 'preco').pop(); const mostra = (await pagina.locator('pre').first().textContent()).includes('250'); await ctx.close();
  return { ok: exige && mostra && c.id_procedimento === '1096' && c.id_plano === '1' };
});

await caso('sobre a API: lista o que fica de fora (dinheiro e dados de outros pacientes)', async () => {
  const { pagina, ctx } = await abrir(); await pagina.getByRole('tab', { name: 'Sobre a API' }).click();
  const fora = await pagina.getByText('Fora de propósito').count(); const dinheiro = await pagina.getByText('/adiantamento(s)').count(); await ctx.close(); return { ok: fora >= 5 && dinheiro === 1, detalhe: `fora=${fora}` };
});

await caso('texto da API com HTML NÃO é interpretado (nenhum script roda)', async () => {
  const { pagina, ctx } = await abrir({ malicioso: true }); await pagina.waitForSelector('#selEsp');
  const txt = await pagina.locator('#selEsp').textContent(); const xss = await pagina.evaluate(() => window.__xss === undefined); const imgs = await pagina.locator('#app img').count(); await ctx.close();
  return { ok: xss && imgs === 0 && txt.includes('<img src=x'), detalhe: `xss=${!xss}` };
});

await caso('privacidade: CPF e nascimento não vão para localStorage, sessionStorage, cookie nem URL; "Sair" limpa a sessão', async () => {
  const { pagina, ctx } = await abrir(); await pagina.getByRole('tab', { name: 'Meus dados' }).click(); await entrar(pagina); await pagina.getByText('Maria Teste').first().waitFor();
  const guardado = await pagina.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie, location.href]));
  const vazou = guardado.includes('11144477735') || guardado.includes('111.444') || guardado.includes('1980-03-25');
  await pagina.getByRole('button', { name: 'Sair' }).first().click(); const pedeDeNovo = await pagina.getByRole('heading', { name: 'Quem é você?' }).isVisible(); await ctx.close(); return { ok: !vazou && pedeDeNovo };
});

await caso('captura de tela no celular (conferência visual; só grava arquivo se CAPTURA_DIR estiver definida)', async () => {
  const { pagina, ctx } = await abrir(); const dir = process.env.CAPTURA_DIR; const foto = async (n, cheia = false) => { if (dir) await pagina.screenshot({ path: `${dir}/${n}.png`, fullPage: cheia }); };
  await pagina.waitForSelector('#selEsp'); await foto('1-o-que'); await ateHorarios(pagina); await foto('2-horarios');
  await clicar(pagina, '09:40'); await pagina.waitForSelector('#idCpf'); await foto('3-voce'); await entrar(pagina); await pagina.getByText('Horário reservado para você').waitFor(); await foto('4-confirmar', true);
  await pagina.getByRole('tab', { name: 'Sobre a API' }).click(); await foto('5-sobre'); await ctx.close(); return { ok: true };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
