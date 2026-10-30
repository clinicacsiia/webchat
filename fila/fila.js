// FLUXOGRAMA: entrada (?token= na URL, JWT assinado pelo n8n) -> validação (token presente, claims legíveis, exp no cliente; o servidor revalida assinatura, exp, atendimento e hash) -> lógica (Realtime com o JWT do paciente: postgres_changes da própria linha + broadcast privado fila:global; posição por fila_minha_posicao; Canvas com Pointer Events; SHA-256 do texto exibido; POST à API de biometria) -> saída (uma tela por vez: fila, assinatura, concluído, bloqueado, expirado ou erro)
// Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
(() => {
  'use strict';

  const CONFIG = {
    supabaseUrl: 'https://nrvuynjwcgwpjdptkiay.supabase.co',
    supabaseKey: 'sb_publishable_e2GK1YGEj06STa_ESCevow_nvtATB-y',
    biometriaApi: 'https://SEU-SERVIDOR-BIOMETRIA',   // URL pública da API Python (api-biometria/app.py)
    chaveSessao: 'fila_token',
    minPontos: 20,
    atrasoPosicaoMs: 300,
    larguraTraco: 2.5,
  };

  const ESTADOS = ['carregando', 'fila', 'assinatura', 'concluido', 'bloqueado', 'expirado', 'erro'];

  const estado = {
    token: null,
    claims: null,
    atendimentoId: null,
    status: null,
    documento: null,
    tracos: [],
    desenhando: false,
    enviando: false,
    podeAssinar: false,
    inicioMs: null,
    timerPosicao: null,
    timerExpiracao: null,
  };

  let db = null;
  let tokenMemoria = null;

  const el = (id) => document.getElementById(id);
  const canvas = el('assinatura');
  const ctx = canvas.getContext('2d');

  function mostrar(nome) {
    for (const item of ESTADOS) {
      el(`estado-${item}`).hidden = item !== nome;
    }
  }

  function mensagem(texto) {
    el('assinatura-msg').textContent = texto;
  }

  // Lê o token da URL uma vez, tira da barra de endereço e guarda só na sessão da aba.
  function lerToken() {
    const url = new URL(window.location.href);
    const recebido = url.searchParams.get('token');
    if (recebido) {
      url.searchParams.delete('token');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      tokenMemoria = recebido;
      try {
        sessionStorage.setItem(CONFIG.chaveSessao, recebido);
      } catch (_) {
        // navegador sem sessionStorage (modo privado restrito): segue só com a memória da aba
      }
      return tokenMemoria;
    }
    if (tokenMemoria) return tokenMemoria;
    try {
      return sessionStorage.getItem(CONFIG.chaveSessao);
    } catch (_) {
      return null;
    }
  }

  // Só lê o payload para decidir a tela. Não verifica assinatura: quem verifica é o servidor.
  function lerClaims(token) {
    try {
      const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const preenchido = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      const bytes = Uint8Array.from(atob(preenchido), (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (_) {
      return null;
    }
  }

  async function sha256Hex(texto) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function agendarExpiracao(exp) {
    clearTimeout(estado.timerExpiracao);
    const restanteMs = exp * 1000 - Date.now();
    estado.timerExpiracao = setTimeout(() => mostrar('expirado'), Math.max(restanteMs, 0));
  }

  function criarCliente(token) {
    // accessToken faz o REST e o Realtime usarem o JWT do paciente; a chave publicável só identifica o projeto.
    return window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
      accessToken: async () => token,
    });
  }

  // ----- Realtime -----

  function assinarCanais() {
    db.channel(`atendimento-${estado.atendimentoId}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'atendimentos', filter: `id=eq.${estado.atendimentoId}` },
        (mudanca) => aplicarStatus(mudanca.new.status))
      .subscribe();

    // Aviso sem dados pessoais: "a fila mudou". A posição real vem da RPC, que devolve só números.
    db.channel('fila:global', { config: { private: true } })
      .on('broadcast', { event: 'fila_mudou' }, () => agendarPosicao())
      .subscribe((situacao) => {
        if (situacao === 'SUBSCRIBED') agendarPosicao();
      });
  }

  function agendarPosicao() {
    clearTimeout(estado.timerPosicao);
    estado.timerPosicao = setTimeout(atualizarPosicao, CONFIG.atrasoPosicaoMs);
  }

  async function atualizarPosicao() {
    const { data, error } = await db.rpc('fila_minha_posicao');
    if (error || !data) return;
    if (data.status !== estado.status) {
      aplicarStatus(data.status);
      return;
    }
    if (data.status !== 'aguardando') return;
    el('posicao-texto').textContent = data.a_frente === 0 ? 'Você é o próximo' : `${data.a_frente + 1}º da fila`;
    el('total-texto').textContent = `Pessoas aguardando agora: ${data.aguardando}`;
  }

  // ----- Estados -----

  async function aplicarStatus(status) {
    estado.status = status;
    if (status === 'aguardando') {
      mostrar('fila');
      agendarPosicao();
      return;
    }
    if (status === 'assinatura_pendente') {
      await abrirAssinatura();
      return;
    }
    if (status === 'em_atendimento' || status === 'concluido') {
      mostrar('concluido');
      return;
    }
    mostrar('erro');
  }

  async function recarregarStatus() {
    const { data, error } = await db.from('atendimentos').select('id, status').maybeSingle();
    if (error || !data) {
      mostrar('erro');
      return;
    }
    await aplicarStatus(data.status);
  }

  async function abrirAssinatura() {
    const { data, error } = await db
      .from('atendimentos')
      .select('documento_texto, documento_hash, bloqueado_em')
      .maybeSingle();
    if (error || !data) {
      mostrar('erro');
      return;
    }
    if (data.bloqueado_em) {
      mostrar('bloqueado');
      return;
    }
    estado.documento = data.documento_texto;
    el('documento').textContent = data.documento_texto;
    limparCanvas();
    mostrar('assinatura');
    dimensionarCanvas();
    atualizarBotao();
  }

  // ----- Canvas (Pointer Events) -----

  function corTinta() {
    return getComputedStyle(document.documentElement).getPropertyValue('--cor-tinta').trim() || '#10302B';
  }

  function dimensionarCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redesenhar();
  }

  function redesenhar() {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    for (const traco of estado.tracos) {
      for (let i = 1; i < traco.length; i++) {
        desenharSegmento(traco[i - 1], traco[i]);
      }
    }
  }

  function desenharSegmento(a, b) {
    const largura = canvas.clientWidth;
    const altura = canvas.clientHeight;
    ctx.strokeStyle = corTinta();
    ctx.lineWidth = CONFIG.larguraTraco;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x * largura, a.y * altura);
    ctx.lineTo(b.x * largura, b.y * altura);
    ctx.stroke();
  }

  function coordenadasNormalizadas(evento) {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.min(Math.max((evento.clientX - r.left) / r.width, 0), 1),
      y: Math.min(Math.max((evento.clientY - r.top) / r.height, 0), 1),
    };
  }

  // Usa getCoalescedEvents quando existe: captura todas as amostras entre dois frames.
  function registrarAmostras(evento) {
    const indice = estado.tracos.length - 1;
    const traco = estado.tracos[indice];
    const lista = typeof evento.getCoalescedEvents === 'function' ? evento.getCoalescedEvents() : [];
    for (const amostra of lista.length ? lista : [evento]) {
      if (estado.inicioMs === null) estado.inicioMs = amostra.timeStamp;
      const { x, y } = coordenadasNormalizadas(amostra);
      const ponto = {
        x,
        y,
        timestamp: Math.round(amostra.timeStamp - estado.inicioMs),
        pressao: amostra.pressure || 0,
        traco: indice,
      };
      const anterior = traco[traco.length - 1];
      traco.push(ponto);
      if (anterior) desenharSegmento(anterior, ponto);
    }
    atualizarBotao();
  }

  function limparCanvas() {
    estado.tracos = [];
    estado.desenhando = false;
    estado.inicioMs = null;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    atualizarBotao();
  }

  function atualizarBotao() {
    const consentiu = el('consentimento').checked;
    estado.podeAssinar = consentiu && !estado.enviando && Boolean(estado.documento);
    canvas.classList.toggle('desabilitado', !estado.podeAssinar);
    const pontos = estado.tracos.reduce((soma, traco) => soma + traco.length, 0);
    el('enviar').disabled = !estado.podeAssinar || pontos < CONFIG.minPontos;
  }

  canvas.addEventListener('pointerdown', (evento) => {
    if (!estado.podeAssinar) return;
    canvas.setPointerCapture(evento.pointerId);
    estado.desenhando = true;
    estado.tracos.push([]);
    registrarAmostras(evento);
  });

  canvas.addEventListener('pointermove', (evento) => {
    if (estado.desenhando) registrarAmostras(evento);
  });

  // Redimensionar o canvas zera o bitmap: redesenha os traços já feitos, em coordenadas normalizadas.
  window.addEventListener('resize', () => {
    if (!el('estado-assinatura').hidden) dimensionarCanvas();
  });

  for (const tipo of ['pointerup', 'pointercancel']) {
    canvas.addEventListener(tipo, (evento) => {
      if (!estado.desenhando) return;
      if (tipo === 'pointerup') registrarAmostras(evento);
      estado.desenhando = false;
      atualizarBotao();
    });
  }

  // ----- Envio -----

  async function enviarAssinatura() {
    if (estado.enviando) return;
    estado.enviando = true;
    atualizarBotao();
    mensagem('Enviando…');
    try {
      const hashDocumento = await sha256Hex(estado.documento);
      const resposta = await fetch(`${CONFIG.biometriaApi}/v1/assinatura/validar`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${estado.token}`,
        },
        body: JSON.stringify({
          pontos: estado.tracos.flat(),
          hash_documento: hashDocumento,
          consentimento: el('consentimento').checked,
          user_agent: navigator.userAgent,
        }),
      });
      await tratarResposta(resposta);
    } catch (_) {
      mensagem('Sem conexão com o servidor. Tente de novo.');
    } finally {
      estado.enviando = false;
      atualizarBotao();
    }
  }

  async function tratarResposta(resposta) {
    if (resposta.status === 401) {
      mostrar('expirado');
      return;
    }
    if (resposta.status === 423) {
      mostrar('bloqueado');
      return;
    }
    if (resposta.status === 409) {
      mensagem('O documento mudou ou a assinatura não está aberta. Atualizando…');
      await recarregarStatus();
      return;
    }
    if (resposta.status === 422) {
      limparCanvas();
      mensagem('Não deu para ler a assinatura. Assine novamente com um traço mais completo.');
      return;
    }
    if (!resposta.ok) {
      mensagem('Não foi possível registrar agora. Tente de novo.');
      return;
    }
    const corpo = await resposta.json();
    if (corpo.aprovado) {
      mostrar('concluido');
      return;
    }
    if (corpo.bloqueado) {
      mostrar('bloqueado');
      return;
    }
    limparCanvas();
    mensagem(`Assinatura não reconhecida. Restam ${corpo.tentativas_restantes} tentativa(s).`);
  }

  // ----- Inicialização -----

  async function iniciar() {
    if (!window.supabase) {
      mostrar('erro');
      return;
    }
    const token = lerToken();
    const claims = token ? lerClaims(token) : null;
    if (!claims || !claims.atendimento_id || !claims.exp || claims.exp * 1000 <= Date.now()) {
      mostrar('expirado');
      return;
    }
    estado.token = token;
    estado.claims = claims;
    estado.atendimentoId = claims.atendimento_id;
    agendarExpiracao(claims.exp);
    db = criarCliente(token);

    el('consentimento').addEventListener('change', atualizarBotao);
    el('limpar').addEventListener('click', limparCanvas);
    el('enviar').addEventListener('click', enviarAssinatura);

    // Assina antes de ler, para não perder uma mudança que aconteça entre a leitura e a assinatura.
    assinarCanais();
    const { data, error, status } = await db.from('atendimentos').select('id, status').maybeSingle();
    if (status === 401 || status === 403 || (!error && !data)) {
      mostrar('expirado');
      return;
    }
    if (error) {
      mostrar('erro');
      return;
    }
    await aplicarStatus(data.status);
  }

  iniciar().catch(() => mostrar('erro'));
})();
