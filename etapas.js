/* CSI WebChat — sistema de marcação por ETAPAS (produção).
   FLUXOGRAMA: entrada (o "Começar" do chat, SÓ quando config.marcacao_etapas_modo deixa; o chat já criou a conversa com chat_iniciar, com PIN e aceite)
     -> validação (cada resposta vai por chat_responder / chat_consulta_salvar / chat_horario_escolher: as MESMAS funções e travas do chat de hoje; a ordem das perguntas é a do motor `fluxo_proximo`)
     -> lógica (esta tela só DESENHA a pergunta que o servidor mandou, uma por vez; nenhuma regra de negócio mora aqui; o que ela não entende vai para o chat de hoje, na MESMA conversa)
     -> saída (a marcação é feita pelo motor e por klingo-executar; a equipe vê tudo no painel como sempre)
   Versão 1.0 — 24/11/2026 / Mudança: primeira versão (integração do sistema de marcação por etapas; ver docs/integracao-marcacao-por-etapas.md).
   Contrato com index.html: window.CSI_ETAPAS.abrir({ db, conv, respostas, ident, aoChat, aoPin, aoNova }). */
(function () {
  'use strict';
  const h = (tag, at, ...fil) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(at || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
    }
    for (const f of fil.flat()) if (f != null && f !== false) e.append(f.nodeType ? f : document.createTextNode(String(f)));
    return e;
  };
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const pl = (n, um, varios) => n + ' ' + (n === 1 ? um : (varios || um + 's'));
  const dataBonita = (d) => { const [y, m, dd] = String(d).split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }); };
  const WHATS = 'https://wa.me/5571999803806';
  // Etapa mostrada na barra de progresso (aproximada: a ordem real é a do servidor).
  const ETAPAS = {
    cpf_confirma: ['Seus dados', 1], cpf_nasc: ['Seus dados', 1], identidade: ['Seus dados', 1], atalho: ['Início', 1], motivo: ['Início', 1], consulta: ['Consulta', 2], medico: ['Médico(a)', 3],
    plano: ['Pagamento', 4], plano_exato: ['Plano', 4], plano_confirma: ['Plano', 4], horario: ['Horário', 5], horario_oferta: ['Horário', 5],
    previsao_turno: ['Preferências', 5], previsao_periodo: ['Preferências', 5], previsao_decide: ['Preferências', 5], previsao_antecedencia: ['Preferências', 5],
    mudou: ['Seus dados', 6], dados_ident: ['Seus dados', 6], dados_contato: ['Contato', 6], dados_endereco: ['Endereço', 6], dados_carteira: ['Carteirinha', 6], confirmar: ['Conferir', 7], valor: ['Valor', 7]
  };
  const TOTAL = 7;
  let C = null, raiz, corpo, rodape, progTxt, progBarra, btnVoltar;   // C = estado desta abertura

  const rpc = async (nome, args) => { const { data, error } = await C.db.rpc(nome, args); if (error) throw error; return data; };
  const msgErro = (e) => {
    const t = String((e && e.message) || e || '');
    if (/pin_obrigatorio/.test(t)) return 'PIN';
    if (/Failed to fetch|NetworkError|Load failed/i.test(t)) return 'Sem conexão. Confira a internet e tente de novo.';
    return t && t.length < 220 ? t : 'Não foi possível concluir agora. Tente de novo.';
  };
  const falhou = (e) => { const m = msgErro(e); if (m === 'PIN') { if (C && C.aoPin) C.aoPin(); return; } erro(m); };
  const erro = (m) => { const el = document.getElementById('etpErro'); if (el) el.textContent = m || ''; };

  /* ---------- casca ---------- */
  function montar() {
    if (raiz) return;
    btnVoltar = h('button', { class: 'marc-ic', type: 'button', 'aria-label': 'Voltar', onclick: voltar }, '←');
    progTxt = h('span'); progBarra = h('i');
    corpo = h('main', { class: 'marc-corpo', id: 'etpCorpo', 'aria-live': 'polite' });
    rodape = h('footer', { class: 'marc-rodape' });
    raiz = h('div', { id: 'marc', hidden: true, role: 'region', 'aria-label': 'Marcação de consulta' },
      h('header', { class: 'marc-topo' }, btnVoltar, h('img', { src: 'img/logo-csi-simbolo.svg', alt: 'CSI' }), h('span', { class: 'esp' }),
        h('button', { class: 'marc-humano', type: 'button', id: 'etpChat', onclick: () => irParaChat() }, 'Falar com a equipe')),
      h('div', { class: 'marc-prog', id: 'etpProg' }, h('div', { class: 'txt' }, progTxt), h('div', { class: 'barra', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, progBarra)),
      corpo, rodape);
    document.body.append(raiz);
  }
  function tela(titulo, sub, conteudo, { botoes = [], passo = null, progresso = true, voltar: v = false } = {}) {
    document.getElementById('etpProg').hidden = !progresso;
    if (progresso && passo && ETAPAS[passo]) {
      const [nome, n] = ETAPAS[passo], pct = Math.round(n / TOTAL * 100);
      progTxt.textContent = `Etapa ${n} de ${TOTAL} · ${nome}`; progBarra.style.width = pct + '%'; progBarra.parentNode.setAttribute('aria-valuenow', pct);
    }
    btnVoltar.hidden = !v;
    corpo.replaceChildren(...[titulo ? h('h1', { tabindex: '-1', id: 'etpTitulo' }, titulo) : null, sub ? h('p', { class: 'sub', style: 'white-space:pre-line' }, sub) : null, conteudo,
      h('p', { class: 'marc-erro', id: 'etpErro', role: 'alert' })].filter(Boolean));
    rodape.replaceChildren(...botoes.filter(Boolean));
    corpo.scrollTop = 0;
    setTimeout(() => { const t = document.getElementById('etpTitulo'); if (t) t.focus({ preventScroll: true }); }, 30);
  }
  const carregando = (t = 'Só um instante…') => tela(null, null, h('div', { 'aria-busy': 'true' }, h('p', { class: 'sub' }, t), h('div', { class: 'marc-esq' }), h('div', { class: 'marc-esq' })), { progresso: false });
  const botao = (rot, fn, cls = '', extra = {}) => h('button', Object.assign({ class: 'marc-bt ' + cls, type: 'button', onclick: fn }, extra), rot);
  const opcao = ({ titulo, detalhe, sel, onclick }) => h('button', { class: 'marc-op', type: 'button', role: 'radio', 'aria-checked': String(!!sel), onclick }, h('span', { class: 'tx' }, h('b', {}, titulo), detalhe ? h('small', {}, detalhe) : null));

  /* ---------- sair para o chat de hoje (a MESMA conversa) ---------- */
  function irParaChat() { parar(); fechar(); if (C && C.aoChat) C.aoChat(); }
  function fechar() { if (raiz) raiz.hidden = true; document.body.classList.remove('marc-aberta'); }
  function parar() { if (C && C.timer) { clearInterval(C.timer); C.timer = null; } if (C) C.sessao = (C.sessao || 0) + 1; }

  /* ---------- receber o que o servidor mandou ---------- */
  function receber(lista) {
    const novas = (lista || []).filter((m) => m && m.id != null && m.id > C.ultimoId);
    if (!novas.length) return false;
    C.ultimoId = Math.max(C.ultimoId, ...novas.map((m) => m.id));
    const agente = novas.filter((m) => m.autor === 'agente');
    if (!agente.length) return false;
    const pergunta = [...agente].reverse().find((m) => m.opcoes && typeof m.opcoes === 'object');
    C.avisos = agente.filter((m) => !m.opcoes && m.texto && (!pergunta || m.id < pergunta.id)).map((m) => m.texto);
    C.atual = pergunta || { texto: agente.at(-1).texto, opcoes: null };
    return true;
  }
  async function sincronizar(desde = C.ultimoId) {
    const r = await rpc('chat_listar', { p_conversa: C.conv.id, p_token: C.conv.token, p_apos: desde });
    C.motorAtivo = r.motor_ativo !== false;
    if (r.status && r.status !== 'aguardando') C.motorAtivo = false;
    receber(r.mensagens);
    return r;
  }
  async function aposResposta(r) {
    if (r && Array.isArray(r.respostas) && r.respostas.length) receber(r.respostas); else await sincronizar();
    desenhar();
  }
  async function responder(passo, valor, texto) {
    if (C.ocupado) return; C.ocupado = true; erro('');
    document.querySelectorAll('#marc button').forEach((b) => { b.dataset.eraOk = b.disabled ? '0' : '1'; b.disabled = true; });
    try {
      const r = await rpc('chat_responder', { p_conversa: C.conv.id, p_token: C.conv.token, p_passo: passo, p_valor: valor, p_texto: texto || null });
      C.ocupado = false; await aposResposta(r);
    } catch (e) {
      C.ocupado = false;
      if (e && e.code === '22023') { try { C.ultimoId = 0; await sincronizar(0); desenhar(); return; } catch { /* cai no aviso abaixo */ } }   // a pergunta já mudou (outra aba, equipe): relê a conversa
      document.querySelectorAll('#marc button').forEach((b) => { if (b.dataset.eraOk === '1') b.disabled = false; });
      falhou(e);
    }
  }
  async function voltar() {
    if (C.ocupado) return; C.ocupado = true;
    try { const r = await rpc('chat_voltar', { p_conversa: C.conv.id, p_token: C.conv.token }); C.ocupado = false; await aposResposta(r); }
    catch (e) { C.ocupado = false; if (e && e.code === '22023') erro('Não deu para voltar agora.'); else falhou(e); }
  }

  /* ---------- o que desenhar ---------- */
  function desenhar() {
    parar(); montar(); raiz.hidden = false; document.body.classList.add('marc-aberta');
    const a = C.atual;
    raiz.dataset.passo = a && a.opcoes ? (a.opcoes.passo || a.opcoes.tipo || '') : (a ? 'texto' : '');   // ajuda os testes e o suporte a saber em que pergunta a pessoa está
    if (!a) { carregando(); return; }
    if (!C.motorAtivo) { telaEquipe(a); return; }
    const o = a.opcoes;
    if (!o) { telaTexto(a); return; }
    if (o.tipo === 'escolha') {
      if (o.passo === 'motivo' && !C.autoMotivo && (o.itens || []).some((i) => i.valor === 'consulta')) { C.autoMotivo = true; responder('motivo', 'consulta', 'Consulta'); return; }   // este sistema é só de consultas
      telaEscolha(a); return;
    }
    if (o.tipo === 'campos') { telaCampos(a); return; }
    if (o.tipo === 'pedido_consulta') { telaConsulta(a); return; }
    if (o.tipo === 'calendario') { telaCalendario(a); return; }
    if (o.tipo === 'marcando' || o.tipo === 'espera') { telaAguardar(a); return; }
    if (o.tipo === 'marcado' || o.tipo === 'acompanhar' || o.tipo === 'nova' || o.tipo === 'despedida') { telaFim(a); return; }
    telaTexto(a);   // qualquer coisa que esta tela não conhece: texto e o caminho do chat de hoje
  }
  const titulo = (a, pad) => { const o = a.opcoes; return (o && ETAPAS[o.passo] && ETAPAS[o.passo][0]) || pad; };
  const avisosDe = () => (C.avisos && C.avisos.length ? h('div', { class: 'marc-aviso' }, C.avisos.join('\n')) : null);
  const voltarOk = (a) => !!(a.opcoes && ETAPAS[a.opcoes.passo] && a.opcoes.passo !== 'cpf_nasc' && a.opcoes.passo !== 'cpf_confirma');

  function telaTexto(a) {
    tela('Continue no chat', a.texto, h('div', {}, avisosDe(), h('p', { class: 'marc-info' }, 'Esta etapa continua no chat da clínica, na mesma conversa, sem perder nada.')),
      { progresso: false, botoes: [botao('Continuar no chat', irParaChat)] });
  }
  function telaEquipe(a) {
    tela('A equipe está com o seu pedido', a.texto || 'Uma pessoa da equipe assumiu a conversa.', h('div', {}), { progresso: false, botoes: [botao('Abrir a conversa', irParaChat)] });
  }

  // ----- pré-marcação: quando o paciente "não sabe o plano" ou "nenhum horário serve", o pedido vai para a equipe CONFIRMAR. Antes, a ciência é gravada NO SERVIDOR.
  function preMarcacao(motivo, enviar, a) {
    const aparelho = () => {
      const n = navigator, ua = n.userAgent || '', am = ua.match(/Android\s([\d.]+)(?:;\s*([^)]+))?/); let fuso = ''; try { fuso = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* ignora */ }
      return { aparelho: am ? `Android ${am[1]}${am[2] ? ' · ' + am[2].replace(/\sBuild.*$/, '') : ''}` : (n.platform || 'não identificado'), idioma: n.language || '', tela: `${screen.width}x${screen.height}`, fuso };
    };
    tela('Quer deixar uma pré-marcação?', 'Ainda não dá para marcar o horário agora.', h('div', {},
      h('div', { class: 'marc-aviso' }, h('b', {}, 'A equipe vai confirmar com você: '), motivo),
      h('p', { class: 'marc-forte' }, 'A pré-marcação ', h('b', {}, 'não garante o horário'), '. Ele só vale depois que a equipe confirmar com você.'),
      h('button', { class: 'marc-bt vermelho', type: 'button', id: 'etpCiente', style: 'width:100%', onclick: async (ev) => {
        const b = ev.currentTarget; b.disabled = true; erro('');
        try { await rpc('marcacao_ciencia_registrar', { p_conversa: C.conv.id, p_token: C.conv.token, p_aparelho: aparelho(), p_motivo: motivo }); }
        catch (e) { b.disabled = false; falhou(e); return; }
        enviar();
      } }, 'Estou ciente: é uma pré-marcação e não garante o horário'),
      h('button', { class: 'marc-link', type: 'button', id: 'etpNaoPre', onclick: () => responder(a.opcoes.passo, { acao: 'atendente' }, null) }, 'Não, obrigado: quero falar com a equipe')),
    { passo: a.opcoes.passo, voltar: true, botoes: [botao('Voltar', () => desenhar(), 'sec')] });
  }

  function telaEscolha(a) {
    const o = a.opcoes, itens = o.itens || [];
    let q = '';
    const lista = h('div', { class: 'marc-lista', role: 'radiogroup' });
    const escolher = (it) => {
      if (o.passo === 'plano_exato' && it.valor === 'nao_sei') { preMarcacao('Plano do convênio', () => responder(o.passo, it.valor, it.rotulo), a); return; }
      responder(o.passo, it.valor, it.rotulo);
    };
    const pintar = () => {
      const vis = itens.filter((i) => !q || norm(i.rotulo + ' ' + (i.desc || '')).includes(q));
      lista.replaceChildren(...(vis.length ? vis.map((i) => opcao({ titulo: i.rotulo, detalhe: i.desc, onclick: () => escolher(i) })) : [h('p', { class: 'sub' }, 'Nada encontrado. Tente outra palavra.')]));
    };
    const busca = o.filtro ? h('input', { class: 'marc-busca', type: 'search', placeholder: 'Buscar pelo nome', 'aria-label': 'Buscar', autocomplete: 'off', oninput: (e) => { q = norm(e.target.value.trim()); pintar(); } }) : null;
    pintar();
    let outro = null;
    if (o.outro) {
      const campo = h('input', { class: 'marc-busca', type: 'text', maxlength: 80, placeholder: o.outro.placeholder || 'Escreva aqui', 'aria-label': o.outro.rotulo, style: 'margin-top:10px' });
      outro = h('details', {}, h('summary', { class: 'marc-link' }, o.outro.rotulo), campo,
        h('button', { class: 'marc-bt sec', type: 'button', style: 'margin-top:8px', onclick: () => { const t = campo.value.trim(); if (t.length < 2) { erro('Escreva o nome.'); return; } responder(o.passo, { outro: t }, t); } }, 'Enviar'));
    }
    const dest = o.destaque ? h('div', { class: 'marc-card' }, h('b', {}, o.destaque.titulo), h('p', { style: 'font-size:26px;font-weight:800;margin:6px 0' }, o.destaque.valor), h('ul', { class: 'marc-regras' }, ...(o.destaque.linhas || []).map((l) => h('li', {}, l)))) : null;
    const resumo = o.passo === 'confirmar' ? h('div', { class: 'marc-card', style: 'white-space:pre-line' }, a.texto) : null;
    tela(titulo(a, 'Escolha uma opção'), o.passo === 'confirmar' ? 'Confira os dados antes de confirmar.' : a.texto, h('div', {}, avisosDe(), resumo, dest, busca, lista, outro),
      { passo: o.passo, voltar: voltarOk(a) });
  }

  function telaCampos(a) {
    const o = a.opcoes, campos = o.campos || [], refs = {};
    const mascara = (tipo, v) => {
      const d = v.replace(/\D/g, '');
      if (tipo === 'cpf') return d.slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
      if (tipo === 'data') return d.slice(0, 8).replace(/(\d{2})(\d)/, '$1/$2').replace(/(\d{2})(\d)/, '$1/$2');
      if (tipo === 'cep') return d.slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2');
      if (tipo === 'tel') return d.slice(0, 11).replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2');
      return v;
    };
    const dataBr = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v.split('-').reverse().join('/') : (v || ''));
    const blocos = campos.map((c) => {
      const id = 'etp_' + c.nome;
      let ent;
      if (c.tipo === 'sexo') {
        let sel = String(c.valor || '').toUpperCase().slice(0, 1); refs[c.nome] = () => sel;
        const caixa = h('div', { class: 'marc-lista', role: 'radiogroup', 'aria-label': c.rotulo });
        const pintar = () => caixa.replaceChildren(...[['F', 'Feminino'], ['M', 'Masculino']].map(([v, t]) => opcao({ titulo: t, sel: sel === v, onclick: () => { sel = v; pintar(); } })));
        pintar(); ent = caixa;
      } else {
        const tipo = c.tipo === 'email' ? 'email' : 'text';
        const ini = c.tipo === 'data' ? dataBr(c.valor) : (c.valor || '');
        ent = h('input', { class: 'marc-busca', id, type: tipo, value: ini, maxlength: 120, autocomplete: c.tipo === 'email' ? 'email' : c.tipo === 'tel' ? 'tel' : 'off',
          inputmode: ['cpf', 'data', 'cep', 'tel'].includes(c.tipo) ? 'numeric' : null, placeholder: c.tipo === 'data' ? 'DD/MM/AAAA' : c.tipo === 'cpf' ? '000.000.000-00' : null, 'aria-label': c.rotulo });
        if (['cpf', 'data', 'cep', 'tel'].includes(c.tipo)) { ent.addEventListener('input', () => { ent.value = mascara(c.tipo, ent.value); }); if (ini) ent.value = mascara(c.tipo, ini); }
        refs[c.nome] = () => ent.value.trim();
      }
      return h('div', { style: 'margin-bottom:14px' }, h('label', { for: id, style: 'display:block;font-weight:700;margin-bottom:6px' }, c.rotulo + (c.obrigatorio ? '' : ' (opcional)')), ent);
    });
    const enviar = () => {
      const v = {};
      for (const c of campos) { const x = refs[c.nome](); if (c.obrigatorio && !x) { erro('Preencha: ' + c.rotulo + '.'); return; } if (x) v[c.nome] = x; }
      responder(o.passo, v, null);
    };
    const pular = o.pular ? h('button', { class: 'marc-link', type: 'button', id: 'etpPular', onclick: () => responder(o.passo, { pular: true }, null) }, o.pular) : null;
    tela(titulo(a, 'Seus dados'), a.texto, h('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); enviar(); } }, avisosDe(), ...blocos, pular, h('button', { type: 'submit', hidden: true })),
      { passo: o.passo, voltar: voltarOk(a), botoes: [botao(o.botao || 'Continuar', enviar, '', { id: 'etpContinuar' })] });
  }

  async function telaConsulta(a) {
    carregando('Buscando as consultas…');
    const meu = C.sessao;
    let r;
    try { r = await rpc('chat_consultas', { p_conversa: C.conv.id, p_token: C.conv.token }); } catch (e) { if (meu !== C.sessao) return; tela('Não conseguimos listar as consultas', null, h('p', { class: 'marc-erro' }, msgErro(e) === 'PIN' ? '' : msgErro(e)), { progresso: false, botoes: [botao('Tentar de novo', desenhar)] }); falhou(e); return; }
    if (meu !== C.sessao) return;
    if (r.sem_unidade_autorizada) {
      tela('Por aqui só marcamos pediatria', r.aviso || 'Para este atendimento, a equipe marca com você.', h('div', {}), { progresso: false, botoes: [h('a', { class: 'marc-bt', href: WHATS, target: '_blank', rel: 'noopener', style: 'text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center' }, 'Continuar pelo WhatsApp')] });
      return;
    }
    const lista = h('div', { class: 'marc-lista', role: 'radiogroup' });
    const busca = (r.consultas || []).length > 7 ? h('input', { class: 'marc-busca', type: 'search', placeholder: 'Buscar pelo nome', 'aria-label': 'Buscar consulta', autocomplete: 'off', oninput: (e) => pintar(norm(e.target.value.trim())) }) : null;
    const escolher = async (c) => {
      document.querySelectorAll('#marc button').forEach((b) => { b.disabled = true; });
      try { await rpc('chat_consulta_salvar', { p_conversa: C.conv.id, p_token: C.conv.token, p_procedimento_id: c.id }); await sincronizar(); desenhar(); }
      catch (e) { document.querySelectorAll('#marc button').forEach((b) => { b.disabled = false; }); falhou(e); }
    };
    const pintar = (q = '') => { const vis = (r.consultas || []).filter((c) => !q || norm(c.rotulo).includes(q)); lista.replaceChildren(...(vis.length ? vis.map((c) => opcao({ titulo: c.rotulo, onclick: () => escolher(c) })) : [h('p', { class: 'sub' }, 'Nada encontrado.')])); };
    pintar();
    tela('Qual consulta?', C.ident && C.ident.filho ? `Atendimento para ${C.ident.nomeCrianca || 'a criança'}.` : 'Escolha a consulta.', h('div', {}, avisosDe(), busca, lista), { passo: 'consulta', voltar: true });
  }

  /* ----- horários: contrato do chat de hoje (chat-agenda-api -> chat_horarios -> chat_horario_escolher) ----- */
  async function agendaApi(janela, fresco) {
    try { const { data } = await Promise.race([C.db.functions.invoke('chat-agenda-api', { body: { conversa: C.conv.id, token: C.conv.token, janela, fresco } }), new Promise((_, no) => setTimeout(() => no(new Error('tempo')), 14000))]); return data || null; }
    catch { return null; }
  }
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  async function telaCalendario(a) {
    const meu = C.sessao, grupo = (a.opcoes && a.opcoes.grupo) || 1;
    carregando('Conferindo a agenda da clínica agora…');
    const H = { janela: 0, per: '', dia: null, slot: null };
    await agendaApi(0, false);   // ao abrir usa a lista guardada há menos de 45 s (poupa a cota do Klingo); a conferência "fresca" é só logo antes de escolher
    if (meu !== C.sessao) return;
    const buscar = async () => { const hoje = new Date(); return rpc('chat_horarios', { p_conversa: C.conv.id, p_token: C.conv.token, p_grupo: grupo, p_de: ymd(hoje), p_ate: ymd(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 45)), p_unidade: null, p_periodo: H.per || null }); };
    let r;
    try { r = await buscar(); } catch (e) { if (meu !== C.sessao) return; tela('Não conseguimos ver os horários', null, h('div', {}), { progresso: false, botoes: [botao('Tentar de novo', desenhar)] }); falhou(e); return; }
    if (meu !== C.sessao) return;
    const semHorario = () => preMarcacao(r.aviso || 'Nenhum horário serve para você agora', () => responder(a.opcoes.passo, 'sem_horario', 'Nenhum horário serve para mim'), a);
    const dias = (r.dias || []).filter((d) => d.slots && d.slots.length);
    if (r.estado !== 'com_horarios' || !dias.length || r.medico_sem_horario) {
      const msg = r.medico_sem_horario ? 'O(a) médico(a) escolhido(a) não tem horário livre agora.' : (r.aviso || 'Não encontramos horários disponíveis para este atendimento agora.');
      tela('Sem horário pelo site', msg, h('div', {}, avisosDe(), h('div', { class: 'marc-aviso' }, 'Você pode deixar uma pré-marcação: a equipe procura um horário e confirma com você.')),
        { passo: 'horario', voltar: true, botoes: [r.estado === 'indisponivel' || r.estado === 'sem_consulta' ? botao('Tentar de novo', desenhar, 'sec') : null, botao('Fazer pré-marcação', semHorario)] });
      return;
    }
    const diaDe = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd); };
    H.dia = dias[0].data;
    const dEl = h('div', { class: 'marc-dias', role: 'radiogroup', 'aria-label': 'Dias' }), hEl = h('div', { class: 'marc-horas', role: 'radiogroup', 'aria-label': 'Horários' }), cont = h('p', { class: 'sub', style: 'margin:0 0 8px' });
    const filtros = h('div', { class: 'marc-chips' });
    const pintar = () => {
      const vis = dias.map((d) => ({ data: d.data, slots: d.slots.filter((s) => !H.per || (H.per === 'manha' ? s.hora < '12:00' : s.hora >= '12:00')) })).filter((d) => d.slots.length);
      if (!vis.some((d) => d.data === H.dia)) H.dia = vis[0] && vis[0].data;
      const chip = (rot, on, fn) => h('button', { class: 'marc-chip', type: 'button', role: 'checkbox', 'aria-checked': String(on), style: 'min-height:40px;padding:0 14px', onclick: fn }, rot);
      filtros.replaceChildren(chip('Manhã', H.per === 'manha', () => { H.per = H.per === 'manha' ? '' : 'manha'; pintar(); }), chip('Tarde', H.per === 'tarde', () => { H.per = H.per === 'tarde' ? '' : 'tarde'; pintar(); }));
      cont.textContent = vis.length ? `${pl(vis.reduce((n, d) => n + d.slots.length, 0), 'horário')} em ${pl(vis.length, 'dia')}.` : 'Nenhum horário com esse filtro. Toque no filtro para tirá-lo.';
      dEl.replaceChildren(...vis.map((d) => { const dt = diaDe(d.data); return h('button', { class: 'marc-dia', type: 'button', role: 'radio', 'aria-checked': String(d.data === H.dia), onclick: () => { H.dia = d.data; H.slot = null; pintar(); } }, h('small', {}, dt.toLocaleDateString('pt-BR', { weekday: 'short' })), h('b', {}, dt.getDate()), h('small', {}, dt.toLocaleDateString('pt-BR', { month: 'short' }))); }));
      const d = vis.find((x) => x.data === H.dia);
      hEl.replaceChildren(...(d ? d.slots.map((s) => h('button', { class: 'marc-hora', type: 'button', role: 'radio', 'aria-checked': String(!!H.slot && H.slot.data === d.data && H.slot.hora === s.hora), onclick: () => { H.slot = { data: d.data, hora: s.hora, unidade: s.unidade, profissional: s.profissional }; erro(''); pintar(); } }, s.hora, h('small', { style: 'display:block;font-weight:500;font-size:12px' }, String(s.profissional || '').split(' ')[0]))) : []));
    };
    pintar();
    const mais = (H.janela < 2) ? h('button', { class: 'marc-link', type: 'button', onclick: async (ev) => { ev.currentTarget.disabled = true; H.janela++; await agendaApi(H.janela, false); if (meu !== C.sessao) return; try { r = await buscar(); } catch { return; } dias.splice(0, dias.length, ...(r.dias || []).filter((d) => d.slots && d.slots.length)); pintar(); ev.currentTarget.disabled = false; if (H.janela >= 2) ev.currentTarget.remove(); } }, 'Procurar mais datas') : null;
    const confirmar = async (ev) => {
      if (!H.slot) { erro('Escolha um dia e um horário.'); return; }
      ev.currentTarget.disabled = true; erro('');
      try {
        await agendaApi(0, true);   // confere de novo logo antes de escolher
        await rpc('chat_horario_escolher', { p_conversa: C.conv.id, p_token: C.conv.token, p_grupo: grupo, p_data: H.slot.data, p_hora: H.slot.hora, p_unidade: H.slot.unidade || null });
        await sincronizar(); desenhar();
      } catch (e) {
        ev.currentTarget.disabled = false;
        if (e && e.code === 'P0002') { H.slot = null; try { r = await buscar(); dias.splice(0, dias.length, ...(r.dias || []).filter((d) => d.slots && d.slots.length)); } catch { /* mantém */ } pintar(); erro('Esse horário acabou de ficar indisponível. Escolha outro, por favor.'); }
        else falhou(e);
      }
    };
    const aviso = r.aviso ? h('div', { class: 'marc-aviso' }, r.aviso) : null;
    tela('Escolha o dia e o horário', 'Estes são os horários livres na agenda agora.', h('div', {}, avisosDe(), aviso, cont, filtros, dEl, hEl, mais, h('button', { class: 'marc-link', type: 'button', id: 'etpNenhum', onclick: semHorario }, 'Nenhum desses horários serve')),
      { passo: 'horario', voltar: true, botoes: [botao('Continuar', confirmar, '', { id: 'etpContinuar' })] });
  }

  /* ----- marcando / aguardando a equipe ----- */
  function telaAguardar(a) {
    tela('Estamos marcando…', a.texto || 'Só um instante. Estamos marcando o seu horário.', h('div', { 'aria-busy': 'true' }, h('div', { class: 'marc-esq' })), { progresso: false, botoes: [botao('Abrir a conversa', irParaChat, 'sec')] });
    const meu = C.sessao, inicio = Date.now();
    C.timer = setInterval(async () => {
      if (meu !== C.sessao) return;
      try {
        const antes = C.ultimoId; await sincronizar();
        if (C.ultimoId !== antes && C.atual && !(C.atual.opcoes && (C.atual.opcoes.tipo === 'marcando' || C.atual.opcoes.tipo === 'espera'))) desenhar();
        else if (Date.now() - inicio > 90000) { parar(); tela('Está demorando mais que o normal', 'A marcação continua em andamento. Você pode acompanhar pela conversa; a equipe também recebe o seu pedido.', h('div', {}), { progresso: false, botoes: [botao('Abrir a conversa', irParaChat)] }); }
      } catch { /* tenta de novo no próximo ciclo */ }
    }, 3000);
  }

  function telaFim(a) {
    const marcado = a.opcoes && a.opcoes.tipo === 'marcado';
    tela(marcado ? 'Marcado!' : 'Pedido enviado', a.texto, h('div', { class: 'marc-status ' + (marcado ? 'ok' : 'pre') }, h('div', { class: 'grande', 'aria-hidden': 'true' }, marcado ? '✅' : '🕒'),
      h('h1', {}, marcado ? 'MARCAÇÃO confirmada' : 'Recebemos o seu pedido'), h('p', { style: 'margin:0' }, marcado ? 'Seu horário está reservado.' : 'A equipe vai conferir e falar com você.')),
    { progresso: false, botoes: [h('a', { class: 'marc-bt', href: 'minha-vez/?acompanhar=1', style: 'text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center' }, 'Acompanhar meus pedidos'), botao('Abrir a conversa', irParaChat, 'sec')] });
    corpo.append(h('button', { class: 'marc-link', type: 'button', onclick: () => { parar(); fechar(); if (C.aoNova) C.aoNova(); } }, 'Fazer outra marcação'));
  }

  /* ---------- abrir ---------- */
  function abrir({ db, conv, respostas, ident, aoChat, aoPin, aoNova }) {
    if (C) parar();
    C = { db, conv, ident: ident || {}, aoChat, aoPin, aoNova, ultimoId: 0, atual: null, avisos: [], motorAtivo: true, ocupado: false, sessao: (C && C.sessao) || 0, autoMotivo: false };
    montar(); raiz.hidden = false; document.body.classList.add('marc-aberta');
    if (respostas && respostas.length && receber(respostas)) desenhar();
    else { carregando(); sincronizar(0).then(desenhar).catch(falhou); }
  }
  window.CSI_ETAPAS = { abrir, fechar: () => { if (C) parar(); fechar(); } };
})();
