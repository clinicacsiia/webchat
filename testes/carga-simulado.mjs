// FLUXOGRAMA: entrada (nenhuma) -> validação (mesmas recusas do banco: token, 20 msgs/min, 5 conversas/hora por telefone, dados inválidos) -> lógica (PostgREST de mentira em memória, com o motor devolvendo perguntas de escolha, formulário e texto) -> saída (servidor HTTP em porta livre)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
//
// Serve só para provar que o carga.mjs funciona (mede, conta erros, reprova quando deve) sem tocar na produção.
// Os números de tempo daqui NÃO dizem nada sobre o Supabase real. Use CARGA_SIMULADO_ATRASO_MS para simular um servidor lento.
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';

export function simulado() {
  const atrasoMs = Number(process.env.CARGA_SIMULADO_ATRASO_MS || 5);
  const convs = new Map(), porTelefone = new Map();
  let proximoId = 1;
  const erro = (res, status, code, message) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code, message })); };
  const ok = (res, corpo) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(corpo)); };
  const agora = () => Date.now();

  const dizer = (c, texto, opcoes) => { const m = { id: proximoId++, autor: 'agente', texto, opcoes, criado_em: new Date().toISOString() }; c.msgs.push(m); return m; };
  const passos = [
    () => ({ tipo: 'escolha', passo: 'assunto', itens: [{ valor: 'Exame', rotulo: 'Marcar exame' }, { valor: 'Dúvida', rotulo: 'Tirar uma dúvida' }] }),
    () => ({ tipo: 'campos', passo: 'dados_contato', botao: 'Continuar', campos: [{ nome: 'celular', rotulo: 'Celular', tipo: 'tel', obrigatorio: true }] }),
    () => ({ tipo: 'texto', passo: 'assunto_texto', texto_livre: true }),
    () => ({ tipo: 'escolha', passo: 'plano', itens: [{ valor: 'Particular', rotulo: 'Particular' }] })
  ];
  const proxima = (c) => { const op = passos[c.passo % passos.length](); c.passoAtual = op.passo; return dizer(c, 'Pergunta ' + c.passo, op); };

  const valida = (b, res) => {
    const c = convs.get(b.p_conversa);
    if (!c || c.token !== b.p_token) { erro(res, 400, '28000', 'Conversa não encontrada.'); return null; }
    return c;
  };
  const limite = (c) => { c.envios = c.envios.filter((t) => agora() - t < 60000); return c.envios.length >= 20; };

  const rotas = {
    chat_config: (b, res) => ok(res, { nome_empresa: 'Simulado', boas_vindas: 'Olá' }),
    chat_iniciar: (b, res) => {
      const tel = String(b.p_telefone || '').replace(/\D/g, '');
      if (!b.p_aceite || String(b.p_nome || '').trim().length < 2 || ![10, 11].includes(tel.length) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.p_email || '')))
        return erro(res, 400, '22023', 'Dados inválidos.');
      const hist = (porTelefone.get(tel) || []).filter((t) => agora() - t < 3600000);
      if (hist.length >= 5) return erro(res, 400, '54000', 'Muitas tentativas.');
      hist.push(agora()); porTelefone.set(tel, hist);
      const c = { id: randomUUID(), token: randomBytes(16).toString('hex'), msgs: [], envios: [], passo: 0 };
      convs.set(c.id, c);
      const m = proxima(c);
      ok(res, { conversa_id: c.id, token: c.token, motor: 'fluxo', respostas: [m] });
    },
    chat_listar: (b, res) => {
      const c = valida(b, res); if (!c) return;
      ok(res, { status: 'aguardando', agente: null, motor_ativo: true, passo: c.passoAtual, mensagens: c.msgs.filter((m) => m.id > (b.p_apos || 0)) });
    },
    chat_enviar: (b, res) => {
      const c = valida(b, res); if (!c) return;
      if (limite(c)) return erro(res, 400, '54000', 'Muitas mensagens em pouco tempo.');
      c.envios.push(agora());
      const m = { id: proximoId++, autor: 'cliente', texto: b.p_texto, opcoes: null, criado_em: new Date().toISOString() }; c.msgs.push(m);
      ok(res, { id: m.id, respostas: [m] });
    },
    chat_responder: (b, res) => {
      const c = valida(b, res); if (!c) return;
      if (limite(c)) return erro(res, 400, '54000', 'Muitas mensagens em pouco tempo.');
      if (b.p_passo !== c.passoAtual && !(b.p_valor && b.p_valor.acao === 'atendente')) return erro(res, 400, '22023', 'Essa pergunta já foi respondida.');
      c.envios.push(agora());
      const eu = { id: proximoId++, autor: 'cliente', texto: b.p_texto || 'Enviado.', opcoes: null, criado_em: new Date().toISOString() }; c.msgs.push(eu);
      c.passo++;
      const resp = proxima(c);
      ok(res, { id: eu.id, respostas: [eu, resp] });
    }
  };

  return new Promise((pronto) => {
    const s = createServer((req, res) => {
      let corpo = '';
      req.on('data', (d) => { corpo += d; });
      req.on('end', () => setTimeout(() => {
        const nome = req.url.split('?')[0].replace('/rest/v1/rpc/', '');
        const f = rotas[nome];
        if (!f) return erro(res, 404, 'PGRST202', 'Função não existe: ' + nome);
        let b = {}; try { b = corpo ? JSON.parse(corpo) : {}; } catch { return erro(res, 400, '22P02', 'JSON inválido'); }
        f(b, res);
      }, atrasoMs * (0.5 + Math.random())));
    }).listen(0, '127.0.0.1', () => pronto(s));
  });
}
