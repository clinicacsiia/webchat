// FLUXOGRAMA: entrada (a página nova /agendamento/ servida localmente + a função klingo-agendamento SIMULADA por interceptação de rede, com uma família inventada) -> validação (cada passo do paciente: entrar UMA vez, voltar sem digitar,
//   adicionar filho, marcar um, marcar dois juntos, horário tomado, rastreio que se atualiza sozinho, cancelar com confirmação, resultado só em celular liberado, acessibilidade, privacidade) -> lógica (confere o que a página ENVIA,
//   o que MOSTRA e o que GUARDA no celular) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 13/11/2026 / Mudança: primeira versão. Não fala com o Klingo nem com o Supabase: a função de verdade é testada em testes/familia-funcao.test.mjs. Requer um Chromium (CHROMIUM_PATH ou o do Playwright).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, d = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + String(d).slice(0, 260) : ''}`); };
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

const CPF = '111.444.777-35', CPF_D = '11144477735', TOKEN = 'T'.repeat(43);
const hojeSP = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const somar = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const D1 = somar(hojeSP, 2), D2 = somar(hojeSP, 3);
const chaveSlot = (d, h) => `${d}|63|308|2|${h}`;
const slot = (d, h, medico = 'DRA ANA PEDIATRA') => ({ id: chaveSlot(d, h), data: d, hora: h, medico, unidade: 'DESENVOAR', unidade_sigla: 'PEDIATRIA', ordem_chegada: false, procedimento: '1132' });
const MEDICOS = [
  { chave: 'a', nome: 'DRA ANA PEDIATRA', unidade: 'DESENVOAR', unidade_sigla: 'PEDIATRIA', motivo: 'ja_foi', vezes: 2, procura: 5, total: 4, primeiro: `${D1} 09:00`, proximos: [slot(D1, '09:00'), slot(D1, '09:20'), slot(D1, '09:40'), slot(D2, '10:00')] },
  { chave: 'b', nome: 'DR BRUNO CLINICO', unidade: 'CSI', unidade_sigla: 'CSI', motivo: 'mais_procurado', vezes: 0, procura: 9, total: 1, primeiro: `${D1} 09:30`, proximos: [{ ...slot(D1, '09:30', 'DR BRUNO <img src=x onerror="window.__xss=1">'), unidade: 'CSI' }] },
];

async function abrir({ comCelular = true, perto = false, ocupado = false, nivel = 2, malicioso = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, acceptDownloads: true });
  const E = { espera: [], chamadas: [], pessoas: [{ id: 'p-maria', nome: 'Maria', papel: 'proprio', nivel, plano: 'AMIL', plano_id: 14 }], avisos: [], status: 'agendado', marcou: false, exigeCelular: true, ocupado };
  if (comCelular) await ctx.addInitScript((t) => { try { localStorage.setItem('csi-celular-v1', t); } catch { /* sem armazenamento */ } }, TOKEN);
  await ctx.route('**/functions/v1/klingo-agendamento', async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    if (E.semRede) return r.abort('internetdisconnected');
    const c = JSON.parse(r.request().postData() || '{}'); E.chamadas.push(c);
    const j = (corpo, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(corpo) });
    switch (c.acao) {
      case 'fam_entrar': return c.cpf === CPF_D && c.nascimento === '1980-03-25' ? j({ ok: true, token: TOKEN, pessoas: E.pessoas }) : j({ ok: false, motivo: 'nao_confere', mensagem: 'Não encontramos um cadastro com este CPF e esta data de nascimento.' });
      case 'fam_eu': return c.token === TOKEN ? j({ ok: true, apelido: null, pessoas: E.pessoas, avisos: E.avisos, espera: E.espera }) : j({ ok: false, motivo: 'aparelho_desconhecido' }, 401);
      case 'fam_dependente':
        if (E.exigeCelular && !c.celular) return j({ ok: false, motivo: 'celular_necessario' });
        E.pessoas = [...E.pessoas, { id: 'p-' + c.nome.split(' ')[0].toLowerCase(), nome: c.nome.split(' ')[0], papel: 'responsavel', nivel: 1, plano: 'PARTICULAR', plano_id: 1 }]; E.exigeCelular = false; return j({ ok: true, pessoas: E.pessoas });
      case 'catalogo': return c.catalogo === 'especialidades' ? j({ ok: true, dados: [{ id: 2, cbos: '225124', descr: 'PEDIATRIA' }, { id: 1, cbos: '225112', descr: 'NEUROLOGIA' }] }) : c.catalogo === 'exames' ? j({ ok: true, dados: [{ id: 1724, descr: 'ULTRASSONOGRAFIA DE ABDOME' }] }) : j({ ok: true, dados: [] });
      case 'fam_buscar': {
        const dois = c.pessoas.length > 1, meds = malicioso ? MEDICOS.map((m) => ({ ...m, nome: m.nome.replace('CLINICO', '<img src=x onerror="window.__xss=1">') })) : MEDICOS.map((m) => ({ ...m, proximos: m.proximos.map((s) => ({ ...s, medico: s.medico.replace(/<.*$/, '') })), nome: m.nome.replace(/<.*$/, '') }));
        return j({ ok: true, total: 5, janela: { inicio: hojeSP, fim: somar(hojeSP, 9) }, atualizado_em: new Date().toISOString(), desatualizado: false, primeiro: slot(D1, '09:00'), medicos: meds, pessoas: [],
          combinacoes: dois ? [{ tipo: 'mesmo_medico', data: D1, inicio: '09:00', fim: '09:20', itens: [slot(D1, '09:00'), slot(D1, '09:20')] }, { tipo: 'mesmo_dia', data: D1, inicio: '09:00', fim: '09:30', itens: [slot(D1, '09:00'), { ...slot(D1, '09:30', 'DR BRUNO CLINICO'), unidade: 'CSI' }] }] : [] });
      }
      case 'fam_marcar':
        if (!c.necessidade || !(c.necessidade.especialidade || c.necessidade.exame)) return j({ ok: false, motivo: 'dados_invalidos', campo: 'necessidade' }, 400);
        if (E.ocupado) { E.ocupado = false; return j({ ok: false, motivo: 'horario_ocupado', indice: 0, mensagem: 'Esse horário acabou de ser ocupado. Já separamos outros para você.', alternativas: [slot(D1, '09:20'), slot(D1, '09:40'), slot(D2, '10:00')] }); }
        E.marcou = true; return j({ ok: true, grupo: 'g1', marcacoes: c.itens.map((i, k) => ({ pessoa: i.pessoa, nome: i.pessoa === 'p-maria' ? 'Maria' : i.pessoa === 'p-ana' ? 'Ana' : 'João', voucher: { id: String(26700 + k), data: i.horario.split('|')[0], hora: i.horario.split('|')[4], procedimento: 'CONSULTA', profissional: 'DRA ANA PEDIATRA', unidade: 'DESENVOAR' } })) });
      case 'fam_acompanhar': return j({ ok: true, proxima_leitura_s: 60, espera: E.espera, previsoes: { 'ULTRASSONOGRAFIA': { amostra: 8, mediana_dias: 2.4, p80_dias: 3 } }, marcacoes: [
        { voucher: '26700', pessoa: 'p-ana', nome: 'Ana', grupo: null, procedimento: 'CONSULTA', profissional: 'DRA ANA PEDIATRA', unidade: 'DESENVOAR', data: perto ? hojeSP : D1, hora: '09:00', status: E.status, laudo_pronto_em: null, atualizado_em: new Date().toISOString(), eventos: [{ tipo: 'agendado', em: new Date().toISOString() }, ...(E.status === 'chegou' ? [{ tipo: 'chegou', em: new Date().toISOString() }] : [])] },
        { voucher: '26800', pessoa: 'p-ana', nome: 'Ana', grupo: null, procedimento: 'ULTRASSONOGRAFIA', profissional: 'DRA ROSA', unidade: 'CSI', data: D1, hora: '14:00', status: 'laudo_pronto', laudo_pronto_em: new Date().toISOString(), atualizado_em: new Date().toISOString(), eventos: [{ tipo: 'agendado', em: new Date().toISOString() }, { tipo: 'atendido', em: new Date().toISOString() }, { tipo: 'laudo_pronto', em: new Date().toISOString() }] }] });
      case 'fam_cancelar': return perto ? j({ ok: false, motivo: 'perto_demais', mensagem: 'Falta pouco tempo para o atendimento. Fale com a recepção que a gente resolve junto com você.' }) : j({ ok: true, cancelado: c.voucher });
      case 'fam_laudo': return nivel === 1 ? j({ ok: false, motivo: 'laudo_exige_confianca' }, 403) : j({ ok: true, pronto: true, formato: 'html', resultado: { html: '<p>LAUDO DE TESTE</p><img src=x onerror="parent.__xss2=1">' } });
      case 'fam_convite_usar': return c.codigo === '12345678' ? j({ ok: true, token: TOKEN, ligadas: 1, pessoas: E.pessoas.map((p) => ({ ...p, nivel: 2 })) }) : j({ ok: false, motivo: 'convite_invalido' });
      case 'fam_convidar': return j({ ok: true, codigo: '48291735', expira_em: new Date(Date.now() + 900000).toISOString() });
      case 'fam_espera_entrar': E.entrouNaFila = c; E.espera = [...E.espera, { id: 7, pessoa: c.pessoa, nome: 'Maria', necessidade: c.necessidade.nome, urgencia: c.urgencia, estado: 'esperando', posicao: 2, voucher_atual: c.voucher || null, data_atual: c.voucher ? D2 : null, hora_atual: c.voucher ? '14:00' : null, oferta: null, oferta_ate: null }]; return j({ ok: true, id: 7 });
      case 'fam_espera_responder': E.respondeu = c; E.espera = []; return c.aceita ? j({ ok: true, espera_concluida: true, grupo: 'g9', marcacoes: [{ pessoa: 'p-maria', nome: 'Maria', voucher: { id: '26999', data: D1, hora: '09:30', procedimento: 'CONSULTA', profissional: 'DR BRUNO CLINICO', unidade: 'CSI' } }] }) : j({ ok: true, recusou: true });
      case 'fam_espera_sair': E.saiu = c; E.espera = []; return j({ ok: true, saiu: true });
      case 'fam_desligar': return j({ ok: true, desligado: true });
      default: return j({ ok: false, motivo: 'acao_invalida' }, 400);
    }
  });
  const pagina = await ctx.newPage(); const erros = [];
  pagina.on('pageerror', (e) => erros.push(e.message)); pagina.on('dialog', (d) => d.accept());
  await pagina.goto(`${base}/agendamento/`);
  await pagina.locator('h1').first().waitFor();
  return { ctx, pagina, estado: E, erros };
}
const clicar = (p, nome) => p.getByRole('button', { name: nome, exact: false }).first().click();
const preencherNasc = async (p, d, m, a) => { await p.fill('#nD', d); await p.fill('#nM', m); await p.fill('#nA', a); };
const chamou = (E, acao) => E.chamadas.filter((c) => c.acao === acao);

// ---------------------------------------------------------------- entrar uma vez e voltar sem digitar
await caso('primeira visita: pergunta só CPF e nascimento, com palavras calmas, e não mostra nada técnico', async () => {
  const { pagina, ctx } = await abrir({ comCelular: false });
  const h1 = await pagina.locator('h1').innerText(), corpo = await pagina.locator('main').innerText();
  const tecnico = /Klingo|API|voucher|token|não testado/i.test(await pagina.content().then((c) => c.replace(/<script[\s\S]*?<\/script>|<!--[\s\S]*?-->|<style[\s\S]*?<\/style>/g, '')));
  await ctx.close(); return { ok: /Vamos agendar com calma/.test(h1) && /Seu CPF/.test(corpo) && /Sua data de nascimento/.test(corpo) && !tecnico, detalhe: h1 };
});
await caso('CPF ou data errados: mensagem gentil e NENHUMA chamada ao servidor; CPF certo + nascimento certo entram, o celular guarda só o código', async () => {
  const { pagina, estado, ctx } = await abrir({ comCelular: false });
  await pagina.fill('#cpf', '123.456.789-00'); await preencherNasc(pagina, '25', '03', '1980'); await clicar(pagina, 'Continuar');
  const e1 = await pagina.getByRole('alert').first().innerText(), antes = estado.chamadas.length;
  await pagina.fill('#cpf', CPF); await preencherNasc(pagina, '31', '02', '1980'); await clicar(pagina, 'Continuar');
  const e2 = await pagina.getByRole('alert').first().innerText();
  await preencherNasc(pagina, '25', '03', '1980'); await clicar(pagina, 'Continuar'); await pagina.getByText('Oi, Maria!').waitFor();
  const guardado = await pagina.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie + location.href);
  await ctx.close();
  return { ok: /CPF não parece completo/.test(e1) && /data de nascimento/.test(e2) && antes === 0 && chamou(estado, 'fam_entrar').length === 1 && guardado.includes(TOKEN) && !guardado.includes(CPF_D) && !guardado.includes('1980'), detalhe: [e1, e2].join(' | ') };
});
await caso('o nascimento anda sozinho de caixa em caixa (dia → mês → ano) e o teclado é numérico', async () => {
  const { pagina, ctx } = await abrir({ comCelular: false });
  await pagina.focus('#nD'); await pagina.keyboard.type('250319'); const foco = await pagina.evaluate(() => document.activeElement.id);
  const modo = await pagina.getAttribute('#nD', 'inputmode'); await ctx.close();
  return { ok: foco === 'nA' && modo === 'numeric', detalhe: foco };
});
await caso('segunda visita: o celular já lembra, abre direto em "Oi, Maria!" sem pedir nada e sem chamar o servidor para entrar', async () => {
  const { pagina, estado, ctx } = await abrir();
  await pagina.getByText('Oi, Maria!').waitFor(); const campos = await pagina.locator('main input').count();
  await ctx.close(); return { ok: campos === 0 && chamou(estado, 'fam_entrar').length === 0 && chamou(estado, 'fam_eu').length === 1, detalhe: `${campos} campos` };
});
await caso('celular desconhecido pelo servidor (401): volta para o começo com explicação e esquece o código', async () => {
  const { pagina, ctx } = await abrir({ comCelular: false });
  await pagina.evaluate(() => localStorage.setItem('csi-celular-v1', 'x'.repeat(43))); await pagina.reload(); await pagina.getByText(/precisa ser ligado de novo/).waitFor();
  const guardado = await pagina.evaluate(() => localStorage.getItem('csi-celular-v1')); await ctx.close();
  return { ok: guardado === null, detalhe: String(guardado) };
});

// ---------------------------------------------------------------- filhos e marcar
await caso('adicionar filho: pede o celular só quando falta, volta para a lista e já deixa o filho marcado para ser atendido', async () => {
  const { pagina, estado, ctx } = await abrir();
  await pagina.getByText('Oi, Maria!').waitFor(); await clicar(pagina, 'Adicionar um filho');
  await pagina.fill('#dNome', 'Ana Teste da Silva'); await pagina.getByRole('radio', { name: 'Feminino' }).click(); await pagina.fill('#dnD', '20'); await pagina.fill('#dnM', '05'); await pagina.fill('#dnA', '2019'); await clicar(pagina, 'Salvar e continuar');
  await pagina.getByText(/precisamos do seu celular/).waitFor(); await pagina.fill('#dCel', '71999990001'); await clicar(pagina, 'Salvar e continuar');
  await pagina.getByText('Ana foi adicionada.').waitFor(); const chips = await pagina.locator('.ficha').allInnerTexts();
  const enviado = chamou(estado, 'fam_dependente').pop(); await ctx.close();
  return { ok: chips.includes('Ana') && chips.includes('Maria') && !enviado.cpf && enviado.celular === '71999990001' && enviado.sexo === 'F' && enviado.nascimento === '2019-05-20', detalhe: JSON.stringify(enviado) };
});
await caso('marcar uma consulta: especialidade → primeiro horário livre em destaque → médicos na ordem do servidor com selos → confirmar → tela de pronto com calendário e WhatsApp', async () => {
  const { pagina, estado, ctx } = await abrir();
  await pagina.getByText('Oi, Maria!').waitFor(); await clicar(pagina, 'Marcar uma consulta'); await pagina.getByText('Qual consulta?').waitFor(); await clicar(pagina, 'Pediatria');
  await pagina.getByText('O primeiro horário livre').waitFor();
  const nomes = await pagina.locator('.cartao h3').allInnerTexts(), unidadePergunta = await pagina.getByText(/escolha a unidade|qual unidade/i).count();
  await clicar(pagina, 'Marcar este horário'); await pagina.getByText('Confira e confirme').first().waitFor();
  const resumo = await pagina.locator('main').innerText(); await clicar(pagina, 'Confirmar');
  await pagina.getByText('Agendamento confirmado').waitFor();
  const baixa = pagina.waitForEvent('download'); await clicar(pagina, 'Salvar no calendário'); const dl = await baixa; const ics = readFileSync(await dl.path(), 'utf8');
  const zap = await pagina.getByRole('link', { name: /WhatsApp/ }).getAttribute('href'); const env = chamou(estado, 'fam_marcar')[0]; await ctx.close();
  return { ok: /Dra Ana Pediatra.*Você já foi/s.test(nomes[0]) && /Dr Bruno Clinico.*Mais procurado/s.test(nomes[1]) && unidadePergunta === 0 && /Onde: DESENVOAR/.test(resumo)
    && env.confirmar === true && env.itens.length === 1 && env.itens[0].horario === chaveSlot(D1, '09:00') && env.itens[0].procedimento === '1132'
    && /BEGIN:VEVENT/.test(ics) && /DTSTART:\d{8}T090000/.test(ics) && /SUMMARY:Pediatria/.test(ics) && /TRIGGER:-PT2H/.test(ics) && /^https:\/\/wa\.me\/\?text=/.test(zap) && decodeURIComponent(zap).includes('Chegue 15 minutos antes'), detalhe: nomes.join(' | ') };
});
await caso('com dois filhos o celular mostra só combinações para ir juntos (nenhum horário solto) e manda os dois em UMA chamada', async () => {
  const { pagina, estado, ctx } = await abrir(); estado.pessoas.push({ id: 'p-ana', nome: 'Ana', papel: 'responsavel', nivel: 1, plano: 'AMIL', plano_id: 14 }, { id: 'p-joao', nome: 'João', papel: 'responsavel', nivel: 1, plano: 'AMIL', plano_id: 14 });
  await pagina.reload(); await pagina.getByText('Oi, Maria!').waitFor(); await clicar(pagina, 'Marcar uma consulta'); await pagina.getByText('Quem vai ser atendido?').waitFor();
  await pagina.getByRole('checkbox', { name: /Ana/ }).click(); await pagina.getByRole('checkbox', { name: /João/ }).click(); await clicar(pagina, 'Continuar'); await clicar(pagina, 'Pediatria');
  await pagina.getByText('Melhor opção').waitFor(); const corpo = await pagina.locator('main').innerText(), horasSoltas = await pagina.locator('.hora').count();
  await clicar(pagina, 'Marcar estes horários'); await pagina.getByText('Confira e confirme').first().waitFor(); await clicar(pagina, 'Confirmar todos'); await pagina.getByText('Tudo marcado!').waitFor();
  const env = chamou(estado, 'fam_marcar'); await ctx.close();
  return { ok: /Ana: 9h/.test(corpo) && /João: 9h20/.test(corpo) && horasSoltas === 0 && env.length === 1 && env[0].itens.length === 2 && env[0].itens[0].pessoa === 'p-ana' && env[0].itens[1].pessoa === 'p-joao', detalhe: corpo.replace(/\n+/g, ' / ').slice(0, 200) };
});
// ---------------------------------------------------------------- rastreio, cancelar, resultado
await caso('rastreio: passo a passo com o passo atual marcado, frases calmas, previsão que aprendeu e atualização sozinha a cada minuto', async () => {
  const { pagina, estado, ctx } = await abrir(); await pagina.clock.install(); await pagina.reload(); await pagina.getByText('Oi, Maria!').waitFor();
  await clicar(pagina, 'Acompanhar minhas marcações'); await pagina.getByText('Atualizando sozinho a cada minuto').waitFor();
  const atual = await pagina.locator('ol.trilha li[aria-current="step"]').first().innerText(), frase = await pagina.getByText(/O seu horário está reservado/).count(), antes = chamou(estado, 'fam_acompanhar').length;
  estado.status = 'chegou'; await pagina.clock.fastForward(61000); await pagina.getByText(/Você já chegou/).waitFor(); const depois = chamou(estado, 'fam_acompanhar').length;
  await ctx.close(); return { ok: /Marcado/.test(atual) && frase === 1 && depois > antes, detalhe: `${antes}→${depois}; atual=${atual.replace(/\n/g, ' ')}` };
});
await caso('cancelar: pergunta antes ("Não, manter" vem primeiro), cancela com a regra gentil e, perto da hora, manda falar com a recepção em vez de bloquear seco', async () => {
  const { pagina, estado, ctx } = await abrir({ perto: true }); await pagina.getByText('Oi, Maria!').waitFor(); await clicar(pagina, 'Acompanhar minhas marcações'); await pagina.getByText('Atualizando sozinho').waitFor();
  await pagina.getByRole('button', { name: 'Não vou poder ir' }).first().click(); const pergunta = await pagina.getByText('Quer mesmo cancelar?').count(); const ordem = await pagina.locator('button:visible').allInnerTexts();
  await pagina.getByRole('button', { name: 'Sim, cancelar' }).click(); await pagina.getByText(/Falta pouco tempo/).waitFor(); const link = await pagina.getByRole('link', { name: 'Falar com a recepção' }).count();
  await ctx.close(); return { ok: pergunta === 1 && ordem.indexOf('Não, manter') >= 0 && ordem.indexOf('Não, manter') < ordem.indexOf('Sim, cancelar') && link === 1 && chamou(estado, 'fam_cancelar').length === 1, detalhe: ordem.join(' | ') };
});
await caso('resultado em celular liberado (nível 2): abre dentro da página, em moldura isolada onde nenhum script roda', async () => {
  const { pagina, ctx } = await abrir({ nivel: 2 }); await pagina.getByText('Oi, Maria!').waitFor(); await clicar(pagina, 'Acompanhar minhas marcações'); await pagina.getByText('Atualizando sozinho').waitFor();
  await clicar(pagina, 'Ver o resultado'); await pagina.locator('iframe.laudo').waitFor(); const sandbox = await pagina.getAttribute('iframe.laudo', 'sandbox'); const xss = await pagina.evaluate(() => window.__xss2 || null);
  await ctx.close(); return { ok: sandbox === '' && xss === null, detalhe: `sandbox="${sandbox}" xss=${xss}` };
});
await caso('resultado em celular de nível 1: explica sem assustar e oferece o código de convite e "eu sei todos os dados" (nada de laudo)', async () => {
  const { pagina, ctx } = await abrir({ nivel: 1 }); await pagina.getByText('Oi, Maria!').waitFor(); await clicar(pagina, 'Acompanhar minhas marcações'); await pagina.getByText('Atualizando sozinho').waitFor();
  await clicar(pagina, 'Ver o resultado'); await pagina.getByText('Liberar este celular').waitFor(); const corpo = await pagina.locator('main').innerText(); const iframes = await pagina.locator('iframe').count();
  await pagina.fill('#cod2', '1234 5678'); await clicar(pagina, 'Usar o código'); await pagina.getByText('Liberado!').waitFor(); await ctx.close();
  return { ok: /Alguém da família já acompanha/.test(corpo) && /Eu sei todos os dados/.test(corpo) && iframes === 0, detalhe: corpo.slice(0, 120).replace(/\n/g, ' ') };
});
await caso('dar acesso a outra pessoa: mostra um código de 8 números grande, diz que vale 15 minutos e oferece mandar por WhatsApp', async () => {
  const { pagina, ctx } = await abrir({ nivel: 2 }); await pagina.getByText('Oi, Maria!').waitFor(); await clicar(pagina, 'Dar acesso a outra pessoa'); await clicar(pagina, 'Gerar o código'); await pagina.locator('.codigo').waitFor();
  const cod = await pagina.locator('.codigo').innerText(), texto = await pagina.locator('main').innerText(); const zap = await pagina.getByRole('link', { name: /WhatsApp/ }).getAttribute('href'); await ctx.close();
  return { ok: cod === '4829 1735' && /15 minutos|14 minutos/.test(texto) && decodeURIComponent(zap).includes('4829 1735'), detalhe: cod };
});


// ---------------------------------------------------------------- certeza do horário e pressa
await caso('horário tomado na hora de confirmar: avisa com carinho, mostra NA HORA 3 horários livres para tocar (sem recomeçar) e a marcação sempre leva o que a pessoa precisa (necessidade)', async () => {
  const { pagina, estado, ctx } = await abrir({ ocupado: true });
  await pagina.getByText('Oi, Maria!').waitFor(); await clicar(pagina, 'Marcar uma consulta'); await clicar(pagina, 'Pediatria'); await pagina.getByText('O primeiro horário livre').waitFor(); await clicar(pagina, 'Marcar este horário'); await clicar(pagina, 'Confirmar');
  await pagina.getByText('Estes estão livres agora').waitFor(); const alvo = pagina.locator('.cartao.destaque', { hasText: 'Estes estão livres agora' }), cartoes = await alvo.locator('button').allInnerTexts();
  await alvo.locator('button').first().click(); await pagina.getByText('Confira e confirme').first().waitFor(); const resumo = await pagina.locator('main').innerText();
  await clicar(pagina, 'Confirmar'); await pagina.getByText('Agendamento confirmado').waitFor(); const envios = chamou(estado, 'fam_marcar'); await ctx.close();
  return { ok: cartoes.length === 3 && /9h20/.test(cartoes[0]) && /9h20/.test(resumo) && envios.length === 2 && envios.every((e) => e.necessidade.especialidade === '225124' && e.necessidade.nome === 'Pediatria') && envios[1].itens[0].horario === chaveSlot(D1, '09:20'), detalhe: cartoes.join(' | ') };
});
await caso('PRESSA: na tela de horários a pessoa entra na fila de espera ("hoje", "esta semana" ou "mais cedo"), com a promessa clara de 15 minutos de reserva', async () => {
  const { pagina, estado, ctx } = await abrir(); await pagina.getByText('Oi, Maria!').waitFor(); await clicar(pagina, 'Marcar uma consulta'); await clicar(pagina, 'Pediatria'); await pagina.getByText('O primeiro horário livre').waitFor();
  await pagina.getByText(/Com pressa/).waitFor(); await clicar(pagina, 'Quero hoje, se abrir uma vaga'); await pagina.getByText(/entrou na fila de espera \(hoje\)/).waitFor();
  const msg = await pagina.getByText(/entrou na fila de espera/).innerText(), env = estado.entrouNaFila; await ctx.close();
  return { ok: /15 minutos/.test(msg) && env.urgencia === 'hoje' && env.pessoa === 'p-maria' && env.necessidade.especialidade === '225124' && !env.voucher, detalhe: msg };
});
await caso('PRESSA: depois de marcar, a pessoa pode pedir para ADIANTAR (a fila recebe o número da marcação atual e a mensagem garante que o horário de agora continua dela)', async () => {
  const { pagina, estado, ctx } = await abrir(); await pagina.getByText('Oi, Maria!').waitFor(); await clicar(pagina, 'Marcar uma consulta'); await clicar(pagina, 'Pediatria'); await pagina.getByText('O primeiro horário livre').waitFor(); await clicar(pagina, 'Marcar este horário'); await clicar(pagina, 'Confirmar');
  await pagina.getByText('Agendamento confirmado').waitFor(); await pagina.getByText('Quer um horário mais cedo?').waitFor(); await clicar(pagina, 'Me chame se abrir um horário mais cedo'); await pagina.getByText(/continua garantido/).waitFor(); const env = estado.entrouNaFila; await ctx.close();
  return { ok: env.urgencia === 'qualquer' && env.voucher === '26700', detalhe: JSON.stringify(env) };
});
await caso('OFERTA: quando abre um horário, aparece no início com o prazo; "Quero este horário" marca na hora e leva à confirmação; "Não quero" mantém a pessoa na fila', async () => {
  const oferta = { id: 7, pessoa: 'p-maria', nome: 'Maria', necessidade: 'Pediatria', urgencia: 'semana', estado: 'oferecido', posicao: 1, voucher_atual: '26000', data_atual: D2, hora_atual: '14:00', oferta: { chave: chaveSlot(D1, '09:30'), data: D1, hora: '09:30', medico: 'DR BRUNO CLINICO', unidade: 'CSI', procedimento: '1132' }, oferta_ate: new Date(Date.now() + 14 * 60000).toISOString() };
  let x = await abrir(); x.estado.espera = [oferta]; await x.pagina.reload(); await x.pagina.getByText('Abriu um horário para Maria!').waitFor();
  const texto = await x.pagina.locator('.aviso.atencao').first().innerText(); await clicar(x.pagina, 'Quero este horário'); await x.pagina.getByText('Agendamento confirmado').waitFor(); const aceitou = x.estado.respondeu; await x.ctx.close();
  x = await abrir(); x.estado.espera = [oferta]; await x.pagina.reload(); await x.pagina.getByText('Abriu um horário para Maria!').waitFor(); await clicar(x.pagina, 'Não quero'); await x.pagina.getByText(/continua na fila/).waitFor(); const recusou = x.estado.respondeu; await x.ctx.close();
  return { ok: /9h30/.test(texto) && /14 minutos|15 minutos/.test(texto) && /trocamos o horário/.test(texto) && aceitou.aceita === true && aceitou.id === 7 && recusou.aceita === false, detalhe: texto.replace(/\n/g, ' ').slice(0, 160) };
});
await caso('FILA no acompanhamento: mostra a posição, garante o horário atual e deixa sair da fila', async () => {
  const { pagina, estado, ctx } = await abrir(); estado.espera = [{ id: 8, pessoa: 'p-maria', nome: 'Maria', necessidade: 'Pediatria', urgencia: 'hoje', estado: 'esperando', posicao: 3, voucher_atual: '26000', data_atual: D2, hora_atual: '14:00', oferta: null, oferta_ate: null }];
  await pagina.reload(); await pagina.getByText('Oi, Maria!').waitFor(); await clicar(pagina, 'Acompanhar minhas marcações'); await pagina.getByText(/fila de espera/).first().waitFor(); const texto = await pagina.locator('main').innerText();
  await clicar(pagina, 'Sair da fila'); await pagina.waitForFunction(() => !/Você é o 3º da fila/.test(document.querySelector('main').innerText)); const saiu = estado.saiu; await ctx.close();
  return { ok: /3º da fila/.test(texto) && /continua garantido/.test(texto) && /hoje/.test(texto) && saiu.id === 8, detalhe: texto.slice(0, 80).replace(/\n/g, ' ') };
});

// ---------------------------------------------------------------- acessibilidade, aparência e segurança
await caso('letra grande e alto contraste: mudam na hora e ficam lembrados na próxima visita', async () => {
  const { pagina, ctx } = await abrir(); await pagina.getByText('Oi, Maria!').waitFor(); await pagina.locator('details.aparencia summary').click();
  await pagina.getByLabel('Bem grande').check(); await pagina.getByLabel('Alto contraste').check();
  const agora = await pagina.evaluate(() => [document.documentElement.dataset.fonte, document.documentElement.dataset.tema, getComputedStyle(document.body).backgroundColor, getComputedStyle(document.documentElement).fontSize]);
  await pagina.reload(); await pagina.getByText('Oi, Maria!').waitFor(); const depois = await pagina.evaluate(() => [document.documentElement.dataset.fonte, document.documentElement.dataset.tema]); await ctx.close();
  return { ok: agora[0] === '3' && agora[1] === 'contraste' && agora[2] === 'rgb(0, 0, 0)' && agora[3] === '24px' && depois.join() === '3,contraste', detalhe: agora.join(' ') };
});
await caso('acessibilidade básica: cada tela tem um título que recebe o foco, campos têm rótulo, botões têm 48 px ou mais, imagens têm texto alternativo e há link para pular ao conteúdo', async () => {
  const { pagina, ctx } = await abrir({ comCelular: false });
  const foco = await pagina.evaluate(() => document.activeElement && document.activeElement.tagName);
  await pagina.getByRole('button', { name: /Recebi um código/ }).click(); await pagina.getByText('Entrar com um código').waitFor(); const focoH1 = await pagina.evaluate(() => document.activeElement.tagName);
  await pagina.getByRole('button', { name: 'Voltar' }).click(); await pagina.locator('h1').waitFor();
  const r = await pagina.evaluate(() => {
    const semRotulo = [...document.querySelectorAll('input')].filter((i) => !(i.labels && i.labels.length) && !i.getAttribute('aria-label')).length;
    const baixos = [...document.querySelectorAll('button.btn, a.btn')].filter((b) => b.getBoundingClientRect().height < 47).map((b) => b.textContent);
    const semAlt = [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length; const pular = !!document.querySelector('a.pular[href="#app"]');
    return { semRotulo, baixos, semAlt, pular, lang: document.documentElement.lang };
  }); await ctx.close();
  return { ok: focoH1 === 'H1' && r.semRotulo === 0 && r.baixos.length === 0 && r.semAlt === 0 && r.pular && r.lang === 'pt-BR', detalhe: JSON.stringify({ focoH1, ...r }) };
});
await caso('texto vindo do servidor nunca vira HTML: nome de médico com <img onerror> aparece como texto e nada executa', async () => {
  const { pagina, ctx } = await abrir({ malicioso: true }); await pagina.getByText('Oi, Maria!').waitFor(); await clicar(pagina, 'Marcar uma consulta'); await clicar(pagina, 'Pediatria'); await pagina.getByText('O primeiro horário livre').waitFor();
  const xss = await pagina.evaluate(() => window.__xss || null), imgs = await pagina.locator('main img').count(), texto = await pagina.locator('main').innerText(); await ctx.close();
  return { ok: xss === null && imgs === 0 && /<img src=x/i.test(texto), detalhe: `xss=${xss}` };
});
await caso('sem internet: mensagem tranquila, sem tela quebrada e sem erro de script', async () => {
  const { pagina, ctx, erros, estado } = await abrir({ comCelular: false }); estado.semRede = true;
  await pagina.fill('#cpf', CPF); await preencherNasc(pagina, '25', '03', '1980'); await clicar(pagina, 'Continuar'); await pagina.getByText(/internet falhou/).waitFor(); const botoes = await pagina.getByRole('button', { name: 'Continuar' }).isEnabled(); await ctx.close();
  return { ok: botoes && erros.length === 0, detalhe: erros.join(' | ') };
});
await caso('desligar este celular: pede confirmação, esquece o código e volta ao começo', async () => {
  const { pagina, estado, ctx } = await abrir(); await pagina.getByText('Oi, Maria!').waitFor(); await clicar(pagina, 'Desligar este celular'); await pagina.getByText(/Celular desligado/).waitFor();
  const guardado = await pagina.evaluate(() => localStorage.getItem('csi-celular-v1')); await ctx.close(); return { ok: guardado === null && chamou(estado, 'fam_desligar').length === 1, detalhe: String(guardado) };
});
await caso('captura de tela no celular (conferência visual; só grava arquivo se CAPTURA_DIR estiver definida)', async () => {
  const { pagina, ctx } = await abrir({ comCelular: false }); if (process.env.CAPTURA_DIR) { await pagina.screenshot({ path: `${process.env.CAPTURA_DIR}/agendamento-entrada.png`, fullPage: true }); }
  await ctx.close(); return { ok: true };
});

await browser.close(); srv.close();
const f = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - f}/${resultados.length} verificações passaram`);
process.exit(f ? 1 : 0);
