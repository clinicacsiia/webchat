/* CSI WebChat — TESTE: sistema de marcação por etapas (autoatendimento).
   Fala só com window.CSI_SIM (integração simulada): nenhuma chamada real, nenhum dado real.
   Pontos de integração futuros: CSI_SIM (dados e regras). */
(function () {
  'use strict';
  const S = window.CSI_SIM;
  const K_EST = 'teste_marc_estado_v1';
  const h = (tag, at, ...fil) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(at || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
    }
    for (const f of fil.flat()) if (f != null && f !== false) e.append(f.nodeType ? f : document.createTextNode(String(f)));
    return e;
  };
  const dinheiro = (n) => 'R$ ' + Number(n).toFixed(2).replace('.', ',');
  const dataBonita = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }); };
  const NAO_SEI = 'nao_sei';

  /* ---------- estado (nada se perde ao avançar, voltar ou corrigir) ---------- */
  const novo = (ident) => ({ ident, passo: 'pagto', hist: [], tipo: 'consulta', procId: '', procNome: '', procTipo: '', procAtivo: true, medico: '', medicoNome: '', preco: null, preparo: '', pagto: '', convId: '', convNome: '', plano: '', cart: { anexada: false, semAgora: false, foto: '' }, slot: null, semHorario: '', pre: { aceita: '', periodo: '', dias: [] }, regras: false, retorno: false, remarcando: '' });
  let st = null, ctx = { catalogo: null };
  const salvar = () => { try { localStorage.setItem(K_EST, JSON.stringify(st)); } catch { try { const c = JSON.parse(JSON.stringify(st)); c.cart.foto = ''; localStorage.setItem(K_EST, JSON.stringify(c)); } catch { /* ignora */ } } };
  const limpar = () => { try { localStorage.removeItem(K_EST); } catch { /* ignora */ } };

  /* ---------- regras (a tela só pergunta; quem decide é aqui + a configuração da integração) ---------- */
  const motivoAntesDoHorario = (s) => {
    const c = S.config();
    if (!s.procAtivo) return 'Este procedimento está temporariamente agendado apenas pela equipe.';
    if (s.pagto === NAO_SEI) return 'Sem saber a forma de pagamento, não conseguimos reservar o horário na hora.';
    if (s.pagto === 'convenio') {
      if (s.convId === NAO_SEI) return 'Sem saber o convênio, a equipe precisa conferir o seu cadastro antes de confirmar.';
      if (s.plano === NAO_SEI) return 'Sem saber o plano, a equipe precisa conferir a cobertura antes de confirmar.';
      if (c.exigir_carteirinha && !s.cart.anexada) return 'Sem a foto da carteirinha, a equipe precisa conferir o convênio antes de confirmar.';
    }
    return '';
  };
  const pagador = (s) => (s.pagto === 'particular' ? 'Particular' : s.pagto === 'convenio' && s.convId && s.convId !== NAO_SEI ? s.convId : '');
  // O que a equipe precisa confirmar (vira a lista da pré-marcação). Vazio = dá para marcar.
  const pendencias = (s) => {
    const l = [], c = S.config();
    if (!s.procAtivo) l.push('Consulta agendada apenas pela equipe');
    if (s.pagto === NAO_SEI) l.push('Forma de pagamento (particular ou convênio)');
    if (s.pagto === 'convenio') {
      if (s.convId === NAO_SEI) l.push('Qual é o convênio');
      else if (s.plano === NAO_SEI) l.push('Qual é o plano');
      else if (c.exigir_carteirinha && !s.cart.anexada) l.push('Foto da carteirinha');
    }
    if (!l.length && s.semHorario) l.push('Médica e horário');
    return l;
  };
  const motivoPre = (s) => motivoAntesDoHorario(s) || s.semHorario;
  const completo = {
    proc: (s) => !!s.procId, medico: (s) => !!s.medico, pagto: (s) => !!s.pagto, conv: (s) => !!s.convId, plano: (s) => !!s.plano,
    cart: (s) => s.cart.anexada || s.cart.semAgora, horario: (s) => !!s.slot || !!s.semHorario,
    pre: (s) => s.pre.aceita === 'nao' || (s.pre.aceita === 'sim' && !!s.pre.periodo), regras: (s) => s.regras, resumo: () => false
  };
  const aplica = {
    proc: () => true, medico: (s) => !motivoAntesDoHorario(s), pagto: () => true,
    conv: (s) => s.pagto === 'convenio',
    plano: (s) => s.pagto === 'convenio' && s.convId && s.convId !== NAO_SEI,
    cart: (s) => s.pagto === 'convenio' && s.convId !== NAO_SEI && s.plano !== NAO_SEI && S.config().exigir_carteirinha,
    horario: (s) => !motivoAntesDoHorario(s),
    pre: (s) => !!motivoPre(s), regras: () => true, resumo: () => true
  };
  const ORDEM = ['pagto', 'conv', 'plano', 'cart', 'proc', 'medico', 'horario', 'pre', 'regras', 'resumo'];
  const NOMES = { proc: 'Consulta', medico: 'Médica', pagto: 'Pagamento', conv: 'Convênio', plano: 'Plano', cart: 'Carteirinha', horario: 'Horário', pre: 'Pré-marcação', regras: 'Condições', resumo: 'Resumo' };
  const aplicaveis = () => ORDEM.filter((p) => aplica[p](st));

  /* ---------- casca da tela ---------- */
  let raiz, corpo, rodape, progTxt, progBarra, btnVoltar;
  function montar() {
    if (raiz) return;
    btnVoltar = h('button', { class: 'marc-ic', type: 'button', 'aria-label': 'Voltar', onclick: voltar }, '←');
    progTxt = h('span'); progBarra = h('i');
    corpo = h('main', { class: 'marc-corpo', id: 'marcCorpo', 'aria-live': 'polite' });
    rodape = h('footer', { class: 'marc-rodape' });
    raiz = h('div', { id: 'marc', hidden: true, role: 'region', 'aria-label': 'Sistema de marcação' },
      h('header', { class: 'marc-topo' }, btnVoltar, h('img', { src: 'img/logo-csi-simbolo.svg', alt: 'CSI' }), h('span', { class: 'esp' })),
      h('div', { class: 'marc-prog', id: 'marcProg' }, h('div', { class: 'txt' }, progTxt, h('button', { class: 'marc-link', type: 'button', style: 'padding:0;min-height:0;font-size:13px', onclick: recomecar }, 'Recomeçar')), h('div', { class: 'barra', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 }, progBarra)),
      corpo, rodape);
    document.body.append(raiz);
  }
  function ajustarTopo() { const f = document.getElementById('faixaTeste'); raiz.style.setProperty('--marc-topo', (f ? f.getBoundingClientRect().height : 0) + 'px'); }
  addEventListener('resize', () => { if (raiz && !raiz.hidden) ajustarTopo(); });

  function mostrar(titulo, sub, conteudo, { botoes, progresso = true, foco = true } = {}) {
    document.getElementById('marcProg').hidden = !progresso;
    if (progresso) {
      const lista = aplicaveis(), i = Math.max(0, lista.indexOf(st.passo));
      progTxt.textContent = `Etapa ${i + 1} de ${lista.length} · ${NOMES[st.passo] || ''}`;
      progBarra.style.width = Math.round(((i + 1) / lista.length) * 100) + '%';
      progBarra.parentNode.setAttribute('aria-valuenow', Math.round(((i + 1) / lista.length) * 100));
    }
    const sel = [];
    if (progresso && st) {
      const pg = st.pagto === 'particular' ? 'Particular' : st.pagto === 'convenio' ? (st.convId && st.convId !== NAO_SEI ? st.convNome : 'Convênio') : st.pagto === NAO_SEI ? 'Pagamento: não sei' : '';
      [['pagto', pg], ['plano', st.plano && st.plano !== NAO_SEI ? 'Plano ' + st.plano : ''], ['proc', st.procNome], ['medico', st.medico ? st.medicoNome : '']].forEach(([passo, rot]) => { if (rot && passo !== st.passo && !(passo === 'pagto' && st.passo === 'conv')) sel.push(h('button', { class: 'marc-chip', type: 'button', style: 'min-height:34px;padding:0 12px;font-size:13.5px', title: 'Corrigir', onclick: () => { st.retorno = true; irPara(passo); } }, rot + ' ✎')); });
    }
    corpo.replaceChildren(...[sel.length ? h('div', { class: 'marc-chips', 'aria-label': 'Suas escolhas' }, ...sel) : null, h('h1', { tabindex: '-1', id: 'marcTitulo' }, titulo), sub ? h('p', { class: 'sub' }, sub) : null, conteudo, h('p', { class: 'marc-erro', id: 'marcErro', role: 'alert' })].filter(Boolean));
    rodape.replaceChildren(...(botoes || []).filter(Boolean));
    corpo.scrollTop = 0;
    if (foco) setTimeout(() => { const t = document.getElementById('marcTitulo'); if (t) t.focus({ preventScroll: true }); }, 30);
  }
  const erro = (m) => { const e = document.getElementById('marcErro'); if (e) e.textContent = m || ''; };
  const opcao = ({ icone, titulo, detalhe, sel, selo, off, onclick }) => h('button', { class: 'marc-op', type: 'button', role: 'radio', 'aria-checked': String(!!sel), disabled: off, onclick },
    icone ? h('span', { class: 'ic', 'aria-hidden': 'true' }, icone) : null, h('span', { class: 'tx' }, h('b', {}, titulo), detalhe ? h('small', {}, detalhe) : null, selo ? h('span', { class: 'marc-selo' }, selo) : null));
  const botoesPadrao = (opts = {}) => [
    st.hist.length ? h('button', { class: 'marc-bt sec', type: 'button', onclick: voltar, style: 'flex:0 0 34%' }, 'Voltar') : null,
    h('button', { class: 'marc-bt', type: 'button', id: 'marcContinuar', onclick: opts.onclick || continuar, disabled: opts.off }, opts.texto || 'Continuar')
  ];

  /* ---------- navegação ---------- */
  function irPara(p, { empilhar = true } = {}) { if (empilhar && st.passo && st.passo !== p) st.hist.push(st.passo); st.passo = p; salvar(); desenhar(); }
  function voltar() {
    if (!st || !st.hist.length) { fechar(); return; }
    st.retorno = false; st.passo = st.hist.pop(); salvar(); desenhar();
  }
  function continuar() {
    const m = validar(); if (m) { erro(m); return; }
    if (st.passo === 'pre' && st.pre.aceita === 'nao') { fim('nao'); return; }
    const lista = aplicaveis(), i = lista.indexOf(st.passo);
    let prox = lista[i + 1];
    if (st.retorno) { prox = lista.slice(i + 1).find((p) => p !== 'resumo' && !completo[p](st)) || 'resumo'; if (prox === 'resumo') st.retorno = false; }
    irPara(prox || 'resumo');
  }
  function validar() {
    const p = st.passo;
    if (p === 'proc' && !st.procId) return 'Escolha o procedimento.';
    if (p === 'medico' && !st.medico) return 'Escolha a médica ou toque em "Tanto faz".';
    if (p === 'pagto' && !st.pagto) return 'Escolha como vai pagar, ou toque em "Não sei".';
    if (p === 'conv' && !st.convId) return 'Escolha o convênio, ou toque em "Não sei".';
    if (p === 'plano' && !st.plano) return 'Escolha o plano, ou toque em "Não sei".';
    if (p === 'cart' && !completo.cart(st)) return 'Envie a foto da carteirinha ou toque em "Não tenho agora".';
    if (p === 'horario' && !completo.horario(st)) return 'Escolha um dia e um horário, ou toque em "Nenhum desses horários serve".';
    if (p === 'pre' && !st.pre.aceita) return 'Responda Sim ou Não.';
    if (p === 'pre' && st.pre.aceita === 'sim' && !st.pre.periodo) return 'Escolha o melhor período para você.';
    if (p === 'regras' && !st.regras) return 'Marque que você leu as condições para continuar.';
    return '';
  }
  // Mudou algo que invalida o que vem depois? Limpa só o dependente (o resto fica guardado).
  const invalidarHorario = () => { st.slot = null; st.semHorario = ''; };

  /* ---------- telas ---------- */
  const TELAS = {
    async proc() {
      mostrar('Qual consulta?', 'Carregando…', h('div', { class: 'marc-lista' }, h('div', { class: 'marc-esq' }), h('div', { class: 'marc-esq' }), h('div', { class: 'marc-esq' })), { botoes: botoesPadrao({ off: true }) });
      ctx.catalogo = await S.catalogo();
      if (st.passo !== 'proc') return;
      const filtrado = false, itens = ctx.catalogo.filter((p) => p.tipo === 'consulta').sort((a, b) => (b.naApi - a.naApi) || 0);
      const busca = h('input', { class: 'marc-busca', type: 'search', placeholder: 'Buscar pelo nome', 'aria-label': 'Buscar procedimento', autocomplete: 'off' });
      const lista = h('div', { class: 'marc-lista', role: 'radiogroup' });
      const pintar = () => {
        const q = busca.value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        const vis = itens.filter((p) => !q || (p.nome + ' ' + p.detalhe).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes(q));
        lista.replaceChildren(...(vis.length ? vis.map((p) => opcao({
          icone: p.tipo === 'consulta' ? '🩺' : '🩻', titulo: p.nome, detalhe: p.detalhe, sel: st.procId === p.id, selo: !p.ativo ? 'Agendado pela equipe (pré-marcação)' : !p.naApi ? 'Agendada pela equipe (pré-marcação)' : '',
          onclick: () => { if (st.procId !== p.id) { invalidarHorario(); st.medico = ''; st.medicoNome = ''; } Object.assign(st, { procId: p.id, procNome: p.nome, procTipo: p.tipo, procAtivo: p.ativo, preco: p.preco, preparo: p.preparo }); salvar(); pintar(); erro(''); }
        })) : [h('p', { class: 'sub' }, 'Nada encontrado. Tente outra palavra.')]));
      };
      busca.addEventListener('input', pintar); pintar();
      mostrar('Qual consulta?', `Atendimento ${st.ident.tipo === 'filho' ? 'para ' + (st.ident.nomeCrianca || 'a criança') : 'para você'}. Toque na consulta que você precisa.`, h('div', {}, busca, lista), { botoes: botoesPadrao(), foco: false });
    },
    async medico() {
      mostrar('Consultando o Klingo…', st.procNome, h('div', { 'aria-busy': 'true' }, h('p', { class: 'sub' }, 'Buscando os horários reais, só um instante.'), h('div', { class: 'marc-esq' }), h('div', { class: 'marc-esq' })), { botoes: botoesPadrao({ off: true }), foco: false });
      const r = await S.medicos(st.procId, pagador(st));
      if (st.passo !== 'medico') return;
      const lista = r.lista, quem = st.pagto === 'particular' ? 'Particular' : st.convNome;
      const MSG = {
        fora_do_escopo: 'Esta consulta é agendada pela equipe: o Klingo não oferece horários para ela pelo site.',
        sem_plano: r.motivo === 'plano_do_cadastro_necessario' ? `Para ${quem}, a equipe precisa conferir o seu plano no cadastro antes de reservar um horário.` : `A clínica não marca ${quem} pelo site.`,
        sem_horarios: `Não há horário livre no Klingo nas próximas 4 semanas para ${quem}.`,
        indisponivel: 'Não conseguimos consultar o Klingo agora.', limite: 'O Klingo está recebendo muitas consultas agora.'
      };
      if (!lista.length) {
        const m = MSG[r.estado] || (r.estado === 'com_horarios' ? 'Os horários livres estão dentro da regra de antecedência.' : 'Nenhum horário disponível.');
        mostrar('Sem horário pelo site', st.procNome, h('div', {}, h('div', { class: 'marc-aviso' }, m + ' Você pode deixar uma pré-marcação.'),
          r.estado === 'indisponivel' || r.estado === 'limite' ? h('button', { class: 'marc-bt sec', type: 'button', style: 'margin-bottom:8px', onclick: () => desenhar() }, 'Tentar de novo') : null,
          h('button', { class: 'marc-bt', type: 'button', onclick: () => { st.semHorario = m; salvar(); continuar(); } }, 'Fazer pré-marcação')), { botoes: [st.hist.length ? h('button', { class: 'marc-bt sec', type: 'button', onclick: voltar }, 'Voltar') : null] });
        return;
      }
      const set = (id, nome) => { if (st.medico !== id) invalidarHorario(); st.medico = id; st.medicoNome = nome; salvar(); desenhar(); };
      const total = lista.reduce((n, m) => n + m.horarios, 0), hh = r.consultadoEm ? new Date(r.consultadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
      mostrar('Qual médica?', `${lista.length} médica(s) com horário · ${total} horários reais no Klingo nas próximas 4 semanas${hh ? ' (consultado às ' + hh + ')' : ''}.`, h('div', { class: 'marc-lista', role: 'radiogroup' },
        opcao({ icone: '🔁', titulo: 'Tanto faz', detalhe: 'Mostrar os horários de todas', sel: st.medico === 'qualquer', onclick: () => set('qualquer', 'Tanto faz') }),
        ...lista.map((m) => opcao({ icone: '👩‍⚕️', titulo: m.nome, detalhe: m.horarios ? m.horarios + ' horários disponíveis' : 'Sem horário pelo site (só a equipe)', off: !m.horarios, sel: st.medico === m.id, onclick: () => set(m.id, m.nome) }))), { botoes: botoesPadrao(), foco: false });
    },
    pagto() {
      const o = (v, ic, t, d) => opcao({ icone: ic, titulo: t, detalhe: d, sel: st.pagto === v, onclick: () => { st.pagto = v; if (v !== 'convenio') { st.convId = ''; st.convNome = ''; st.plano = ''; st.cart = { anexada: false, semAgora: false, foto: '' }; } invalidarHorario(); st.medico = ''; st.medicoNome = ''; salvar(); desenhar(); } });
      const part = st.pagto === 'particular' && st.preco != null ? h('div', { class: 'marc-info' }, `Valor particular de ${st.procNome}: `, h('b', {}, dinheiro(st.preco)), ' (valor fictício de teste).') : null;
      mostrar('Como será o pagamento?', `Atendimento ${st.ident.tipo === 'filho' ? 'para ' + (st.ident.nomeCrianca || 'a criança') : 'para você'}. Isso define quais consultas, médicas e horários você vê.`, h('div', {}, h('div', { class: 'marc-lista', role: 'radiogroup' },
        o('particular', '💳', 'Particular', 'Pago direto à clínica'), o('convenio', '🏥', 'Convênio', 'Plano de saúde'), o(NAO_SEI, '❓', 'Não sei', 'A equipe ajuda a conferir')), part), { botoes: botoesPadrao() });
    },
    async conv() {
      mostrar('Qual é o seu convênio?', 'Escolha na lista.', h('div', { class: 'marc-lista' }, h('div', { class: 'marc-esq' }), h('div', { class: 'marc-esq' })), { botoes: botoesPadrao({ off: true }) });
      if (!ctx.convenios) ctx.convenios = await S.convenios();
      if (st.passo !== 'conv') return;
      const set = (id, nome) => { if (st.convId !== id) { st.plano = ''; st.cart = { anexada: false, semAgora: false, foto: '' }; invalidarHorario(); st.medico = ''; st.medicoNome = ''; } st.convId = id; st.convNome = nome; salvar(); desenhar(); };
      mostrar('Qual é o seu convênio?', 'Escolha na lista.', h('div', { class: 'marc-lista', role: 'radiogroup' },
        ...ctx.convenios.map((c) => opcao({ icone: '🏥', titulo: c.nome, sel: st.convId === c.id, onclick: () => set(c.id, c.nome) })),
        opcao({ icone: '❓', titulo: 'Não sei', detalhe: 'A equipe confere para você', sel: st.convId === NAO_SEI, onclick: () => set(NAO_SEI, 'Não sei') })), { botoes: botoesPadrao(), foco: false });
    },
    plano() {
      const campo = h('input', { class: 'marc-busca', type: 'text', id: 'marcPlano', placeholder: 'Ex.: Nacional Flex, Plano Básico', 'aria-label': 'Nome do plano', autocomplete: 'off', maxlength: 60, value: st.plano && st.plano !== NAO_SEI ? st.plano : '' });
      campo.addEventListener('input', () => { st.plano = campo.value.trim(); salvar(); erro(''); });
      mostrar('Qual é o seu plano?', `Convênio: ${st.convNome}. Digite o nome do plano que está na carteirinha.`, h('div', {}, campo,
        h('div', { class: 'marc-lista', style: 'margin-top:4px' }, opcao({ icone: '❓', titulo: 'Não sei', detalhe: 'A equipe confere pela carteirinha', sel: st.plano === NAO_SEI, onclick: () => { st.plano = st.plano === NAO_SEI ? '' : NAO_SEI; invalidarHorario(); salvar(); desenhar(); } }))), { botoes: botoesPadrao(), foco: false });
    },
    cart() {
      const entrada = h('input', { type: 'file', accept: 'image/*', capture: 'environment', id: 'marcFoto', style: 'position:absolute;left:-9999px', 'aria-label': 'Foto da carteirinha' });
      const prev = st.cart.foto ? h('img', { class: 'marc-foto', src: st.cart.foto, alt: 'Foto da carteirinha enviada' }) : null;
      entrada.addEventListener('change', () => {
        const f = entrada.files && entrada.files[0]; if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          const im = new Image();
          im.onload = () => { const e = Math.min(1, 720 / Math.max(im.width, im.height)), c = document.createElement('canvas'); c.width = Math.round(im.width * e); c.height = Math.round(im.height * e); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); st.cart = { anexada: true, semAgora: false, foto: c.toDataURL('image/jpeg', .7) }; invalidarHorario(); salvar(); desenhar(); };
          im.onerror = () => erro('Não consegui ler essa imagem. Tente outra foto.'); im.src = rd.result;
        };
        rd.readAsDataURL(f);
      });
      mostrar('Foto da carteirinha', 'Precisamos ver a frente da carteirinha do convênio. Em teste, use só uma imagem fictícia.', h('div', {},
        prev, h('button', { class: 'marc-bt', type: 'button', onclick: () => entrada.click() }, st.cart.anexada ? '📷 Trocar a foto' : '📷 Tirar ou escolher foto'), entrada,
        st.cart.anexada ? null : h('button', { class: 'marc-link', type: 'button', onclick: () => { st.cart.semAgora = true; salvar(); continuar(); } }, 'Não tenho agora'),
        st.cart.semAgora && !st.cart.anexada ? h('div', { class: 'marc-aviso' }, 'Sem a foto, sua solicitação vira uma pré-marcação e a equipe confere o convênio com você.') : null), { botoes: botoesPadrao() });
    },
    async horario() {
      const carregando = () => mostrar('Escolha o dia e o horário', `${st.procNome}`, h('div', { 'aria-busy': 'true' }, h('p', { class: 'sub' }, 'Consultando horários disponíveis…'), h('div', { class: 'marc-esq' }), h('div', { class: 'marc-esq' })), { botoes: botoesPadrao({ off: true }), foco: false });
      carregando();
      let r;
      try { r = await S.disponibilidade({ procId: st.procId, medico: st.medico, pagador: pagador(st) }); }
      catch {
        if (st.passo !== 'horario') return;
        mostrar('Não conseguimos consultar os horários', 'O sistema de agenda não respondeu agora.', h('div', {},
          h('div', { class: 'marc-aviso' }, 'Você pode tentar de novo ou deixar uma pré-marcação para a equipe confirmar com você.'),
          h('button', { class: 'marc-bt sec', type: 'button', onclick: () => desenhar() }, 'Tentar de novo')),
          { botoes: [st.hist.length ? h('button', { class: 'marc-bt sec', type: 'button', onclick: voltar, style: 'flex:0 0 34%' }, 'Voltar') : null, h('button', { class: 'marc-bt', type: 'button', onclick: () => { st.slot = null; st.semHorario = 'A agenda não respondeu no momento da consulta.'; salvar(); continuar(); } }, 'Fazer pré-marcação')] });
        return;
      }
      if (st.passo !== 'horario') return;
      const semRegra = !r.dias.length;
      const F = { per: '', dow: [] }, contagem = h('p', { class: 'sub', style: 'margin:0 0 8px', id: 'marcContagem' });
      const dowTxt = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'], dowTem = [...new Set(r.dias.map((d) => { const [y, m, dd] = d.data.split('-').map(Number); return new Date(y, m - 1, dd).getDay(); }))].sort();
      const filtradoDias = () => r.dias.map((d) => { const [y, m, dd] = d.data.split('-').map(Number), w = new Date(y, m - 1, dd).getDay(); if (F.dow.length && !F.dow.includes(w)) return null; const hs = d.horarios.filter((x) => !F.per || (F.per === 'manha' ? x.min < 720 : x.min >= 720)); return hs.length ? { data: d.data, horarios: hs } : null; }).filter(Boolean);
      let diaSel = st.slot ? st.slot.data : (r.dias[0] && r.dias[0].data);
      const dias = h('div', { class: 'marc-dias', role: 'radiogroup', 'aria-label': 'Dias' }), horas = h('div', { class: 'marc-horas', role: 'radiogroup', 'aria-label': 'Horários' });
      const filtros = h('div', {});
      const pintar = () => {
        const dv = filtradoDias(); if (!dv.some((x) => x.data === diaSel)) diaSel = dv[0] && dv[0].data;
        const chip = (rot, on, fn) => h('button', { class: 'marc-chip', type: 'button', role: 'checkbox', 'aria-checked': String(on), style: 'min-height:40px;padding:0 14px', onclick: fn }, rot);
        filtros.replaceChildren(h('div', { class: 'marc-chips' }, chip('Manhã', F.per === 'manha', () => { F.per = F.per === 'manha' ? '' : 'manha'; pintar(); }), chip('Tarde', F.per === 'tarde', () => { F.per = F.per === 'tarde' ? '' : 'tarde'; pintar(); }), ...dowTem.map((w) => chip(dowTxt[w], F.dow.includes(w), () => { F.dow = F.dow.includes(w) ? F.dow.filter((x) => x !== w) : F.dow.concat(w); pintar(); }))));
        contagem.textContent = dv.length ? `${dv.reduce((n, x) => n + x.horarios.length, 0)} horário(s) em ${dv.length} dia(s) — toque nos filtros para reduzir.` : 'Nenhum horário com esses filtros. Toque de novo nos filtros para tirar.';
        dias.replaceChildren(...dv.map((d) => { const [y, m, dd] = d.data.split('-').map(Number), dt = new Date(y, m - 1, dd); return h('button', { class: 'marc-dia', type: 'button', role: 'radio', 'aria-checked': String(d.data === diaSel), onclick: () => { diaSel = d.data; pintar(); } }, h('small', {}, dt.toLocaleDateString('pt-BR', { weekday: 'short' })), h('b', {}, dd), h('small', {}, dt.toLocaleDateString('pt-BR', { month: 'short' }))); }));
        const d = dv.find((x) => x.data === diaSel);
        horas.replaceChildren(...(d ? d.horarios.map((hr) => h('button', { class: 'marc-hora', type: 'button', role: 'radio', 'aria-checked': String(!!st.slot && st.slot.data === d.data && st.slot.hora === hr.hora && st.slot.profissional === hr.profissional), onclick: () => { st.slot = { data: d.data, hora: hr.hora, unidade: hr.unidade, profissional: hr.profissional, local: hr.local }; st.semHorario = ''; salvar(); pintar(); erro(''); } }, hr.hora, st.medico === 'qualquer' ? h('small', { style: 'display:block;font-weight:500;font-size:12px' }, hr.profissional.split(' ')[0]) : null)) : []));
      };
      pintar();
      const regra0 = h('div', { class: 'marc-info' }, '✔ Horários reais do Klingo de ' + (st.medico === 'qualquer' ? 'todas as médicas' : st.medicoNome) + (r.consultadoEm ? ', consultados às ' + new Date(r.consultadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '') + '.');
      const regra = r.antecedenciaHoras ? h('div', { class: 'marc-info' }, `Marcações pelo site precisam de pelo menos ${r.antecedenciaHoras} horas de antecedência.`, r.bloqueadosPelaRegra ? ` Há ${r.bloqueadosPelaRegra} horário(s) mais próximos que só a equipe pode confirmar.` : '') : null;
      mostrar(semRegra ? 'Sem horários pelo site' : 'Escolha o dia e o horário', st.procNome + (st.slot ? '' : ''), h('div', {}, regra0, regra,
        semRegra ? h('div', { class: 'marc-aviso' }, 'Não há horários livres que respeitem a regra de antecedência. Você pode deixar uma pré-marcação.') : h('div', {}, contagem, filtros, dias, horas),
        h('button', { class: 'marc-link', type: 'button', onclick: () => { st.slot = null; st.semHorario = semRegra ? 'Não há horários livres dentro da regra de antecedência.' : 'Nenhum dos horários oferecidos serviu.'; salvar(); continuar(); } }, semRegra ? 'Quero fazer uma pré-marcação' : 'Nenhum desses horários serve')),
        { botoes: botoesPadrao({ off: semRegra }), foco: false });
    },
    pre() {
      const sim = st.pre.aceita === 'sim', per = (v, t) => h('button', { class: 'marc-chip', type: 'button', role: 'radio', 'aria-checked': String(st.pre.periodo === v), onclick: () => { st.pre.periodo = v; salvar(); desenhar(); } }, t);
      const dia = (v, t) => h('button', { class: 'marc-chip', type: 'button', role: 'checkbox', 'aria-checked': String(st.pre.dias.includes(v)), onclick: () => { st.pre.dias = st.pre.dias.includes(v) ? st.pre.dias.filter((x) => x !== v) : st.pre.dias.concat(v); salvar(); desenhar(); } }, t);
      mostrar('Quer deixar uma pré-marcação?', 'Não foi possível concluir a marcação agora.', h('div', {},
        h('div', { class: 'marc-aviso' }, h('b', {}, 'A equipe precisa confirmar com você:'), h('ul', { class: 'marc-regras', style: 'margin:6px 0 0' }, ...(pendencias(st).length ? pendencias(st) : [motivoPre(st)]).map((t) => h('li', {}, t)))),
        h('p', { class: 'sub' }, 'Na pré-marcação, a equipe confere tudo e confirma com você. Ela ',  h('b', {}, 'não garante'), ' o horário até a confirmação.'),
        h('div', { class: 'marc-lista', role: 'radiogroup' },
          opcao({ icone: '✅', titulo: 'Sim, quero a pré-marcação', sel: sim, onclick: () => { st.pre.aceita = 'sim'; salvar(); desenhar(); } }),
          opcao({ icone: '✖️', titulo: 'Não, obrigado(a)', sel: st.pre.aceita === 'nao', onclick: () => { st.pre.aceita = 'nao'; salvar(); desenhar(); } })),
        sim ? h('div', { style: 'margin-top:16px' }, h('p', { class: 'sub', style: 'margin-bottom:4px' }, 'Qual o melhor período?'), h('div', { class: 'marc-chips', role: 'radiogroup' }, per('manha', 'Manhã'), per('tarde', 'Tarde'), per('qualquer', 'Tanto faz')),
          h('p', { class: 'sub', style: 'margin-bottom:4px' }, 'Dias da semana (opcional)'), h('div', { class: 'marc-chips' }, ...[['seg', 'Seg'], ['ter', 'Ter'], ['qua', 'Qua'], ['qui', 'Qui'], ['sex', 'Sex'], ['sab', 'Sáb']].map(([v, t]) => dia(v, t)))) : null),
        { botoes: botoesPadrao() });
    },
    regras() {
      const chk = h('input', { type: 'checkbox', id: 'marcRegras', checked: st.regras });
      chk.addEventListener('change', () => { st.regras = chk.checked; salvar(); erro(''); });
      mostrar('Cancelamento e remarcação', 'Leia com atenção antes de confirmar.', h('div', {}, h('div', { class: 'marc-card' }, h('ul', { class: 'marc-regras' }, ...S.config().politica.map((t) => h('li', {}, t)))),
        st.preparo ? h('div', { class: 'marc-info' }, h('b', {}, 'Preparo: '), st.preparo) : null,
        h('label', { class: 'marc-chk' }, chk, h('span', {}, 'Li e concordo com as condições de cancelamento e remarcação.'))), { botoes: botoesPadrao() });
    },
    resumo() {
      const pre = !!motivoPre(st), id = st.ident;
      const pagtoTxt = st.pagto === 'particular' ? 'Particular' + (st.preco != null ? ' · ' + dinheiro(st.preco) : '') : st.pagto === 'convenio' ? `Convênio: ${st.convId === NAO_SEI ? 'não sei' : st.convNome}${st.convId !== NAO_SEI ? ' · plano: ' + (st.plano === NAO_SEI ? 'não sei' : st.plano) : ''}` : 'Não sei';
      const lin = (rot, val, passo) => h('tr', {}, h('td', {}, rot), h('td', {}, h('b', {}, val), passo ? h('button', { class: 'marc-link ed', type: 'button', style: 'min-height:0;padding:0', onclick: () => { st.retorno = true; irPara(passo); } }, 'Corrigir') : null));
      const quando = st.slot ? `${dataBonita(st.slot.data)}, ${st.slot.hora}` + (st.slot.local ? ` · ${st.slot.local}` : '') + (st.slot.unidade ? ` · ${st.slot.unidade}` : '') : pre ? `Pré-marcação · ${{ manha: 'manhã', tarde: 'tarde', qualquer: 'qualquer período' }[st.pre.periodo] || ''}${st.pre.dias.length ? ' · ' + st.pre.dias.join(', ') : ''}` : '';
      mostrar('Confira antes de confirmar', pre ? 'Esta solicitação será uma PRÉ-MARCAÇÃO.' : 'Esta solicitação será uma MARCAÇÃO.', h('div', {},
        h('div', { class: 'marc-card' }, h('table', { class: 'marc-res' }, h('tbody', {},
          lin('Paciente', id.tipo === 'filho' ? id.nomeCrianca : id.nome), id.tipo === 'filho' ? lin('Responsável', id.nome) : null, lin('Contato', id.telefone + ' · ' + id.email),
          lin('Pagamento', pagtoTxt, 'pagto'), lin('Consulta', st.procNome, 'proc'), lin('Médica(o)', st.slot ? st.slot.profissional : st.medicoNome, 'medico'),
          st.pagto === 'convenio' && S.config().exigir_carteirinha ? lin('Carteirinha', st.cart.anexada ? 'Foto enviada' : 'Não enviada', 'cart') : null,
          lin(pre ? 'Preferência' : 'Data e horário', quando, pre ? 'pre' : 'horario')))),
        pre ? h('div', { class: 'marc-aviso' }, h('b', {}, 'A equipe vai confirmar: '), (pendencias(st).length ? pendencias(st) : [motivoPre(st)]).join('; ')) : h('div', { class: 'marc-info' }, 'Horário reservado assim que você confirmar.'),
        h('div', { class: 'marc-info' }, '🔒 Ambiente de teste: nada é enviado ao Klingo e nenhum aviso real é disparado.')),
        { botoes: [h('button', { class: 'marc-bt sec', type: 'button', onclick: voltar, style: 'flex:0 0 34%' }, 'Voltar'), h('button', { class: 'marc-bt verde', type: 'button', id: 'marcConfirmar', onclick: confirmar }, pre ? 'Confirmar pré-marcação' : 'Confirmar marcação')] });
    }
  };
  function desenhar() { ajustarTopo(); btnVoltar.hidden = false; const f = TELAS[st.passo]; if (f) f(); else irPara('pagto', { empilhar: false }); }

  /* ---------- confirmação e resultado ---------- */
  async function confirmar() {
    const b = document.getElementById('marcConfirmar'); if (b) { b.disabled = true; b.textContent = 'Enviando…'; }
    const pre = !!motivoPre(st), dados = { paciente: st.ident, procId: st.procId, procNome: st.procNome, pagto: st.pagto, convenio: st.convNome, plano: st.plano, carteirinha: st.cart.anexada, slot: st.slot, preferencia: pre ? st.pre : null, pendencias: pre ? pendencias(st) : [] };
    try {
      if (st.remarcando) {
        const s = S.solicitacaoAtualizar(st.remarcando, (x) => { x.dados.slot = st.slot; x.remarcacoes += 1; x.status = 'marcado'; });
        const proto = st.remarcando; limpar(); st = null; fimTela('ok', s || { protocolo: proto, dados }, true); return;
      }
      const s = await S.marcar(dados, { preMarcacao: pre, motivo: pre ? motivoPre(st) : '' });
      limpar(); const id = st.ident; st = novo(id); fimTela(pre ? 'pre' : 'ok', s);
    } catch { if (b) { b.disabled = false; b.textContent = 'Tentar de novo'; } erro('Não foi possível concluir agora. Tente de novo.'); }
  }
  function fim(tipo) { const id = st.ident; limpar(); st = novo(id); fimTela('nao', null); }
  function fimTela(tipo, s, remarc) {
    document.getElementById('marcProg').hidden = true;
    const info = {
      ok: ['✅', remarc ? 'Remarcado!' : 'Marcado!', 'Seu horário está reservado.'],
      pre: ['🕒', 'Pré-marcado', 'Ainda NÃO é uma marcação confirmada. A equipe vai conferir e falar com você.'],
      nao: ['👍', 'Tudo bem, nada foi enviado', 'Você pode voltar quando quiser e fazer uma nova marcação.']
    }[tipo];
    const d = s && s.dados;
    mostrar(info[1], null, h('div', {}, h('div', { class: 'marc-status ' + tipo }, h('div', { class: 'grande', 'aria-hidden': 'true' }, info[0]), h('h1', { tabindex: '-1', id: 'marcTitulo2', style: 'margin:8px 0 4px' }, tipo === 'pre' ? 'PRÉ-MARCAÇÃO registrada' : tipo === 'ok' ? 'MARCAÇÃO confirmada' : 'Sem solicitação'), h('p', { style: 'margin:0' }, info[2])),
      s ? h('div', { class: 'marc-card' }, h('table', { class: 'marc-res' }, h('tbody', {}, h('tr', {}, h('td', {}, 'Protocolo'), h('td', {}, h('b', {}, s.protocolo))), h('tr', {}, h('td', {}, 'Consulta'), h('td', {}, h('b', {}, d.procNome))), d.slot && d.slot.profissional ? h('tr', {}, h('td', {}, 'Médica(o)'), h('td', {}, h('b', {}, d.slot.profissional))) : null,
        h('tr', {}, h('td', {}, tipo === 'ok' ? 'Data e horário' : 'Situação'), h('td', {}, h('b', {}, tipo === 'ok' && d.slot ? `${dataBonita(d.slot.data)}, ${d.slot.hora}` : 'Aguardando confirmação da equipe'))))) ) : null,
      d && d.pendencias && d.pendencias.length ? h('div', { class: 'marc-aviso' }, h('b', {}, 'A equipe vai confirmar com você: '), d.pendencias.join('; ')) : null,
      h('div', { class: 'marc-info' }, '🔒 Ambiente de teste: nada foi enviado ao Klingo e nenhuma notificação real foi disparada.'),
      tipo !== 'nao' ? h('div', { class: 'marc-card' }, h('b', {}, 'Cancelar ou remarcar'), h('ul', { class: 'marc-regras' }, ...S.config().politica.slice(0, 3).map((t) => h('li', {}, t)))) : null),
      { progresso: false, botoes: [h('button', { class: 'marc-bt', type: 'button', onclick: acompanhar }, 'Acompanhar')] });
    corpo.append(h('button', { class: 'marc-link', type: 'button', onclick: () => { const id = (st && st.ident) || ctx.ident; st = novo(id); salvar(); desenhar(); } }, 'Fazer outra marcação'));
  }

  /* ---------- acompanhamento ---------- */
  const ROT = { marcado: ['Marcado', 'ok'], aguardando_equipe: ['Pré-marcado · aguardando equipe', 'pre'], confirmado_equipe: ['Confirmado pela equipe', 'ok'], recusado_equipe: ['Equipe não conseguiu confirmar', 'nao'], cancelado: ['Cancelado', 'cancel'], atendimento_humano: ['Enviado ao atendimento', 'nao'] };
  function acompanhar() {
    montar(); abrirCasca();
    const l = S.solicitacoes();
    document.getElementById('marcProg').hidden = true;
    mostrar('Suas solicitações', 'Acompanhe aqui o que você pediu neste aparelho.', h('div', {}, ...(l.length ? l.map((s) => {
      const r = ROT[s.status] || [s.status, 'nao'], d = s.dados || {}, pode = s.status === 'marcado' || s.status === 'confirmado_equipe';
      const q = d.slot ? `${dataBonita(d.slot.data)}, ${d.slot.hora}` : d.mensagem ? 'Mensagem enviada' : 'Horário a confirmar pela equipe';
      return h('div', { class: 'marc-card' }, h('span', { class: 'marc-badge ' + r[1] }, r[0]), h('p', { style: 'margin:8px 0 2px' }, h('b', {}, d.procNome || 'Atendimento humano')), h('p', { class: 'sub', style: 'margin:0 0 4px' }, q), s.status === 'aguardando_equipe' && d.pendencias && d.pendencias.length ? h('p', { style: 'margin:4px 0;font-size:14px' }, h('b', {}, 'A confirmar: '), d.pendencias.join('; ')) : null, h('small', {}, 'Protocolo ' + s.protocolo + (s.remarcacoes ? ` · ${s.remarcacoes} remarcação(ões)` : '')),
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px' },
          pode ? h('button', { class: 'marc-bt sec', type: 'button', style: 'flex:1 1 40%;min-height:44px;font-size:15px', disabled: s.remarcacoes >= 2, onclick: () => remarcar(s) }, s.remarcacoes >= 2 ? 'Limite de remarcações' : 'Remarcar') : null,
          pode || s.status === 'aguardando_equipe' ? h('button', { class: 'marc-bt sec', type: 'button', style: 'flex:1 1 40%;min-height:44px;font-size:15px', onclick: () => { if (confirm('Cancelar esta solicitação? (teste)')) { S.solicitacaoAtualizar(s.protocolo, (x) => { x.status = 'cancelado'; }); acompanhar(); } } }, 'Cancelar') : null,
          s.status === 'aguardando_equipe' ? h('button', { class: 'marc-link', type: 'button', onclick: () => { S.solicitacaoAtualizar(s.protocolo, (x) => { x.status = 'confirmado_equipe'; }); acompanhar(); } }, '[Teste] simular: equipe confirmou') : null,
          s.status === 'aguardando_equipe' ? h('button', { class: 'marc-link', type: 'button', onclick: () => { S.solicitacaoAtualizar(s.protocolo, (x) => { x.status = 'recusado_equipe'; }); acompanhar(); } }, '[Teste] simular: equipe não conseguiu') : null));
    }) : [h('div', { class: 'marc-info' }, 'Nenhuma solicitação ainda. Faça uma marcação para ela aparecer aqui.')])),
      { progresso: false, botoes: [h('button', { class: 'marc-bt', type: 'button', onclick: () => { if (!st) st = novo(ctx.ident); desenhar(); } }, 'Nova marcação')] });
  }
  function remarcar(s) {
    const proc = S.CATALOGO.find((p) => p.id === s.dados.procId); if (!proc) return;
    st = novo(s.dados.paciente); Object.assign(st, { tipo: proc.tipo, procId: proc.id, procNome: proc.nome, procTipo: proc.tipo, preco: proc.preco, preparo: proc.preparo, pagto: s.dados.pagto, convNome: s.dados.convenio || '', convId: s.dados.convenio ? 'x' : '', plano: s.dados.plano || '', cart: { anexada: !!s.dados.carteirinha, semAgora: false, foto: '' }, remarcando: s.protocolo, passo: 'horario', regras: true, medico: 'qualquer', medicoNome: 'Tanto faz' });
    desenhar();
  }

  /* ---------- configurações do teste (o que a diretoria quer ajustar) ---------- */
  async function configuracoes() {
    const cat = await S.catalogo(), c = S.config();
    const fundo = h('div', { class: 'marc-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Configurações do teste', onclick: (e) => { if (e.target === fundo) fechar2(); } });
    const fechar2 = () => { fundo.remove(); if (raiz && !raiz.hidden && st) desenhar(); };
    const ant = h('select', { id: 'cfgAnt' }, ...[0, 24, 48, 72].map((n) => h('option', { value: n, selected: c.antecedencia_horas === n }, n ? n + ' horas' : 'sem regra')));
    ant.addEventListener('change', () => S.configSalvar({ antecedencia_horas: +ant.value }));
    const sw = (rot, chave, id) => { const i = h('input', { type: 'checkbox', id, checked: !!c[chave] }); i.addEventListener('change', () => S.configSalvar({ [chave]: i.checked })); return h('label', { class: 'l' }, rot, i); };
    const ex = (p) => { const i = h('input', { type: 'checkbox', checked: p.ativo, 'aria-label': p.nome }); i.addEventListener('change', () => { const atual = S.config().exames_inativos.filter((x) => x !== p.id); S.configSalvar({ exames_inativos: i.checked ? atual : atual.concat(p.id) }); ctx.catalogo = null; }); return h('label', { class: 'l' }, p.nome, i); };
    fundo.append(h('div', {}, h('h2', {}, 'Configurações do teste'), h('p', { class: 'sub' }, 'Ajustes só deste ambiente. Servem para apresentar cada regra à diretoria.'),
      h('label', { class: 'l' }, 'Antecedência mínima (regra das 24 h)', ant), sw('Convênio exige foto da carteirinha', 'exigir_carteirinha', 'cfgCart'), sw('Simular agenda (Klingo) fora do ar', 'simular_falha', 'cfgFalha'),
      h('h2', { style: 'margin-top:16px' }, 'Procedimentos ativos para marcação'), ...cat.map(ex),
      h('div', { style: 'display:flex;gap:8px;margin-top:16px;flex-wrap:wrap' },
        h('button', { class: 'marc-bt sec', type: 'button', style: 'min-height:44px;font-size:15px', onclick: () => { if (confirm('Apagar solicitações e estado deste teste?')) { S.solicitacoesApagarTudo(); limpar(); S.configRestaurar(); ctx.catalogo = null; st = null; fundo.remove(); if (raiz) raiz.hidden = true; document.body.classList.remove('marc-aberta'); atualizarEntrada(); } } }, 'Apagar dados do teste'),
        h('button', { class: 'marc-bt', type: 'button', style: 'min-height:44px', onclick: fechar2 }, 'Pronto'))));
    document.body.append(fundo);
  }

  /* ---------- abrir / fechar ---------- */
  function abrirCasca() { montar(); raiz.hidden = false; document.body.classList.add('marc-aberta'); ajustarTopo(); }
  function fechar() { if (raiz) raiz.hidden = true; document.body.classList.remove('marc-aberta'); atualizarEntrada(); }
  function recomecar() { if (!confirm('Recomeçar do início? Os dados desta marcação serão apagados.')) return; limpar(); st = novo(ctx.ident); salvar(); desenhar(); }
  function abrir(ident) {
    ctx.ident = ident; montar();
    let salvo = null; try { salvo = JSON.parse(localStorage.getItem(K_EST) || 'null'); } catch { /* ignora */ }
    if (salvo && (salvo.tipo === 'exame' || salvo.passo === 'tipo' || (salvo.procId && !S.CATALOGO.some((x) => x.id === salvo.procId)))) salvo = null;   // exame saiu do sistema
    st = salvo && salvo.ident && salvo.ident.nome === ident.nome && salvo.ident.nomeCrianca === ident.nomeCrianca ? salvo : novo(ident);
    st.ident = ident; abrirCasca(); desenhar();
  }

  /* ---------- tela inicial: botões novos e retirada do "Previsão de marcação" ---------- */
  let btnAcomp;
  function atualizarEntrada() { if (btnAcomp) { const n = S.solicitacoes().length; btnAcomp.querySelector('small').textContent = n ? `${n} solicitação(ões) neste aparelho` : 'Veja marcações e pré-marcações'; } }
  function prepararEntrada() {
    const prev = document.getElementById('btnPrevisaoEntrada'); if (prev) prev.remove();
    const dica = document.getElementById('dicaPrevisaoEntrada'); if (dica) dica.remove();
    const form = document.getElementById('formInicio'); if (!form || document.getElementById('marcEntrada')) return;
    btnAcomp = h('button', { class: 'marc-op', type: 'button', id: 'marcAcompEntrada', onclick: acompanhar }, h('span', { class: 'ic', 'aria-hidden': 'true' }, '📋'), h('span', { class: 'tx' }, h('b', {}, 'Acompanhe suas solicitações'), h('small', {}, '')));
    form.after(h('div', { class: 'marc-entrada', id: 'marcEntrada' }, btnAcomp)); atualizarEntrada();
    const f = document.getElementById('faixaTeste'); if (f && !document.getElementById('marcCfgBt')) f.append(' ', h('button', { id: 'marcCfgBt', type: 'button', style: 'margin-left:8px;background:#fff;color:#8a4a00;border:0;border-radius:12px;padding:3px 10px;font-weight:700;cursor:pointer', onclick: configuracoes }, '⚙ Configurar teste'));
  }
  window.CSI_MARCACAO = { abrir, acompanhar, configuracoes };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', prepararEntrada); else prepararEntrada();
})();
