/* FLUXOGRAMA: entrada (eventos do chat + DOM da conversa + chamadas ao Supabase + erros de JavaScript) -> validação (regras: ordem das mensagens, mensagem pendente, resposta que não vem, tela travada, erro de chamada, paciente parado, conversa antiga) -> lógica (cura sozinha o que dá, fala com o paciente numa faixa acima do campo de mensagem, aprende os tempos deste aparelho) -> saída (aviso com botões, código de rastreio CSI-AAMMDD-HHMM-TIPO-XXXX e incidente enviado ao Supabase)
   Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial

   Sentinela do chat: fica de olho na conversa, ajuda quem trava e deixa um código para a equipe rastrear o problema.
   - Não lê nem guarda o TEXTO das mensagens, CPF, telefone ou e-mail. Registra só o que aconteceu (tipo de evento, passo, tempos, status das chamadas).
   - Se este arquivo não carregar, o chat funciona igual (o index.html só chama a Sentinela se ela existir).
   - O "aprendizado" é local e simples: guarda os tempos das chamadas e das etapas DESTE aparelho e ajusta sozinha o que considera "lento" e "parado".
   - As funções puras (código, percentil, limiares, ordem, classificação de erro) também rodam no Node, para teste (testes/sentinela.test.mjs). */
(function (raiz, fabrica) {
  'use strict';
  const S = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = S;
  if (raiz && raiz.document) raiz.Sentinela = S;
})(typeof window !== 'undefined' ? window : globalThis, function (janela) {
  'use strict';
  const VERSAO = '1.0';
  const ALFABETO = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // sem 0/O/1/I/L: o código é lido e ditado por telefone
  // erro = gera código de rastreio e vai para a equipe; os demais só ajudam o paciente.
  const TIPOS = {
    ORD: { rotulo: 'Mensagens fora de ordem', erro: true },
    LNT: { rotulo: 'Resposta demorou', erro: true },
    TRV: { rotulo: 'Tela travada', erro: true },
    RPC: { rotulo: 'Falha ao falar com o servidor', erro: true },
    DES: { rotulo: 'Conversa dessincronizada', erro: true },
    JS: { rotulo: 'Erro no aplicativo', erro: true },
    DIA: { rotulo: 'Diagnóstico pedido pelo usuário', erro: false },
    NET: { rotulo: 'Sem conexão', erro: false },
    ANT: { rotulo: 'Conversa antiga ou indisponível', erro: false },
    LIM: { rotulo: 'Muitas mensagens em pouco tempo', erro: false },
    PAR: { rotulo: 'Parado na mesma etapa', erro: false }
  };

  /* ---------- funções puras ---------- */
  function gerarCodigo(tipo, quando, aleatorio) {
    const d = quando || new Date(), r = aleatorio || Math.random, p2 = (n) => String(n).padStart(2, '0');
    let suf = '';
    for (let i = 0; i < 4; i++) suf += ALFABETO[Math.floor(r() * ALFABETO.length) % ALFABETO.length];
    return `CSI-${p2(d.getFullYear() % 100)}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}-${tipo}-${suf}`;
  }
  const codigoValido = (c) => /^CSI-\d{6}-\d{4}-[A-Z]{3}-[A-Z0-9]{4}$/.test(String(c || ''));
  function percentil(lista, p) {
    const v = (lista || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    return v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
  }
  const mediana = (lista) => percentil(lista, 0.5);
  const entre = (x, a, b) => Math.max(a, Math.min(b, x));
  // "Lento" = 2,5 vezes o p90 do que este aparelho já viu (mínimo 8 s, máximo 30 s). Com poucas amostras, 10 s.
  const limiarLento = (amostrasMs) => ((amostrasMs || []).length < 5 ? 10000 : entre(percentil(amostrasMs, 0.9) * 2.5, 8000, 30000));
  // "Parado" = 3 vezes a mediana do tempo que as respostas levaram nesta etapa (mínimo 60 s, máximo 180 s). Sem histórico, 90 s.
  const limiarParado = (amostrasSeg) => ((amostrasSeg || []).length < 3 ? 90000 : entre(mediana(amostrasSeg) * 3 * 1000, 60000, 180000));
  const ordemOk = (ids) => (ids || []).every((x, i, a) => i === 0 || x > a[i - 1]);
  // Tira número comprido (CPF, telefone, protocolo) de qualquer texto que vá para o registro.
  const mascarar = (t) => String(t == null ? '' : t).replace(/\d{6,}/g, '#').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '@').slice(0, 120);
  const CHAVE_SENSIVEL = /texto|valor|nome|cpf|email|e-mail|telefone|celular|token|senha|endereco|mae|dt_nasc/i;
  // Só passa dado simples e curto; nunca o que parece conteúdo de paciente.
  function limpar(d) {
    const o = {};
    if (!d || typeof d !== 'object') return o;
    for (const [k, v] of Object.entries(d)) {
      if (CHAVE_SENSIVEL.test(k)) continue;
      if (typeof v === 'number' || typeof v === 'boolean') o[k] = v;
      else if (typeof v === 'string') o[k] = mascarar(v).slice(0, 80);
      else if (v == null) o[k] = null;
    }
    return o;
  }
  // Traduz a resposta de erro do Supabase num tipo de problema.
  function classificarRpc(nome, status, corpo, online) {
    const cod = corpo && corpo.code ? String(corpo.code) : '', msg = corpo && corpo.message ? String(corpo.message) : '';
    if (!status) return { tipo: online === false ? 'NET' : 'RPC', cod: '', msg: mascarar(msg) };
    if (cod === '22023' || /j[aá] foi respondida/i.test(msg)) return { tipo: 'DES', cod, msg: mascarar(msg) };
    if (cod === '28000') return { tipo: 'ANT', cod, msg: mascarar(msg) };
    if (cod === '54000') return { tipo: 'LIM', cod, msg: mascarar(msg) };
    return { tipo: 'RPC', cod, msg: mascarar(msg) };
  }
  const PURO = { gerarCodigo, codigoValido, percentil, mediana, limiarLento, limiarParado, ordemOk, mascarar, limpar, classificarRpc, TIPOS, versao: VERSAO };
  if (!janela.document) return PURO;   // Node: só as funções puras

  /* ---------- navegador ---------- */
  const doc = janela.document;
  const CHAVE_MEM = 'webchat.sentinela.v1', CHAVE_FILA = 'webchat.sentinela.fila.v1', CHAVE_ULTIMO = 'webchat.sentinela.ultimo.v1';
  const RITMO = Number(janela.SENTINELA_RITMO) > 0 ? Number(janela.SENTINELA_RITMO) : 1;   // só os testes mudam (acelera os relógios)
  const T = (ms) => Math.max(40, Math.round(ms * RITMO));
  const ls = {
    ler(k) { try { return JSON.parse(janela.localStorage.getItem(k)); } catch { return null; } },
    gravar(k, v) { try { janela.localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento: segue sem memória */ } }
  };
  const mem = Object.assign({ rpc: {}, passo: {}, incidentes: {}, parados: {} }, ls.ler(CHAVE_MEM) || {});
  let salvarT = null;
  const salvarMem = () => { clearTimeout(salvarT); salvarT = setTimeout(() => ls.gravar(CHAVE_MEM, mem), 500); };
  const guardar = (lista, v, max) => { lista.push(v); while (lista.length > max) lista.shift(); return lista; };

  let cfg = { contexto: () => ({}), acoes: {}, apoio: null };
  const anel = [], rpcs = [];
  let emVoo = 0, apoioAtual = null, apoioTimer = null, ultimaInteracao = Date.now(), passoDesde = null, ultimoCodigo = (ls.ler(CHAVE_ULTIMO) || {}).c || null, ultimoCodigoT = (ls.ler(CHAVE_ULTIMO) || {}).t || 0;
  let iniciada = false, tick = null, verificarT = null, enviando = false, semServidorAte = 0, antigaAvisada = null;
  const falhas = [], recentes = new Map(), paradoAvisado = new Set();
  const vistoEm = new WeakMap(), travadoDesde = new WeakMap(), conferido = new WeakSet();
  let desordemDesde = 0, desordemCodigo = null, travaCurada = null, semRespostaChave = '', semRespostaDesde = 0;
  const ctx = () => { try { return cfg.contexto() || {}; } catch { return {}; } };
  const $ = (s) => doc.querySelector(s);
  const seguro = (fn) => function () { try { return fn.apply(this, arguments); } catch (e) { try { anel.push({ t: Date.now(), k: 'sentinela_erro', m: mascarar(e && e.message) }); } catch { /* nada */ } } };

  /* --- registro de eventos e aprendizado --- */
  function evento(tipo, d) {
    seguro(() => {
      const e = Object.assign({ t: Date.now(), k: tipo }, limpar(d));
      guardar(anel, e, 60);
      if (tipo === 'abriu') { antigaAvisada = null; paradoAvisado.clear(); }
      else if (tipo === 'msg') {
        if (e.autor === 'agente') {
          if (e.passo) passoDesde = { passo: e.passo, t: e.t };
          if (apoioAtual && (apoioAtual.id === 'lnt' || apoioAtual.id === 'par')) fechar(apoioAtual.id);
        }
      } else if (tipo === 'enviou') {
        ultimaInteracao = e.t;
        if (passoDesde && e.passo && e.passo === passoDesde.passo) {
          const seg = (e.t - passoDesde.t) / 1000;
          if (seg > 0 && seg < 600) { guardar(mem.passo[e.passo] = mem.passo[e.passo] || [], Math.round(seg), 20); salvarMem(); }
        }
      }
      agendarVerificar();
    })();
  }

  /* --- chamadas ao Supabase: mede e aprende --- */
  const SILENCIOSAS = new Set(['chat_config', 'chat_acompanhar', 'ler-pedido', 'chat_pedido_ler', 'chat_pedido_escolha', 'chat_anexo_enviar', 'chat_incidente']);
  function envolverFetch() {
    if (typeof janela.fetch !== 'function' || janela.fetch.__sentinela) return;
    const original = janela.fetch.bind(janela);
    const novo = function (entrada, init) {
      let url = '';
      try { url = typeof entrada === 'string' ? entrada : (entrada && entrada.url) || String(entrada); } catch { /* sem url */ }
      const m = /\/rest\/v1\/rpc\/([a-z0-9_]+)|\/functions\/v1\/([a-z0-9_-]+)/i.exec(url);
      const nome = m ? (m[1] || m[2]) : null;
      if (!nome || nome === 'chat_incidente') return original(entrada, init);
      const t0 = performance.now(); emVoo++;
      return original(entrada, init).then((res) => {
        emVoo--;
        const ms = Math.round(performance.now() - t0);
        if (res.ok) seguro(aoTerminarRpc)(nome, res.status, ms, null);
        else res.clone().json().catch(() => null).then((c) => seguro(aoTerminarRpc)(nome, res.status, ms, c));
        return res;
      }, (err) => {
        emVoo--;
        seguro(aoTerminarRpc)(nome, 0, Math.round(performance.now() - t0), { message: err && err.message });
        throw err;
      });
    };
    novo.__sentinela = true;
    janela.fetch = novo;
  }
  const amostrasEnvio = () => [].concat(mem.rpc.chat_responder || [], mem.rpc.chat_enviar || []);
  function aoTerminarRpc(nome, status, ms, corpo) {
    guardar(rpcs, { n: nome, s: status, ms, t: Date.now() }, 15);
    if (status >= 200 && status < 300) {
      if (/^chat_/.test(nome)) { guardar(mem.rpc[nome] = mem.rpc[nome] || [], ms, 40); salvarMem(); }
      // O aviso de erro só some quando a MESMA chamada que falhou volta a funcionar (a consulta de rotina que deu certo não prova nada).
      if (apoioAtual && !SILENCIOSAS.has(nome) && (apoioAtual.id === 'net' || (apoioAtual.id === 'rpc' && apoioAtual.chamada === nome))) fechar(apoioAtual.id);
      const lim = limiarLento(mem.rpc[nome]);
      if (!SILENCIOSAS.has(nome) && ms > lim) {
        registrar('LNT', { chamada: nome, ms, limite: Math.round(lim) });
        mostrar({ id: 'lento', nivel: 'info', titulo: 'A conexão está lenta', texto: 'Demorou mais do que o normal, mas deu certo. Obrigado pela paciência!', auto: T(7000) });
      }
      return;
    }
    if (SILENCIOSAS.has(nome)) return;
    const c = classificarRpc(nome, status, corpo, janela.navigator.onLine);
    const detalhe = { chamada: nome, status, codigo_pg: c.cod, erro: c.msg, ms };
    if (c.tipo === 'NET') {
      mostrar({ id: 'net', nivel: 'aviso', titulo: 'Sem conexão com a internet', texto: 'Não se preocupe: o que você já fez está guardado. Assim que a internet voltar eu atualizo a conversa sozinho.' });
    } else if (c.tipo === 'DES') {
      const codigo = registrar('DES', detalhe);
      if (cfg.acoes.recarregar) cfg.acoes.recarregar();
      mostrar({ id: 'des', nivel: 'info', titulo: 'Atualizei a conversa', texto: 'A pergunta já tinha sido respondida. A mais recente está logo acima, é só continuar a partir dela.', codigo, auto: T(10000) });
    } else if (c.tipo === 'ANT') {
      mostrar({ id: 'ant', nivel: 'aviso', titulo: 'Esta conversa não está mais disponível', texto: 'Acontece quando a conversa é antiga. Vamos começar um pedido novo, é rapidinho.',
        botoes: [{ rotulo: 'Começar um pedido novo', principal: true, fn: () => cfg.acoes.novoPedido && cfg.acoes.novoPedido() }] });
    } else if (c.tipo === 'LIM') {
      mostrar({ id: 'lim', nivel: 'info', titulo: 'Calma, estou aqui', texto: 'Foram muitas mensagens em pouco tempo. Espere alguns segundos e tente de novo.', auto: T(9000) });
    } else {
      falhas.push(Date.now()); while (falhas.length && Date.now() - falhas[0] > 60000) falhas.shift();
      const codigo = registrar('RPC', Object.assign(detalhe, { falhas_no_minuto: falhas.length }));
      mostrar({ id: 'rpc', chamada: nome, nivel: 'erro', titulo: 'Tive um problema para falar com o servidor', codigo,
        texto: falhas.length >= 3 ? 'Já tentei algumas vezes e não deu. Peço desculpas! Uma pessoa da equipe pode continuar com você: toque em “Chamar um atendente” e informe o código abaixo.'
          : 'Peço desculpas pelo transtorno. Vou tentar de novo; se continuar, é só chamar um atendente e informar o código abaixo.',
        botoes: [{ rotulo: 'Tentar de novo', principal: true, fn: () => cfg.acoes.recarregar && cfg.acoes.recarregar() }, { rotulo: 'Chamar um atendente', fn: () => cfg.acoes.atendente && cfg.acoes.atendente() }] });
    }
  }

  /* --- incidentes e código de rastreio --- */
  function resumoDom() {
    const msgs = $('#msgs'); if (!msgs) return {};
    const nos = [...msgs.querySelectorAll('.msg')], ids = nos.filter((n) => n.dataset.id).map((n) => Number(n.dataset.id));
    return { mensagens: nos.length, pendentes: msgs.querySelectorAll('.msg.pendente').length, widgets_ativos: msgs.querySelectorAll('.widget:not(.respondido)').length,
      ids_primeiro: ids[0] || null, ids_ultimo: ids[ids.length - 1] || null, em_ordem: ordemOk(ids), folha_aberta: !!($('#folha') && !$('#folha').hidden) };
  }
  function registrar(tipo, detalhe, opcoes) {
    const op = opcoes || {}, info = TIPOS[tipo] || TIPOS.JS, c = ctx();
    const chave = tipo + '|' + (c.passo || '') + '|' + ((detalhe && detalhe.chamada) || '');
    const antes = recentes.get(chave);
    if (antes && Date.now() - antes.t < 60000 && !op.forcar) return antes.codigo;
    const codigo = gerarCodigo(tipo);
    recentes.set(chave, { t: Date.now(), codigo });
    ultimoCodigo = codigo; ultimoCodigoT = Date.now(); ls.gravar(CHAVE_ULTIMO, { c: codigo, t: ultimoCodigoT });
    mem.incidentes[tipo] = (mem.incidentes[tipo] || 0) + 1; salvarMem();
    const inc = {
      codigo, tipo, rotulo: info.rotulo, erro: info.erro, quando: new Date().toISOString(), sentinela: VERSAO, app: c.versao || null,
      conversa: c.conversa || null, passo: c.passo || null, status: c.status || null, motor: !!c.motor, tela: c.tela || null,
      detalhe: limpar(detalhe), eventos: anel.slice(-25), chamadas: rpcs.slice(-10), dom: resumoDom(),
      online: janela.navigator.onLine, janela: `${janela.innerWidth}x${janela.innerHeight}`, ua: String(janela.navigator.userAgent || '').slice(0, 140),
      aprendizado: { limiar_lento_ms: Math.round(limiarLento(amostrasEnvio())), incidentes: mem.incidentes }
    };
    guardar(anel, { t: Date.now(), k: 'incidente', tipo, codigo }, 60);
    if (info.erro || op.enviar) {
      const fila = ls.ler(CHAVE_FILA) || [];
      fila.push(inc); while (fila.length > 20) fila.shift();
      ls.gravar(CHAVE_FILA, fila);
      setTimeout(enviarFila, 50);
    }
    return codigo;
  }
  async function enviarFila() {
    if (enviando || !cfg.acoes.enviarIncidente || Date.now() < semServidorAte) return;
    let fila = ls.ler(CHAVE_FILA) || [];
    if (!fila.length) return;
    enviando = true;
    try {
      for (const inc of fila.slice(0, 3)) {
        try {
          await cfg.acoes.enviarIncidente(inc);
          fila = (ls.ler(CHAVE_FILA) || []).filter((x) => x.codigo !== inc.codigo); ls.gravar(CHAVE_FILA, fila);
        } catch (e) {
          const m = String((e && (e.code || '')) + ' ' + (e && e.message ? e.message : ''));
          if (/PGRST202|42883|404|could not find|does not exist/i.test(m)) { semServidorAte = Date.now() + 3600e3; break; }   // o SQL da Fase 9 ainda não foi aplicado: guarda e tenta mais tarde
          const f = ls.ler(CHAVE_FILA) || [], x = f.find((y) => y.codigo === inc.codigo);
          if (x) { x._n = (x._n || 0) + 1; ls.gravar(CHAVE_FILA, f.filter((y) => (y._n || 0) < 5)); }
        }
      }
    } finally { enviando = false; }
  }

  /* --- faixa de apoio (a "voz" da Sentinela) --- */
  const RANGO = { info: 1, aviso: 2, erro: 3 };
  function no(tag, cls, texto) { const e = doc.createElement(tag); if (cls) e.className = cls; if (texto != null) e.textContent = texto; return e; }
  function fechar(id) {
    if (!apoioAtual || (id && apoioAtual.id !== id)) return;
    clearTimeout(apoioTimer); apoioAtual = null;
    if (cfg.apoio) { cfg.apoio.hidden = true; cfg.apoio.replaceChildren(); }
  }
  function mostrar(c) {
    const caixa = cfg.apoio; if (!caixa) return;
    if (apoioAtual && apoioAtual.id !== c.id && RANGO[apoioAtual.nivel] > RANGO[c.nivel]) return;   // não troca um erro por um recado
    clearTimeout(apoioTimer); apoioAtual = c;
    caixa.className = 'apoio ' + c.nivel; caixa.hidden = false;
    caixa.setAttribute('role', c.nivel === 'erro' ? 'alert' : 'status');
    const filhos = [no('strong', null, c.titulo), no('p', null, c.texto)];
    if (c.codigo) {
      const p = no('p', 'ap-codigo'); p.append('Código de suporte: ', no('b', null, c.codigo), ' ');
      const cp = no('button', 'ap-btn', 'Copiar'); cp.type = 'button'; cp.style.minHeight = '36px'; cp.style.padding = '4px 10px';
      cp.addEventListener('click', () => copiarTexto(textoSuporte(c.codigo)).then((ok) => { cp.textContent = ok ? 'Copiado' : 'Anote o código'; }));
      p.append(cp); filhos.push(p);
    }
    if (c.botoes && c.botoes.length) {
      const b = no('div', 'ap-botoes');
      for (const x of c.botoes) {
        const bt = no('button', 'ap-btn' + (x.principal ? ' principal' : ''), x.rotulo); bt.type = 'button';
        bt.addEventListener('click', () => { try { x.fn && x.fn(); } finally { if (x.manter !== true) fechar(c.id); } });
        b.append(bt);
      }
      filhos.push(b);
    }
    const x = no('button', 'ap-fechar', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Fechar o aviso');
    x.addEventListener('click', () => fechar(c.id));
    filhos.push(x);
    caixa.replaceChildren(...filhos);
    if (c.auto) apoioTimer = setTimeout(() => fechar(c.id), c.auto);
  }
  const textoSuporte = (codigo) => `Código de suporte: ${codigo}\nHorário: ${new Date().toLocaleString('pt-BR')}\nChat versão ${ctx().versao || '-'}`;
  async function copiarTexto(t) {
    try { await janela.navigator.clipboard.writeText(t); return true; } catch { /* tenta o jeito antigo */ }
    try {
      const a = doc.createElement('textarea'); a.value = t; a.style.position = 'fixed'; a.style.opacity = '0'; doc.body.append(a); a.select();
      const ok = doc.execCommand('copy'); a.remove(); return !!ok;
    } catch { return false; }
  }
  // Menu "Código de suporte": mostra e copia o último código; se não houve erro, gera um de diagnóstico.
  async function copiarCodigo() {
    let cod = ultimoCodigo;   // o último erro vale por meia hora; depois disso (ou sem erro nenhum) gera um código de diagnóstico
    if (!cod || Date.now() - ultimoCodigoT > 30 * 60e3) cod = registrar('DIA', { pedido: 'menu' }, { forcar: true, enviar: true });
    mostrar({ id: 'cod', nivel: 'info', titulo: 'Seu código de suporte', texto: 'Se precisar de ajuda, informe este código à equipe: ele mostra o que aconteceu neste aparelho, sem as suas mensagens.', codigo: cod });
    return copiarTexto(textoSuporte(cod));
  }
  function oferecerAtualizacao() {
    mostrar({ id: 'ver', nivel: 'info', titulo: 'Há uma versão nova do chat', texto: 'Atualizar leva um instante e a sua conversa continua de onde está.',
      botoes: [{ rotulo: 'Atualizar agora', principal: true, fn: () => cfg.acoes.atualizarPagina && cfg.acoes.atualizarPagina() }, { rotulo: 'Depois' }] });
  }

  /* --- regras que olham a conversa --- */
  const DICAS = {
    motivo: 'Se não souber qual escolher, toque em “Falar com um atendente” que uma pessoa te ajuda.',
    exame: 'Dica: dá para tirar uma foto do pedido médico que eu leio os exames para você. Também pode procurar pelo nome.',
    consulta: 'Se tiver dúvida sobre qual consulta escolher, uma pessoa da equipe pode orientar.',
    medico: 'Se não tiver preferência de médico, tudo bem: o atendente cuida disso.',
    plano: 'Se não souber o convênio agora, pode falar com um atendente.',
    horario: 'Os horários são uma previsão. Se nenhum servir, há uma opção para o atendente procurar outro para você.',
    dados_ident: 'Pode pular o que não souber: o atendente completa depois.', dados_contato: 'Pode pular o que não souber: o atendente completa depois.',
    dados_endereco: 'Digite só o CEP que o resto se preenche sozinho. Pode pular se preferir.', dados_carteira: 'Pode pular a carteirinha: o atendente confere depois.',
    identidade: 'É só para localizar o seu cadastro. Se preferir, fale com um atendente.', confirmar: 'Confira o resumo com calma: se algo estiver errado, dá para corrigir antes de enviar.'
  };
  function agendarVerificar() { clearTimeout(verificarT); verificarT = setTimeout(seguro(verificar), T(250)); }
  const pedirAtendente = () => cfg.acoes.atendente && cfg.acoes.atendente();
  function verificar() {
    if (doc.hidden) return;
    const c = ctx(), msgs = $('#msgs'), agora = Date.now();
    if (!msgs || c.tela !== 'conversa') return;

    // 1) Mensagens fora de ordem na tela.
    const ids = [...msgs.querySelectorAll('.msg[data-id]')].map((n) => Number(n.dataset.id));
    if (!ordemOk(ids)) {
      if (!desordemDesde) { desordemDesde = agora; if (cfg.acoes.reordenar) cfg.acoes.reordenar(); }
      else if (agora - desordemDesde > T(4000) && !desordemCodigo) {
        desordemCodigo = registrar('ORD', { ids_primeiro: ids[0], ids_ultimo: ids[ids.length - 1], curado: false });
        mostrar({ id: 'ord', nivel: 'erro', titulo: 'As mensagens ficaram fora de ordem', codigo: desordemCodigo, texto: 'Vou recarregar a conversa para organizar. Se continuar assim, informe o código abaixo à equipe.',
          botoes: [{ rotulo: 'Recarregar a conversa', principal: true, fn: () => cfg.acoes.recarregar && cfg.acoes.recarregar() }] });
      }
    } else if (desordemDesde) {
      if (!desordemCodigo) {
        const codigo = registrar('ORD', { curado: true });
        mostrar({ id: 'ord', nivel: 'info', titulo: 'Organizei as mensagens', texto: 'Algumas chegaram fora de ordem e eu coloquei na sequência certa.', codigo, auto: T(8000) });
      } else fechar('ord');
      desordemDesde = 0; desordemCodigo = null;
    }

    // 2) Mensagem do paciente que não confirma, ou resposta que não vem.
    const limite = T(Math.min(limiarLento(amostrasEnvio()), 12000));
    const pend = [...msgs.querySelectorAll('.msg.pendente')];
    for (const n of pend) if (!vistoEm.has(n)) vistoEm.set(n, agora);
    const idade = pend.length ? Math.max(...pend.map((n) => agora - vistoEm.get(n))) : 0;
    const todas = [...msgs.querySelectorAll('.msg')].filter((n) => !n.classList.contains('sistema') && !n.dataset.anexo);
    const ult = todas[todas.length - 1];
    let espera = idade;
    if (!pend.length && ult && ult.classList.contains('cliente') && c.motor) {
      const chave = ult.dataset.id || '';
      if (chave !== semRespostaChave) { semRespostaChave = chave; semRespostaDesde = agora; }
      espera = agora - semRespostaDesde;
    } else if (!pend.length) { semRespostaChave = ''; semRespostaDesde = 0; }
    if (espera > limite) {
      const marca = pend[0] || ult;
      if (marca && !conferido.has(marca)) { conferido.add(marca); if (cfg.acoes.recarregar) cfg.acoes.recarregar(); }
      if (espera > limite * 2) {
        const codigo = registrar('LNT', { espera_ms: Math.round(espera), pendentes: pend.length });
        mostrar({ id: 'lnt', nivel: 'erro', titulo: 'A resposta está demorando', codigo, texto: 'Peço desculpas pela espera. Sua mensagem não se perdeu: já estou conferindo. Se preferir, uma pessoa da equipe pode continuar com você.',
          botoes: [{ rotulo: 'Conferir de novo', principal: true, fn: () => cfg.acoes.recarregar && cfg.acoes.recarregar(), manter: true }, { rotulo: 'Chamar um atendente', fn: pedirAtendente }] });
      } else mostrar({ id: 'lnt', nivel: 'aviso', titulo: 'Está demorando um pouco mais que o normal', texto: 'Estou conferindo se a sua mensagem chegou. Um instante, por favor.' });
    } else if (apoioAtual && apoioAtual.id === 'lnt' && !pend.length) fechar('lnt');

    // 3) Pergunta ativa com todos os botões desligados e nenhuma chamada em andamento (tela travada).
    if (ult && ult.classList.contains('agente') && c.motor && !c.folhaAberta) {
      const w = ult.querySelector('.widget:not([data-tipo="acompanhar"]):not([data-tipo="nova"])');
      if (w && !w.classList.contains('respondido')) {
        const ctrl = [...w.querySelectorAll('button,input,select')].filter((x) => !x.hidden);
        if (ctrl.length && ctrl.every((x) => x.disabled) && emVoo === 0) {
          const ini = travadoDesde.get(w);
          if (!ini) { travadoDesde.set(w, agora); }
          else if (agora - ini > T(5000) && !travaCurada) {
            travaCurada = { w, t: agora };
            if (cfg.acoes.destravar) cfg.acoes.destravar();
            if (cfg.acoes.recarregar) cfg.acoes.recarregar();
          } else if (travaCurada && travaCurada.w === w && agora - travaCurada.t > T(5000)) {
            const codigo = registrar('TRV', { curado: false, passo: c.passo });
            mostrar({ id: 'trv', nivel: 'erro', titulo: 'A tela travou nesta pergunta', codigo, texto: 'Peço desculpas! Tente recarregar a conversa. Se não resolver, uma pessoa da equipe continua com você.',
              botoes: [{ rotulo: 'Recarregar a conversa', principal: true, fn: () => cfg.acoes.recarregar && cfg.acoes.recarregar() }, { rotulo: 'Chamar um atendente', fn: pedirAtendente }] });
          }
        } else {
          if (travaCurada && travaCurada.w === w) { registrar('TRV', { curado: true, passo: c.passo }); travaCurada = null; fechar('trv'); }
          travadoDesde.delete(w);
        }
      }
    }

    // 4) Paciente parado na mesma pergunta: oferece ajuda (uma vez por pergunta).
    if (c.perguntaAberta && c.passo && passoDesde && passoDesde.passo === c.passo && !paradoAvisado.has((c.conversa || '') + ':' + c.passo)) {
      const lim = T(limiarParado(mem.passo[c.passo]));
      if (agora - ultimaInteracao > lim && agora - passoDesde.t > lim && (!apoioAtual || RANGO[apoioAtual.nivel] <= 1)) {
        paradoAvisado.add((c.conversa || '') + ':' + c.passo);
        mem.parados[c.passo] = (mem.parados[c.passo] || 0) + 1; salvarMem();
        mostrar({ id: 'par', nivel: 'info', titulo: 'Posso ajudar?', texto: DICAS[c.passo] || 'Se estiver difícil por aqui, uma pessoa da equipe pode continuar com você.',
          botoes: [{ rotulo: 'Chamar um atendente', principal: true, fn: pedirAtendente }, { rotulo: 'Vou continuar' }] });
      }
    }

    // 5) Conversa que ficou aberta há muito tempo com uma pergunta esperando.
    if (c.conversa && antigaAvisada !== c.conversa && c.perguntaAberta && c.status === 'aguardando' && c.ultimaMsgEm) {
      const idadeConversa = Date.now() - new Date(c.ultimaMsgEm).getTime();
      antigaAvisada = c.conversa;
      if (idadeConversa > T(6 * 3600e3)) {
        mostrar({ id: 'ant', nivel: 'aviso', titulo: 'Esta conversa ficou parada há um tempo', texto: 'Quer continuar de onde parou ou prefere começar um pedido novo? Os dados que você já informou não se perdem.',
          botoes: [{ rotulo: 'Continuar de onde parei', principal: true }, { rotulo: 'Começar um pedido novo', fn: () => cfg.acoes.novoPedido && cfg.acoes.novoPedido() }] });
      }
    }
  }

  /* --- ligação com a página --- */
  function injetarEstilo() {
    if (doc.getElementById('sentinela-estilo')) return;
    const st = doc.createElement('style'); st.id = 'sentinela-estilo';
    st.textContent = '.apoio{flex:none;margin:0 10px 8px;padding:12px 14px;border-radius:14px;border:1.5px solid #a9d8bd;background:#eef8f2;color:#16231f;font-size:calc(16px * var(--esc,1));line-height:1.4;position:relative;max-height:50vh;overflow-y:auto}'
      + '.apoio[hidden]{display:none}.apoio.aviso{background:#fff7e5;border-color:#f0dfb8}.apoio.erro{background:#fff3f1;border-color:#e8b4ae}'
      + '.apoio strong{display:block;margin:0 32px 4px 0}.apoio p{margin:0 0 8px}'
      + '.apoio .ap-fechar{position:absolute;top:4px;right:4px;width:40px;height:40px;border:0;background:transparent;font-size:26px;line-height:1;cursor:pointer;color:inherit}'
      + '.apoio .ap-botoes{display:flex;gap:8px;flex-wrap:wrap}'
      + '.apoio .ap-btn{min-height:46px;padding:10px 14px;border-radius:12px;border:1.5px solid #146b50;background:#fff;color:#146b50;font:inherit;font-weight:650;cursor:pointer}'
      + '.apoio .ap-btn.principal{background:#146b50;color:#fff}'
      + '.apoio .ap-codigo{font-size:calc(14.5px * var(--esc,1));color:#5b6b65}'
      + '.apoio .ap-codigo b{font-family:ui-monospace,Menlo,Consolas,monospace;color:#16231f;user-select:all;word-break:break-all}';
    doc.head.append(st);
  }
  function aoErroJs(ev) {
    const msg = mascarar((ev && (ev.message || (ev.reason && (ev.reason.message || ev.reason)))) || 'erro');
    if (ev && ev.target && ev.target !== janela) return;   // falha de imagem/script de terceiros não é erro do chat
    const arquivo = String((ev && ev.filename) || ''), nosso = !arquivo || arquivo.includes(janela.location.host) || /sentinela|index/.test(arquivo);
    const codigo = registrar('JS', { erro: msg, arquivo: arquivo.split('/').pop(), linha: ev && ev.lineno });
    if (nosso && !/ResizeObserver|Script error/i.test(msg)) {
      mostrar({ id: 'js', nivel: 'erro', titulo: 'Algo não saiu como esperado', codigo, texto: 'Peço desculpas! Se a tela parar de responder, recarregue a conversa. Se precisar de ajuda, informe o código abaixo à equipe.',
        botoes: [{ rotulo: 'Recarregar a conversa', principal: true, fn: () => cfg.acoes.recarregar && cfg.acoes.recarregar() }] });
    }
  }
  function iniciar(opcoes) {
    if (iniciada) { Object.assign(cfg, opcoes || {}); return; }
    iniciada = true;
    cfg = Object.assign(cfg, opcoes || {});
    if (!cfg.apoio) { cfg.apoio = $('#apoio'); }
    if (!cfg.apoio) { cfg.apoio = no('div', 'apoio'); cfg.apoio.id = 'apoio'; cfg.apoio.hidden = true; const f = $('#formEnviar'); if (f && f.parentNode) f.parentNode.insertBefore(cfg.apoio, f); else doc.body.append(cfg.apoio); }
    injetarEstilo();
    janela.addEventListener('error', seguro(aoErroJs));
    janela.addEventListener('unhandledrejection', seguro(aoErroJs));
    janela.addEventListener('offline', seguro(() => mostrar({ id: 'net', nivel: 'aviso', titulo: 'Sem conexão com a internet', texto: 'Não se preocupe: o que você já fez está guardado. Assim que a internet voltar eu atualizo a conversa sozinho.' })));
    janela.addEventListener('online', seguro(() => { fechar('net'); enviarFila(); }));
    for (const ev of ['pointerdown', 'keydown', 'input', 'touchstart']) doc.addEventListener(ev, () => { ultimaInteracao = Date.now(); }, { capture: true, passive: true });
    doc.addEventListener('scroll', () => { ultimaInteracao = Date.now(); }, { capture: true, passive: true });
    doc.addEventListener('visibilitychange', seguro(() => { if (!doc.hidden) { agendarVerificar(); enviarFila(); } }));
    const msgs = $('#msgs');
    if (msgs && janela.MutationObserver) new janela.MutationObserver(agendarVerificar).observe(msgs, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled'] });
    tick = setInterval(seguro(verificar), T(1500));
    setTimeout(seguro(verificar), T(1200));
    setTimeout(enviarFila, T(3000));
  }
  function relatorio() {
    const rpc = {}, passos = {};
    for (const [n, a] of Object.entries(mem.rpc)) rpc[n] = { amostras: a.length, p50_ms: percentil(a, 0.5), p90_ms: percentil(a, 0.9), limite_lento_ms: Math.round(limiarLento(a)) };
    for (const [p, a] of Object.entries(mem.passo)) passos[p] = { amostras: a.length, mediana_s: mediana(a), limite_parado_s: Math.round(limiarParado(a) / 1000), vezes_parado: mem.parados[p] || 0 };
    return { sentinela: VERSAO, ultimo_codigo: ultimoCodigo, incidentes: mem.incidentes, chamadas: rpc, etapas: passos, fila_pendente: (ls.ler(CHAVE_FILA) || []).length };
  }

  envolverFetch();   // antes do createClient do Supabase: ele guarda o fetch que existir nesse momento
  return Object.assign({ iniciar, evento, erro: (t, d) => registrar(t, d), copiarCodigo, oferecerAtualizacao, relatorio, ultimoCodigo: () => ultimoCodigo }, PURO);
});
