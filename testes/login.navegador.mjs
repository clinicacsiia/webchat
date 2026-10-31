// FLUXOGRAMA: entrada (chat do paciente + Supabase simulado, com os endpoints de login) -> validação (interruptor do banco ligado/desligado; senha fraca e aceite ausente nem chegam à rede) -> lógica (criar conta, entrar, esqueci a senha, link de nova senha, sair; conta logada pré-preenche e começa a conversa sem redigitar; conta sem perfil salva nome e telefone; sessão que não é de paciente segue como convidado) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
//
// Requer um Chromium (CHROMIUM_PATH). Não fala com o Supabase real: prova o comportamento da tela, não o do banco (esse está em sql-login.test.mjs).
import { chromium, servidor, criarMundo, novaPaginaChat } from './mock-chat.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
async function caso(nome, fn) { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } }
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

// ---- um "Supabase Auth" de mentira ----
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const jwt = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER_ID, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.assinatura`;
const TOKEN = jwt();
const usuario = (email = 'ana@teste.local', meta = {}) => ({ id: USER_ID, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: '2026-10-31T10:00:00Z', app_metadata: { provider: 'email' }, user_metadata: meta, identities: [{ id: USER_ID }], created_at: '2026-10-31T10:00:00Z' });
const sessao = (email, meta) => ({ access_token: TOKEN, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'refresh-de-teste', user: usuario(email, meta) });

function criarAuth({ senhaCerta = 'Senha1234', email = 'ana@teste.local', meta = {}, confirmarEmail = true } = {}) {
  const a = { chamadas: [], email, meta };
  a.tratar = async ({ metodo, caminho, busca, corpo, cabecalhos }) => {
    a.chamadas.push({ metodo, caminho, busca: Object.fromEntries(busca), corpo, cabecalhos });
    if (caminho === '/auth/v1/token' && busca.get('grant_type') === 'password') {
      if (corpo.password !== senhaCerta) return { status: 400, body: { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials', message: 'Invalid login credentials' } };
      return { body: sessao(corpo.email, a.meta) };
    }
    if (caminho === '/auth/v1/signup') return confirmarEmail ? { body: { ...usuario(corpo.email, corpo.data), email_confirmed_at: null } } : { body: sessao(corpo.email, corpo.data) };
    if (caminho === '/auth/v1/recover') return { body: {} };
    if (caminho === '/auth/v1/user') return { body: usuario(a.email, a.meta) };
    if (caminho === '/auth/v1/logout') return { status: 204 };
    return { status: 404, body: { message: 'não simulado: ' + caminho } };
  };
  return a;
}
const conta = (extra = {}) => ({ conta: true, email: 'ana@teste.local', nome: 'Ana Souza', telefone: '71999998888', cadastro_salvo: false, aceitou_lgpd: true, ...extra });

async function abrir({ ativo = true, contaDoBanco = null, auth = criarAuth(), sessaoGuardada = false, hash = '', vinculo = null, mundoExtra = {} } = {}) {
  const mundo = criarMundo({ loginAtivo: ativo, conta: contaDoBanco, vinculo, ...mundoExtra });
  const init = sessaoGuardada ? [[(s) => localStorage.setItem('csi-paciente-auth', s), JSON.stringify(sessao('ana@teste.local', auth.meta || {}))]] : [];
  const p = await novaPaginaChat(browser, mundo, { init, auth: auth.tratar });
  await p.page.goto(`${base}/index.html${hash}`);
  await p.page.waitForSelector('#formInicio', { state: 'visible', timeout: 8000 });
  await espera(500);   // a conta chega depois do formulário
  return { ...p, mundo, auth };
}
const visivel = (page, sel) => page.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none').catch(() => false);
const texto = (page, sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => null);
const chamou = (mundo, nome) => mundo.chamadas.filter((c) => c.nome === nome);

// ---------------------------------------------------------------------------------------------------------------------------------
await caso('interruptor DESLIGADO (padrão): a tela de login não aparece e nada é chamado em /auth', async () => {
  const x = await abrir({ ativo: false });
  const r = { faixa: await visivel(x.page, '#faixaConta'), nAuth: x.auth.chamadas.length, resumo: chamou(x.mundo, 'conta_paciente_resumo').length };
  await x.ctx.close();
  return { ok: !r.faixa && r.nAuth === 0 && r.resumo === 0, detalhe: JSON.stringify(r) };
});

await caso('interruptor desligado COM sessão guardada: a sessão local é descartada (a conversa não pode ficar ligada a uma conta escondida)', async () => {
  const x = await abrir({ ativo: false, sessaoGuardada: true });
  const guardada = await x.page.evaluate(() => localStorage.getItem('csi-paciente-auth'));
  await x.ctx.close();
  return { ok: !guardada, detalhe: guardada ? 'sessão continuou guardada' : 'sessão removida' };
});

await caso('interruptor LIGADO: aparece "Tem conta?" com Entrar e Criar conta; o formulário segue igual para o convidado', async () => {
  const x = await abrir();
  const r = { faixa: await visivel(x.page, '#faixaConta'), entrar: await visivel(x.page, '#btnContaEntrar'), criar: await visivel(x.page, '#btnContaCriar'), sair: await visivel(x.page, '#btnContaSair'), nome: await visivel(x.page, '#blocoNome'), titulo: await texto(x.page, '#tituloInicio') };
  await x.ctx.close();
  return { ok: r.faixa && r.entrar && r.criar && !r.sair && r.nome && r.titulo === 'Vamos agendar?', detalhe: JSON.stringify(r) };
});

await caso('Criar conta: senha fraca, nome curto e falta do aceite são barrados na tela, SEM chamar a rede', async () => {
  const x = await abrir();
  await x.page.click('#btnContaCriar'); await x.page.waitForSelector('#cNome');
  const tentar = async () => { await x.page.click('.conta-form button[type=submit]'); await espera(150); return texto(x.page, '.conta-form .erro-form'); };
  const e1 = await tentar();
  await x.page.fill('#cNome', 'Ana Souza'); await x.page.fill('#cTel', '71999998888'); await x.page.fill('#cNasc', '25/03/1980'); await x.page.fill('#cEmail', 'ana@teste.local');
  await x.page.fill('#cNasc', ''); const e1b = await tentar();
  await x.page.fill('#cNasc', '31/02/1980'); const e1c = await tentar();
  await x.page.fill('#cNasc', '25/03/2999'); const e1d = await tentar();
  await x.page.fill('#cNasc', '25/03/1980');
  await x.page.fill('#cSenha', 'curta1'); const e2 = await tentar();
  await x.page.fill('#cSenha', 'somenteletras'); const e3 = await tentar();
  await x.page.fill('#cSenha', 'Senha1234'); const e4 = await tentar();
  const r = { e1, e1b, e1c, e1d, e2, e3, e4, chamadasAuth: x.auth.chamadas.length };
  await x.ctx.close();
  return { ok: /nome/i.test(e1) && /nascimento/i.test(e1b) && /nascimento/i.test(e1c) && /nascimento/i.test(e1d) && /8 caracteres/.test(e2) && /8 caracteres/.test(e3) && /concord/i.test(e4) && r.chamadasAuth === 0, detalhe: JSON.stringify(r) };
});

await caso('Criar conta: envia e-mail, nome e telefone (só números) e o endereço de volta; mostra "Enquanto não confirmar, nada de login"', async () => {
  const x = await abrir();
  await x.page.click('#btnContaCriar'); await x.page.waitForSelector('#cNome');
  await x.page.fill('#cNome', 'Ana Souza'); await x.page.fill('#cTel', '71999998888'); await x.page.fill('#cNasc', '25/03/1980'); await x.page.fill('#cEmail', 'ana@teste.local'); await x.page.fill('#cSenha', 'Senha1234');
  await x.page.check('#cAceite'); await x.page.click('.conta-form button[type=submit]');
  await x.page.waitForSelector('.conta-ok', { timeout: 5000 });
  const msg = await texto(x.page, '.conta-ok'); const s = x.auth.chamadas.find((c) => c.caminho === '/auth/v1/signup');
  const logado = await visivel(x.page, '#btnContaSair');
  await x.ctx.close();
  return { ok: !!s && s.corpo.email === 'ana@teste.local' && s.corpo.data.nome === 'Ana Souza' && s.corpo.data.telefone === '71999998888' && s.corpo.data.dt_nasc === '1980-03-25' && /\/index\.html$|\/$/.test(s.busca.redirect_to || '') && /ana@teste\.local/.test(msg) && !logado,
           detalhe: `redirect_to=${s?.busca.redirect_to}; logado=${logado}` };
});

await caso('Entrar com senha errada: mensagem clara e continua como convidado', async () => {
  const x = await abrir();
  await x.page.click('#btnContaEntrar'); await x.page.waitForSelector('#cEmail');
  await x.page.fill('#cEmail', 'ana@teste.local'); await x.page.fill('#cSenha', 'errada123'); await x.page.click('.conta-form button[type=submit]');
  await x.page.waitForFunction(() => /incorretos/.test(document.querySelector('.conta-form .erro-form')?.textContent || ''), null, { timeout: 5000 });
  const sair = await visivel(x.page, '#btnContaSair');
  await x.ctx.close();
  return { ok: !sair };
});

await caso('Entrar certo: mostra "Conta: e-mail", "Olá de novo, Ana!" com os dados da conta, sem "Não sou eu"; o telefone vem formatado', async () => {
  const x = await abrir({ contaDoBanco: conta() });
  await x.page.click('#btnContaEntrar'); await x.page.waitForSelector('#cEmail');
  await x.page.fill('#cEmail', 'ana@teste.local'); await x.page.fill('#cSenha', 'Senha1234'); await x.page.click('.conta-form button[type=submit]');
  await x.page.waitForFunction(() => /Olá de novo, Ana/.test(document.querySelector('#tituloInicio')?.textContent || ''), null, { timeout: 5000 });
  const r = { faixa: await texto(x.page, '#faixaContaTxt'), dados: await texto(x.page, '#voltaDados'), naoSouEu: await visivel(x.page, '#btnNaoSouEu'), sair: await visivel(x.page, '#btnContaSair'), menu: await texto(x.page, '#btnSair') };
  await x.ctx.close();
  return { ok: r.faixa === 'Conta: ana@teste.local' && /Ana Souza · \(71\) 99999-8888 · ana@teste\.local/.test(r.dados) && !r.naoSouEu && r.sair && r.menu === 'Sair da conta', detalhe: JSON.stringify(r) };
});

await caso('Conta logada começa a conversa SEM redigitar nada e as chamadas seguem com o token da conta', async () => {
  const x = await abrir({ contaDoBanco: conta(), sessaoGuardada: true });
  await x.page.waitForFunction(() => /Olá de novo/.test(document.querySelector('#tituloInicio')?.textContent || ''), null, { timeout: 5000 });
  await x.page.click('#fQuem .unidade >> nth=0'); await x.page.click('#btnIniciar');
  await x.page.waitForSelector('#msgs .msg.agente .op', { timeout: 8000 });
  const ini = chamou(x.mundo, 'chat_iniciar')[0];
  await x.ctx.close();
  return { ok: ini && ini.corpo.p_nome === 'Ana Souza' && ini.corpo.p_telefone === '(71) 99999-8888' && ini.corpo.p_email === 'ana@teste.local' && ini.corpo.p_paciente_tipo === 'proprio' && ini.autorizacao === `Bearer ${TOKEN}`,
           detalhe: ini ? `${ini.corpo.p_nome} / ${ini.corpo.p_telefone}; autorização=${ini.autorizacao === `Bearer ${TOKEN}`}` : 'chat_iniciar não foi chamado' };
});

await caso('Conta SEM perfil salvo: e-mail travado no da conta; depois de começar, nome e telefone digitados são guardados na conta (cadastro uma vez só)', async () => {
  const x = await abrir({ contaDoBanco: conta({ nome: null, telefone: null }), sessaoGuardada: true });
  await x.page.waitForFunction(() => document.querySelector('#fEmail')?.readOnly === true, null, { timeout: 5000 });
  const email = await x.page.inputValue('#fEmail');
  await x.page.click('#fQuem .unidade >> nth=0'); await x.page.fill('#fNome', 'Ana Souza'); await x.page.fill('#fTel', '71999998888'); await x.page.check('#fAceite'); await x.page.click('#btnIniciar');
  await x.page.waitForSelector('#msgs .msg.agente .op', { timeout: 8000 }); await espera(300);
  const perfil = chamou(x.mundo, 'conta_paciente_perfil');
  await x.ctx.close();
  return { ok: email === 'ana@teste.local' && perfil.length >= 1 && perfil.at(-1).corpo.p_nome === 'Ana Souza' && /71999998888/.test(String(perfil.at(-1).corpo.p_telefone).replace(/\D/g, '')), detalhe: `e-mail=${email}; chamadas de perfil=${perfil.length}` };
});

await caso('Sessão que NÃO é de paciente (ex.: equipe): segue como convidado, sem mostrar o e-mail dela', async () => {
  const x = await abrir({ contaDoBanco: null, sessaoGuardada: true });   // conta_paciente_resumo devolve {conta:false}
  const r = { sair: await visivel(x.page, '#btnContaSair'), entrar: await visivel(x.page, '#btnContaEntrar'), faixa: await texto(x.page, '#faixaContaTxt') };
  await x.ctx.close();
  return { ok: !r.sair && r.entrar && !/ana@/.test(r.faixa), detalhe: JSON.stringify(r) };
});

await caso('Sair da conta: faz logout, limpa os dados do aparelho e volta ao formulário de convidado', async () => {
  const x = await abrir({ contaDoBanco: conta(), sessaoGuardada: true });
  await x.page.waitForFunction(() => /Olá de novo/.test(document.querySelector('#tituloInicio')?.textContent || ''), null, { timeout: 5000 });
  x.page.once('dialog', (d) => d.accept());
  await x.page.click('#btnContaSair'); await espera(600);
  const r = { titulo: await texto(x.page, '#tituloInicio'), entrar: await visivel(x.page, '#btnContaEntrar'), logout: x.auth.chamadas.some((c) => c.caminho === '/auth/v1/logout'), sessao: await x.page.evaluate(() => localStorage.getItem('csi-paciente-auth')) };
  await x.ctx.close();
  return { ok: r.titulo === 'Vamos agendar?' && r.entrar && r.logout && !r.sessao, detalhe: JSON.stringify({ ...r, sessao: !!r.sessao }) };
});

await caso('Esqueci a senha: pede o e-mail, envia o pedido com o endereço de volta e responde sem revelar se a conta existe', async () => {
  const x = await abrir();
  await x.page.click('#btnContaEntrar'); await x.page.waitForSelector('#cEmail'); await x.page.click('text=Esqueci a senha'); await x.page.waitForSelector('#cEmail');
  await x.page.fill('#cEmail', 'alguem@teste.local'); await x.page.click('.conta-form button[type=submit]');
  await x.page.waitForSelector('.conta-ok', { timeout: 5000 });
  const msg = await texto(x.page, '.conta-ok'); const c = x.auth.chamadas.find((y) => y.caminho === '/auth/v1/recover');
  await x.ctx.close();
  return { ok: !!c && c.corpo.email === 'alguem@teste.local' && /redirect_to/.test(JSON.stringify(c.busca)) && /Se existir uma conta/.test(msg), detalhe: msg.slice(0, 60) };
});

await caso('Link do e-mail (nova senha): abre a janela "Escolha uma nova senha"; senha fraca é barrada; a boa é enviada ao Supabase', async () => {
  const hash = `#access_token=${TOKEN}&expires_in=3600&refresh_token=refresh-de-teste&token_type=bearer&type=recovery`;
  const x = await abrir({ contaDoBanco: conta(), hash });
  await x.page.waitForSelector('#folhaTitulo:text("Escolha uma nova senha")', { timeout: 6000 });
  await x.page.fill('#cSenha', 'fraca'); await x.page.click('.conta-form button[type=submit]'); await espera(200);
  const e1 = await texto(x.page, '.conta-form .erro-form');
  await x.page.fill('#cSenha', 'NovaSenha99'); await x.page.click('.conta-form button[type=submit]');
  await x.page.waitForFunction(() => document.querySelector('#folha').hidden, null, { timeout: 5000 });
  const put = x.auth.chamadas.find((c) => c.metodo === 'PUT' && c.caminho === '/auth/v1/user');
  await x.ctx.close();
  return { ok: /8 caracteres/.test(e1) && !!put && put.corpo.password === 'NovaSenha99', detalhe: `fraca=${e1.slice(0, 30)}; PUT=${!!put}` };
});

await caso('Link de nova senha com o interruptor desligado: nada abre', async () => {
  const hash = `#access_token=${TOKEN}&expires_in=3600&refresh_token=refresh-de-teste&token_type=bearer&type=recovery`;
  const x = await abrir({ ativo: false, hash });
  const aberta = await x.page.evaluate(() => !document.querySelector('#folha').hidden);
  await x.ctx.close();
  return { ok: !aberta };
});

// ---- Meus dados (cópia e exclusão da conta) ----
const baixar = async (x, seletor) => { const [dl] = await Promise.all([x.page.waitForEvent('download', { timeout: 5000 }), x.page.click(seletor)]); const stream = await dl.createReadStream(); let t = ''; for await (const c of stream) t += c; return { nome: dl.suggestedFilename(), texto: t }; };
const abrirDados = async (x) => { await x.page.click('#btnContaDados'); await x.page.waitForSelector('#btnBaixarTxt'); };

await caso('Meus dados: o botão só aparece para quem tem conta (e não existe com o interruptor desligado)', async () => {
  const sem = await abrir({ contaDoBanco: null }), com = await abrir({ contaDoBanco: conta(), sessaoGuardada: true }), off = await abrir({ ativo: false });
  const r = { sem: await visivel(sem.page, '#btnContaDados'), com: await visivel(com.page, '#btnContaDados'), off: await visivel(off.page, '#btnContaDados') };
  await sem.ctx.close(); await com.ctx.close(); await off.ctx.close();
  return { ok: !r.sem && r.com && !r.off, detalhe: JSON.stringify(r) };
});

await caso('Meus dados: abrir a janela mostra o e-mail e o cadastro, sem pedir a cópia (nada é registrado só por olhar)', async () => {
  const x = await abrir({ contaDoBanco: conta({ cadastro_salvo: true }), sessaoGuardada: true });
  await abrirDados(x);
  const t = await texto(x.page, '#folhaCorpo');
  const r = { email: /ana@teste\.local/.test(t), cadastro: /Cadastro de paciente ligado à conta\s*Sim/.test(t), pediuCopia: chamou(x.mundo, 'conta_paciente_meus_dados').length };
  await x.ctx.close();
  return { ok: r.email && r.cadastro && r.pediuCopia === 0, detalhe: JSON.stringify(r) };
});

await caso('Meus dados: "Baixar uma cópia" entrega um arquivo de texto legível com cadastro, pedidos e conversas', async () => {
  const x = await abrir({ contaDoBanco: conta({ cadastro_salvo: true }), sessaoGuardada: true });
  await abrirDados(x);
  const f = await baixar(x, '#btnBaixarTxt');
  const pediu = chamou(x.mundo, 'conta_paciente_meus_dados').length;
  await x.ctx.close();
  const ok = /^meus-dados-\d{4}-\d{2}-\d{2}\.txt$/.test(f.nome) && /MEUS DADOS NA CLÍNICA/.test(f.texto) && /Ana Souza/.test(f.texto) && /CPF: 11144477735/.test(f.texto)
    && /RESSONANCIA DO JOELHO \(D\)/.test(f.texto) && /você: Quero uma ressonância do joelho/.test(f.texto) && /clínica: Claro/.test(f.texto) && /RX TORAX/.test(f.texto) && !/undefined|\[object/.test(f.texto);
  return { ok: ok && pediu === 1, detalhe: `${f.nome}, ${f.texto.length} caracteres, pedidos de cópia=${pediu}` };
});

await caso('Meus dados: "formato de computador" entrega um JSON válido com os mesmos dados', async () => {
  const x = await abrir({ contaDoBanco: conta({ cadastro_salvo: true }), sessaoGuardada: true });
  await abrirDados(x);
  const f = await baixar(x, '#btnBaixarJson');
  await x.ctx.close();
  let j = null; try { j = JSON.parse(f.texto.replace(/^﻿/, '')); } catch { /* inválido */ }
  return { ok: /\.json$/.test(f.nome) && j && j.cadastro.nome === 'Ana Souza' && j.mensagens.length === 2, detalhe: f.nome };
});

await caso('Meus dados: se a cópia falha, aparece um aviso e o botão volta (sem arquivo vazio)', async () => {
  const x = await abrir({ contaDoBanco: conta(), sessaoGuardada: true });
  x.mundo.falhas.conta_paciente_meus_dados = { status: 500, corpo: { message: 'Failed to fetch' } };
  await abrirDados(x);
  let baixou = false; x.page.on('download', () => { baixou = true; });
  await x.page.click('#btnBaixarTxt'); await espera(600);
  const r = { erro: await texto(x.page, '#folhaCorpo .erro-form'), botao: await texto(x.page, '#btnBaixarTxt'), baixou };
  await x.ctx.close();
  return { ok: /Sem conexão/.test(r.erro) && /Baixar uma cópia/.test(r.botao) && !r.baixou, detalhe: JSON.stringify(r) };
});

await caso('Apagar a conta: o primeiro toque só pede confirmação (diz o que é apagado e o que continua guardado); "Não, voltar" cancela sem chamar nada', async () => {
  const x = await abrir({ contaDoBanco: conta(), sessaoGuardada: true });
  await abrirDados(x); await x.page.click('#btnApagarConta'); await x.page.waitForSelector('#btnApagarSim');
  const t = await texto(x.page, '#folhaCorpo');
  const foco = await x.page.evaluate(() => document.activeElement && document.activeElement.id);
  await x.page.click('#btnApagarNao'); await x.page.waitForSelector('#btnBaixarTxt');
  const r = { avisa: /não pode ser desfeito/i.test(t) && /continua guardado pela clínica/i.test(t) && /cadastro de paciente/i.test(t), foco, excluiu: chamou(x.mundo, 'conta_paciente_excluir').length, aindaConta: await visivel(x.page, '#btnContaSair') };
  await x.ctx.close();
  return { ok: r.avisa && r.foco === 'btnApagarNao' && r.excluiu === 0 && r.aindaConta, detalhe: JSON.stringify(r) };
});

await caso('Apagar a conta: confirmar chama o banco com a palavra de confirmação, sai da conta e limpa o aparelho', async () => {
  const x = await abrir({ contaDoBanco: conta(), sessaoGuardada: true });
  await x.page.waitForFunction(() => /Olá de novo/.test(document.querySelector('#tituloInicio')?.textContent || ''), null, { timeout: 5000 });
  await abrirDados(x); await x.page.click('#btnApagarConta'); await x.page.waitForSelector('#btnApagarSim'); await x.page.click('#btnApagarSim');
  await x.page.waitForFunction(() => document.querySelector('#folha').hidden, null, { timeout: 5000 }); await espera(300);
  const c = chamou(x.mundo, 'conta_paciente_excluir');
  const r = { chamadas: c.length, conf: c[0] && c[0].corpo.p_confirmacao, apagada: x.mundo.contaApagada === true, titulo: await texto(x.page, '#tituloInicio'),
    entrar: await visivel(x.page, '#btnContaEntrar'), dados: await visivel(x.page, '#btnContaDados'), logout: x.auth.chamadas.some((y) => y.caminho === '/auth/v1/logout'), aviso: await texto(x.page, '#toast') };
  await x.ctx.close();
  return { ok: r.chamadas === 1 && r.conf === 'EXCLUIR' && r.apagada && r.titulo === 'Vamos agendar?' && r.entrar && !r.dados && r.logout && /continuam guardados pela clínica/.test(r.aviso || ''), detalhe: JSON.stringify(r) };
});

await caso('Apagar a conta: se o banco falha, a conta continua, a janela fica aberta e o aviso aparece', async () => {
  const x = await abrir({ contaDoBanco: conta(), sessaoGuardada: true });
  x.mundo.falhas.conta_paciente_excluir = { status: 500, corpo: { message: 'Failed to fetch' } };
  await abrirDados(x); await x.page.click('#btnApagarConta'); await x.page.waitForSelector('#btnApagarSim'); await x.page.click('#btnApagarSim'); await espera(600);
  const r = { erro: await texto(x.page, '#folhaCorpo .erro-form'), aberta: await x.page.evaluate(() => !document.querySelector('#folha').hidden), conta: await visivel(x.page, '#btnContaSair'), botao: await texto(x.page, '#btnApagarSim') };
  await x.ctx.close();
  return { ok: /Sem conexão/.test(r.erro) && r.aberta && r.conta && /Sim, apagar/.test(r.botao), detalhe: JSON.stringify(r) };
});

await caso('Criar conta: o campo de data de nascimento aplica a máscara dd/mm/aaaa', async () => {
  const x = await abrir();
  await x.page.click('#btnContaCriar'); await x.page.waitForSelector('#cNasc');
  await x.page.type('#cNasc', '25031980');
  const v = await x.page.$eval('#cNasc', (e) => e.value);
  await x.ctx.close();
  return { ok: v === '25/03/1980', detalhe: v };
});

await caso('Depois de confirmar o e-mail, conta nova com data de nascimento pede ao banco para ligar ao cadastro e avisa', async () => {
  const x = await abrir({ contaDoBanco: conta(), auth: criarAuth({ meta: { nome: 'Ana Souza', telefone: '71999998888', dt_nasc: '1980-03-25' } }), sessaoGuardada: true, vinculo: 'vinculado' });
  const n = chamou(x.mundo, 'conta_paciente_vincular').length;
  const aviso = await texto(x.page, '#toast');
  const ligado = x.mundo.conta && x.mundo.conta.cadastro_salvo === true;
  await x.ctx.close();
  return { ok: n === 1 && /ligada ao seu cadastro/.test(aviso || '') && ligado, detalhe: `chamadas=${n}; aviso=${aviso}` };
});

await caso('Cadastro não encontrado: avisa com calma, continua logada e pode agendar', async () => {
  const x = await abrir({ contaDoBanco: conta(), auth: criarAuth({ meta: { nome: 'Ana Souza', telefone: '71999998888', dt_nasc: '1980-03-25' } }), sessaoGuardada: true, vinculo: 'nao_encontrado' });
  const aviso = await texto(x.page, '#toast'), logada = await visivel(x.page, '#btnContaSair'), nome = await visivel(x.page, '#blocoNome');
  await x.ctx.close();
  return { ok: /N[ãa]o achamos seu cadastro/.test(aviso || '') && logada, detalhe: `aviso=${aviso}; logada=${logada}; nome=${nome}` };
});

await caso('3 acertos (liga e avisa a equipe): a paciente fica ligada e o aviso diz que a equipe vai conferir telefone ou e-mail', async () => {
  const x = await abrir({ contaDoBanco: conta(), auth: criarAuth({ meta: { nome: 'Ana Souza', telefone: '71999998888', dt_nasc: '1980-03-25' } }), sessaoGuardada: true, vinculo: 'vinculado_conferir' });
  const aviso = await texto(x.page, '#toast'), ligado = x.mundo.conta && x.mundo.conta.cadastro_salvo === true;
  await x.ctx.close();
  return { ok: /equipe vai conferir/.test(aviso || '') && ligado, detalhe: `aviso=${aviso}; ligado=${ligado}` };
});

const metaNasc = { nome: 'Ana Souza', telefone: '71999998888', dt_nasc: '1980-03-25' };
await caso('Só nome e nascimento batem: NÃO fica ligada; abre a janela do CPF explicando o que falta; "Agora não" deixa com o atendente e ela já pode agendar', async () => {
  const x = await abrir({ contaDoBanco: conta(), auth: criarAuth({ meta: metaNasc }), sessaoGuardada: true, vinculo: 'em_analise' });
  await x.page.waitForSelector('#btnCpfConfirmar', { timeout: 4000 });
  const titulo = await texto(x.page, '#folhaTitulo'), explica = await texto(x.page, '#folhaCorpo .sub');
  await x.page.click('#btnCpfDepois'); await espera(200);
  const aviso = await texto(x.page, '#toast'), ligado = x.mundo.conta && x.mundo.conta.cadastro_salvo === true, logada = await visivel(x.page, '#btnContaSair'), aberta = await x.page.evaluate(() => !document.querySelector('#folha').hidden);
  await x.ctx.close();
  return { ok: /CPF/.test(titulo) && /telefone e o e-mail são diferentes/.test(explica) && /atendente vai conferir/.test(aviso || '') && /já pode agendar/.test(aviso || '') && !ligado && logada && !aberta, detalhe: `titulo=${titulo}; aviso=${aviso}; ligado=${ligado}` };
});

await caso('Janela do CPF: CPF com dígito errado nem chega à rede; CPF que não confere mostra aviso e deixa tentar de novo; CPF certo liga e fecha', async () => {
  const x = await abrir({ contaDoBanco: conta(), auth: criarAuth({ meta: metaNasc }), sessaoGuardada: true, vinculo: 'em_analise', mundoExtra: { cpfResultado: 'cpf_nao_confere' } });
  await x.page.waitForSelector('#cCpf'); await espera(150);
  await x.page.type('#cCpf', '12345678900'); const mascara = await x.page.$eval('#cCpf', (e) => e.value);
  await x.page.click('#btnCpfConfirmar'); await espera(150);
  const e1 = await texto(x.page, '#folhaCorpo .erro-form'), n1 = chamou(x.mundo, 'conta_paciente_confirmar_cpf').length;
  await x.page.fill('#cCpf', ''); await x.page.type('#cCpf', '52998224725'); await x.page.click('#btnCpfConfirmar'); await espera(250);
  const e2 = await texto(x.page, '#folhaCorpo .erro-form'), n2 = chamou(x.mundo, 'conta_paciente_confirmar_cpf').length, aindaAberta = await visivel(x.page, '#cCpf');
  x.mundo.cpfResultado = 'vinculado_conferir';
  await x.page.click('#btnCpfConfirmar'); await espera(500);
  const fechou = !(await visivel(x.page, '#cCpf')), aviso = await texto(x.page, '#toast'), corpo = chamou(x.mundo, 'conta_paciente_confirmar_cpf').pop().corpo, ligado = x.mundo.conta.cadastro_salvo === true;
  await x.ctx.close();
  return { ok: mascara === '123.456.789-00' && /não conferem/.test(e1) && n1 === 0 && /CPF não confere/.test(e2) && n2 === 1 && aindaAberta && fechou && /ligada ao seu cadastro/.test(aviso || '') && corpo.p_cpf === '529.982.247-25' && ligado, detalhe: JSON.stringify({ mascara, e1, n1, e2, n2, fechou, aviso, ligado }) };
});

await caso('Meus dados: conta ligada vê "Mudar e-mail ou telefone"; o pedido exige CPF válido e e-mail/telefone válidos e envia só o que mudou', async () => {
  const x = await abrir({ contaDoBanco: conta({ cadastro_salvo: true }), sessaoGuardada: true });
  await abrirDados(x);
  const temBotao = await visivel(x.page, '#btnAlterarDados'), semConfirmar = !(await visivel(x.page, '#btnConfirmarCpf'));
  await x.page.click('#btnAlterarDados'); await x.page.waitForSelector('#cNovoEmail'); await espera(150);
  const erros = [];
  const tentar = async () => { await x.page.click('#btnAlterarEnviar'); await espera(120); return texto(x.page, '#folhaCorpo .erro-form'); };
  erros.push(await tentar());                                                  // nada informado
  await x.page.fill('#cNovoEmail', 'sem-arroba'); erros.push(await tentar());  // e-mail inválido
  await x.page.fill('#cNovoEmail', 'novo@exemplo.com'); erros.push(await tentar());   // falta o CPF
  await x.page.type('#cCpf', '52998224725');
  const antes = chamou(x.mundo, 'conta_paciente_pedir_alteracao').length;
  await x.page.click('#btnAlterarEnviar'); await espera(500);
  const c = chamou(x.mundo, 'conta_paciente_pedir_alteracao'), fechou = !(await visivel(x.page, '#cNovoEmail')), aviso = await texto(x.page, '#toast');
  await x.ctx.close();
  return { ok: temBotao && semConfirmar && /novo e-mail ou o novo telefone/i.test(erros[0]) && /e-mail válido/.test(erros[1]) && /CPF não confere|números do CPF/.test(erros[2]) && antes === 0 && c.length === 1 && c[0].corpo.p_email === 'novo@exemplo.com' && c[0].corpo.p_telefone === null && c[0].corpo.p_cpf === '529.982.247-25' && fechou && /Pedido enviado/.test(aviso || ''), detalhe: JSON.stringify({ erros, chamadas: c.length, aviso }) };
});

await caso('Meus dados: pedido de mudança já aberto mostra o aviso no lugar do botão; CPF que não confere ou cadastro sem CPF mostram mensagem clara', async () => {
  const a = await abrir({ contaDoBanco: conta({ cadastro_salvo: true }), sessaoGuardada: true, mundoExtra: { estado: { ligada: true, verificar_aberto: false, alteracao_aberta: true } } });
  await abrirDados(a);
  const aviso = await texto(a.page, '#avisoAlteracao'), botao = await visivel(a.page, '#btnAlterarDados');
  await a.ctx.close();
  const msgs = [];
  for (const res of ['cpf_nao_confere', 'cadastro_sem_cpf', 'sem_mudanca']) {
    const x = await abrir({ contaDoBanco: conta({ cadastro_salvo: true }), sessaoGuardada: true, mundoExtra: { alteracaoResultado: res } });
    await abrirDados(x); await x.page.click('#btnAlterarDados'); await x.page.waitForSelector('#cNovoEmail'); await espera(150);
    await x.page.fill('#cNovoEmail', 'novo@exemplo.com'); await x.page.type('#cCpf', '52998224725'); await x.page.click('#btnAlterarEnviar'); await espera(300);
    msgs.push(await texto(x.page, '#folhaCorpo .erro-form')); await x.ctx.close();
  }
  return { ok: /está com a equipe/.test(aviso || '') && !botao && /CPF não confere/.test(msgs[0]) && /não tem CPF registrado/.test(msgs[1]) && /já estão no seu cadastro/.test(msgs[2]), detalhe: JSON.stringify({ aviso, botao, msgs }) };
});

await caso('Meus dados: conta ainda não ligada com pedido aberto mostra "Confirmar com o meu CPF" (e conta sem pedido não mostra nada extra)', async () => {
  const a = await abrir({ contaDoBanco: conta(), sessaoGuardada: true, mundoExtra: { estado: { ligada: false, verificar_aberto: true, alteracao_aberta: false } } });
  await abrirDados(a); const comPedido = await visivel(a.page, '#btnConfirmarCpf'), semAlterar = !(await visivel(a.page, '#btnAlterarDados'));
  await a.page.click('#btnConfirmarCpf'); await a.page.waitForSelector('#cCpf'); await espera(150); const abriu = await visivel(a.page, '#btnCpfConfirmar');
  await a.ctx.close();
  const b = await abrir({ contaDoBanco: conta(), sessaoGuardada: true }); await abrirDados(b);
  const nada = !(await visivel(b.page, '#btnConfirmarCpf')) && !(await visivel(b.page, '#btnAlterarDados'));
  await b.ctx.close();
  return { ok: comPedido && semAlterar && abriu && nada, detalhe: JSON.stringify({ comPedido, semAlterar, abriu, nada }) };
});

await caso('Criar conta: nome com uma palavra só é barrado ("nome completo")', async () => {
  const x = await abrir();
  await x.page.click('#btnContaCriar'); await x.page.waitForSelector('#cNome');
  await x.page.fill('#cNome', 'Ana'); await x.page.fill('#cTel', '71999998888'); await x.page.fill('#cNasc', '25/03/1980'); await x.page.fill('#cEmail', 'ana@teste.local'); await x.page.fill('#cSenha', 'Senha1234'); await x.page.check('#cAceite');
  await x.page.click('.conta-form button[type=submit]'); await espera(200);
  const erro = await texto(x.page, '.conta-form .erro-form'), rotulo = await texto(x.page, 'label[for=cNome]'), rede = x.auth.chamadas.length;
  await x.ctx.close();
  return { ok: /nome completo/i.test(erro || '') && /Nome completo/.test(rotulo || '') && rede === 0, detalhe: `erro=${erro}; rotulo=${rotulo}; rede=${rede}` };
});

await caso('Sem data de nascimento pendente (conta antiga ou já ligada): nem chama o vínculo', async () => {
  const a = await abrir({ contaDoBanco: conta(), sessaoGuardada: true });
  const b = await abrir({ contaDoBanco: conta({ cadastro_salvo: true }), auth: criarAuth({ meta: { dt_nasc: '1980-03-25' } }), sessaoGuardada: true });
  const r = { semData: chamou(a.mundo, 'conta_paciente_vincular').length, jaLigada: chamou(b.mundo, 'conta_paciente_vincular').length };
  await a.ctx.close(); await b.ctx.close();
  return { ok: r.semData === 0 && r.jaLigada === 0, detalhe: JSON.stringify(r) };
});

await caso('nenhuma exceção de JavaScript em toda a tela de login (ligada e desligada)', async () => {
  const a = await abrir(), b = await abrir({ ativo: false });
  await a.page.click('#btnContaCriar'); await a.page.waitForSelector('#cNome'); await a.page.click('text=Já tenho conta'); await a.page.waitForSelector('#cEmail');
  const erros = [...a.erros.excecoes, ...b.erros.excecoes];
  await a.ctx.close(); await b.ctx.close();
  return { ok: erros.length === 0, detalhe: erros.join(' | ') || 'sem exceções' };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} casos passaram.`);
process.exit(falhas ? 1 : 0);
