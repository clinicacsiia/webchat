// FLUXOGRAMA: entrada (repositório servido localmente + Supabase simulado com estado) -> validação (cada chamada do chat é registrada e pode ser atrasada ou falhar) -> lógica (um "mundo" guarda a conversa: mensagens, o que a listagem esconde, atrasos e erros) -> saída (página do chat pronta e conferida por quem importa este módulo)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
//
// Servidor de mentira do chat para os testes de navegador da Fase 9 (corrida das mensagens e Sentinela).
// Não fala com o Supabase real: simula só o que o chat do paciente chama. O objetivo é controlar o TEMPO
// (resposta que chega antes da mensagem do paciente, chamada que demora, chamada que falha).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');

export const RAIZ = resolve(import.meta.dirname, '..');
const UMD = resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const HOST = 'nrvuynjwcgwpjdptkiay.supabase.co';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

export function servidor() {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      const caminho = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let arquivo = join(RAIZ, caminho);
      if (existsSync(arquivo) && !extname(arquivo)) arquivo = join(arquivo, 'index.html');
      if (!existsSync(arquivo)) { res.writeHead(404); res.end('não encontrado'); return; }
      res.writeHead(200, { 'content-type': TIPOS[extname(arquivo)] ?? 'application/octet-stream' });
      res.end(await readFile(arquivo));
    }).listen(0, '127.0.0.1', () => ok(s));
  });
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Nomes REAIS do catálogo do Klingo (lidos da produção em 31/10/2026), com a caixa alta, o "(UNILATERAL)" e os parênteses cortados.
const nomes = (lista, uni) => lista.map((nome, i) => ({ id: 1000 + i, nome, unilateral: uni && /UNILATERAL/.test(nome), bilateral: /BILATERAL/.test(nome) }));
export const EXAMES = {
  punho_mao: nomes(['RM ARTICULAR (POR ARTICULAÇÃO)', 'RM DE MÃO E PUNHO - INCLUI ARTRO-RESSONÂNCIA (UNILATERAL)', 'RM MÃO (NÃO INCLUI PUNHO)', 'RM PUNHO (INCLUI ARTRO-RESSONÂNCIA) UNILATERAL'], true),
  torax: nomes(['RM DE TÓRAX', 'TC ARTICULAÇÃO (ESTERNOCLAVICULAR OU OMBRO OU COTOVELO OU PUNHO OU SACROILÍACA OU COXOFEMORAL OU JOELHO OU TORNOZELO) UNILATERAL', 'RM MAMA BILATERAL'], true),
  cranio: nomes(['ANGIO RM ARTERIAL CRANIO', 'ANGIO-RM ARTERIAL DE CRÂNIO', 'ANGIO-RM VENOSA DE CRÂNIO', 'PCT ANGIO-RM CRÂNIO', 'PERFUSÃO CEREBRAL POR RM', 'RM BASE DO CRÂNIO', 'RM CRÂNIO (ENCÉFALO)',
    'RM DE CRÂNIO', 'RM DE FACE / ATM / SELA TÚRCICA', 'RM DO CRANIO', 'RM NEURONAVEGADOR', 'RM OSSOS TEMPORAIS BILATERAL', 'RM SELA TÚRCICA (HIPÓFISE)', 'RM TRACTOGRAFIA'], false),
};
export const CONFIG_CORPO = {
  modalidades: [
    { codigo: 'RM', nome: 'Ressonância', total: 40, mapa: true, regioes: ['cranio', 'ombro', 'torax', 'coluna_lombar', 'joelho', 'punho_mao'] },
    { codigo: 'US', nome: 'Ultrassom', total: 60, mapa: true, regioes: ['abdome', 'joelho'] },
    { codigo: 'MAMO', nome: 'Mamografia', total: 5, mapa: false, regioes: [] },
  ],
  regioes: [
    { codigo: 'cranio', nome: 'Crânio', tem_lado: false }, { codigo: 'ombro', nome: 'Ombro', tem_lado: true },
    { codigo: 'torax', nome: 'Tórax', tem_lado: false }, { codigo: 'coluna_lombar', nome: 'Coluna lombar', tem_lado: false },
    { codigo: 'joelho', nome: 'Joelho', tem_lado: true }, { codigo: 'abdome', nome: 'Abdome', tem_lado: false }, { codigo: 'punho_mao', nome: 'Punho / mão', tem_lado: true },
  ],
};

// O estado da conversa de mentira e as regras de cada chamada.
export function criarMundo(opcoes = {}) {
  const m = {
    msgs: [], prox: 100, conversa: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', token: 'token-de-teste', status: 'aguardando', motor: true, passo: null,
    escondeCliente: false,        // a listagem esconde a mensagem do paciente enquanto a chamada dele não volta (o aviso em tempo real chegou antes)
    ocultos: new Set(), atraso: { chat_responder: 0, chat_enviar: 0, chat_listar: 0 }, falhas: {}, chamadas: [], incidentes: [],
    ...opcoes,
  };
  const agora = () => new Date().toISOString();
  m.inserir = (autor, texto, opcoes2 = null) => {
    const x = { id: ++m.prox, autor, texto, opcoes: opcoes2, criado_em: agora(), agente: autor === 'agente' ? 'Assistente virtual' : null };
    m.msgs.push(x); if (autor === 'agente' && opcoes2 && opcoes2.passo) m.passo = opcoes2.passo;
    return x;
  };
  m.perguntaMotivo = () => m.inserir('agente', 'O que você precisa?', { tipo: 'escolha', passo: 'motivo',
    itens: [{ valor: 'exame', rotulo: 'Exame', desc: 'Ressonância, tomografia e outros' }, { valor: 'consulta', rotulo: 'Consulta', desc: 'Com médico ou especialista' }] });
  m.perguntaPlano = () => m.inserir('agente', 'O atendimento será particular ou por convênio?', { tipo: 'escolha', passo: 'plano',
    itens: [{ valor: 'particular', rotulo: 'Particular' }, { valor: 'convenio', rotulo: 'Convênio' }] });
  m.perguntaPedido = () => m.inserir('agente', 'Escolha o exame.', { tipo: 'pedido_exames', passo: 'exame', rotulo: 'Escolher exames no mapa do corpo' });
  m.final = () => m.inserir('agente', 'Pronto! Recebemos tudo.', { tipo: 'acompanhar' });
  m.seguinte = () => (m.passo === 'motivo' ? m.perguntaPlano() : m.passo === 'plano' ? m.final() : m.inserir('agente', 'Certo.', null));
  m.lista = (apos) => m.msgs.filter((x) => x.id > apos && !m.ocultos.has(x.id));

  m.tratar = async (nome, corpo, cabecalhos = {}) => {
    m.chamadas.push({ nome, corpo, t: Date.now(), autorizacao: cabecalhos.authorization || null });
    if (m.atraso[nome]) await espera(m.atraso[nome]);
    const falha = m.falhas[nome];
    if (falha && (falha.vezes == null || falha.vezes > 0)) { if (falha.vezes != null) falha.vezes--; return { status: falha.status ?? 400, body: falha.corpo ?? { code: 'XX000', message: 'falha simulada' } }; }
    switch (nome) {
      case 'chat_config': return { body: { nome_empresa: 'Clínica de Teste', boas_vindas: 'Olá!' } };
      case 'chat_iniciar': { m.msgs.length = 0; const q = m.perguntaMotivo(); return { body: { conversa_id: m.conversa, token: m.token, motor: 'fluxo', respostas: [q] } }; }
      case 'chat_listar': return { body: { status: m.status, agente: null, motor_ativo: m.motor, passo: m.passo, mensagens: m.lista(corpo.p_apos || 0) } };
      case 'chat_responder': case 'chat_enviar': {
        const atendente = corpo.p_valor && corpo.p_valor.acao === 'atendente';
        const texto = atendente ? 'Quero falar com um atendente.' : (corpo.p_texto || 'Enviado.');
        const cli = m.inserir('cliente', texto);
        let resp;
        if (atendente) { m.motor = false; resp = m.inserir('agente', 'Um atendente vai continuar com você em instantes.', null); }
        else if (nome === 'chat_enviar') resp = m.inserir('agente', 'Recebemos a sua mensagem.', null);
        else resp = m.seguinte();
        if (m.escondeCliente) m.ocultos.add(cli.id);
        const respostas = [cli, resp];
        if (m.atrasoDepois) await espera(m.atrasoDepois);
        m.ocultos.clear();
        return { body: { id: cli.id, respostas } };
      }
      case 'chat_acompanhar': return { body: { agora: agora(), conversa: m.status, agente: null, equipe_online: true, pedido: 'pronto', tipo: 'exame', conferencia: null, enviado_em: agora(), confirmado: false, horarios: [] } };
      case 'chat_corpo': return { body: CONFIG_CORPO };
      case 'chat_pedido_salvar': return { body: { ok: true, itens: (corpo.p_itens || []).length, mensagem_id: 999 } };
      case 'chat_exames': return { body: EXAMES[corpo.p_regiao] || [] };
      case 'chat_incidente': m.incidentes.push(corpo); return { body: { ok: true } };
      // login do paciente (opcional)
      case 'login_paciente_ativo': return { body: m.loginAtivo === true };
      case 'conta_paciente_resumo': return { body: m.conta || { conta: false } };
      case 'conta_paciente_vincular': {
        if (!m.conta) return { status: 400, body: { code: '42501', message: 'Entre na sua conta para ligar o cadastro.' } };
        const resultado = m.vinculo || 'nada_pendente';
        if (resultado === 'vinculado' || resultado === 'vinculado_conferir') m.conta = { ...m.conta, cadastro_salvo: true };
        return { body: { resultado } };
      }
      case 'conta_paciente_vinculo_estado': return { body: m.estado || { ligada: !!(m.conta && m.conta.cadastro_salvo), verificar_aberto: false, alteracao_aberta: false } };
      case 'conta_paciente_confirmar_cpf': {
        const resultado = m.cpfResultado || 'cpf_nao_confere';
        if (resultado === 'vinculado_conferir' && m.conta) m.conta = { ...m.conta, cadastro_salvo: true };
        return { body: { resultado } };
      }
      case 'conta_paciente_pedir_alteracao': return { body: { resultado: m.alteracaoResultado || 'pedido_enviado' } };
      case 'conta_paciente_perfil': {
        if (!m.conta) return { status: 400, body: { code: '42501', message: 'Entre na sua conta para salvar os dados.' } };
        m.conta = { ...m.conta, nome: String(corpo.p_nome || '').trim(), telefone: String(corpo.p_telefone || '').replace(/\D/g, '') };
        return { body: m.conta };
      }
      case 'conta_paciente_meus_dados': {
        if (!m.conta) return { status: 400, body: { code: '42501', message: 'Entre na sua conta para ver os seus dados.' } };
        return { body: m.meusDados || {
          gerado_em: '2026-10-31T15:00:00Z',
          conta: { email: m.conta.email, nome: m.conta.nome, telefone: m.conta.telefone, criada_em: '2026-10-01T10:00:00Z', aceitou_lgpd_em: '2026-10-01T10:00:00Z' },
          cadastro: { nome: 'Ana Souza', data_nascimento: '1950-03-25', cpf: '11144477735', email: m.conta.email, telefones: ['71999998888'], outros_dados: { mae: 'Maria Souza' }, criado_em: '2026-10-01T10:00:00Z', ultima_visita_em: '2026-10-20T10:00:00Z' },
          historico: [{ quando: '2026-09-10T08:00:00Z', exames: [{ exame: 'RX TORAX' }], horarios: [], convenio: 'UNIMED', unidade: 'CSI', profissional: null, cancelado: false }],
          pedidos: [{ iniciado_em: '2026-10-20T09:00:00Z', para: 'a própria pessoa', tipo: 'exame', situacao: 'pronto', exames: ['RESSONANCIA DO JOELHO (D)'], convenio: 'UNIMED', unidade: 'CSI', profissional: null, horarios: null, dados_informados: {} }],
          mensagens: [{ quando: '2026-10-20T09:00:00Z', quem: 'você', texto: 'Quero uma ressonância do joelho' }, { quando: '2026-10-20T09:00:05Z', quem: 'clínica', texto: 'Claro! Escolha o exame.' }],
          fotos_de_pedido_guardadas: 1, observacao: 'As fotos de pedido médico não vão neste arquivo.' } };
      }
      case 'conta_paciente_excluir': {
        if (!m.conta) return { status: 400, body: { code: '42501', message: 'Entre na sua conta para apagá-la.' } };
        if (corpo.p_confirmacao !== 'EXCLUIR') return { status: 400, body: { code: '22023', message: 'Confirmação ausente: a conta não foi apagada.' } };
        m.conta = null; m.contaApagada = true;
        return { body: { ok: true, continua_guardado: ['cadastro', 'pedidos', 'conversas', 'historico'] } };
      }
      default: return { body: {} };
    }
  };
  return m;
}

export async function novaPaginaChat(browser, mundo, { init = [], auth = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  for (const [fn, arg] of init) await ctx.addInitScript(fn, arg);
  const erros = { excecoes: [] };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erros.excecoes.push(e.message));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(UMD) }));
  await ctx.route(`https://${HOST}/**`, async (rota) => {
    const req = rota.request();
    if (req.method() === 'OPTIONS') return rota.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    if (auth && url.pathname.startsWith('/auth/v1/')) {   // endpoints de login simulados pelo teste
      let corpoAuth = {}; try { corpoAuth = JSON.parse(req.postData() || '{}'); } catch { /* sem corpo */ }
      const r = await auth({ metodo: req.method(), caminho: url.pathname, busca: url.searchParams, corpo: corpoAuth, cabecalhos: req.headers() });
      return rota.fulfill({ status: r.status ?? 200, headers: CORS, contentType: 'application/json', body: r.body === undefined ? '' : JSON.stringify(r.body) });
    }
    const nome = (/\/rest\/v1\/rpc\/([a-z0-9_]+)/.exec(url.pathname) || [])[1];
    if (!nome) return rota.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '[]' });
    let corpo = {}; try { corpo = JSON.parse(req.postData() || '{}'); } catch { /* sem corpo */ }
    const r = await mundo.tratar(nome, corpo, req.headers());
    return rota.fulfill({ status: r.status ?? 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  if (typeof page.routeWebSocket === 'function') await page.routeWebSocket(/supabase\.co/, (ws) => ws.close());
  return { page, ctx, erros };
}

// Preenche o formulário inicial como um paciente adulto e começa a conversa.
export async function comecarConversa(page, base) {
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('#formInicio', { state: 'visible', timeout: 8000 });
  await page.click('#fQuem .unidade >> nth=0');
  await page.fill('#fNome', 'Maria da Silva');
  await page.fill('#fTel', '71999998888');
  await page.fill('#fEmail', 'maria@teste.local');
  await page.check('#fAceite');
  await page.click('#btnIniciar');
  await page.waitForSelector('#msgs .msg.agente .op', { timeout: 8000 });
}

// A conversa como o paciente a vê: [['A'|'C'|'S', texto]...] na ordem da tela.
export const ordemNaTela = (page) => page.$$eval('#msgs .msg', (ns) => ns.map((n) => [
  n.classList.contains('cliente') ? 'C' : n.classList.contains('agente') ? 'A' : 'S',
  (n.querySelector('span:not(.quem):not(.hora)') || n).textContent.trim().slice(0, 40)]));
