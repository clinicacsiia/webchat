// FLUXOGRAMA: entrada (página aberta no Playwright) -> validação (só elementos visíveis; com janela aberta, só o que está dentro dela) -> lógica (texto vazando da caixa, estouro lateral, sobreposição real, alvo de toque < 32px, letra < 12px, contraste fraco) -> saída (um achado por elemento, via __audRelatar)
// Versão 1.0 — 15/11/2026 / Mudança: implementação inicial (ver auditoria-layout.cjs)
(() => {
  if (window.__audInstalado) return; window.__audInstalado = true;
  const vistos = new Set();
  const rel = (o) => { try { window.__audRelatar && window.__audRelatar(JSON.stringify(o)); } catch {} };
  const sel = (e) => {
    let s = e.tagName.toLowerCase();
    if (e.id) s += '#' + e.id;
    if (typeof e.className === 'string' && e.className.trim()) s += '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.');
    return s;
  };
  const caminho = (e) => { const p = []; for (let x = e, i = 0; x && x.nodeType === 1 && i < 4; x = x.parentElement, i++) p.unshift(sel(x)); return p.join(' > '); };
  const texto = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const visivel = (e, cs) => {
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    for (let x = e.parentElement; x; x = x.parentElement) { if (x.hidden) return false; const c = getComputedStyle(x); if (c.display === 'none' || c.visibility === 'hidden' || parseFloat(c.opacity) === 0) return false; }
    return true;
  };
  const claro = (c) => { const m = c.match(/[\d.]+/g); return m ? m.map(Number) : [0, 0, 0, 0]; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const fundoEfetivo = (e) => {
    let acc = null;
    for (let x = e; x; x = x.parentElement) {
      const cs = getComputedStyle(x);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; // gradiente/imagem: não dá para medir
      const [r, g, b, a = 1] = claro(cs.backgroundColor);
      if (a > 0) { if (!acc) { if (a >= .99) return [r, g, b]; acc = [r, g, b, a]; } else return [r, g, b]; }
    }
    return [255, 255, 255];
  };
  const rotulo = (e) => document.querySelector('dialog[open]') ? 'dialog' : (document.querySelector('#folha:not([hidden])') ? 'folha' : 'pagina');
  const achado = (tipo, e, detalhe, extra = {}) => {
    const chave = location.pathname + '|' + tipo + '|' + caminho(e) + '|' + (extra.k || '');
    if (vistos.has(chave)) return; vistos.add(chave);
    rel({ tipo, pagina: location.pathname, larg: innerWidth, contexto: rotulo(e), el: caminho(e), texto: texto(e), detalhe, ...extra });
  };

  function auditar() {
    const todos = [...document.body.querySelectorAll('*')].filter((e) => !['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META', 'NOSCRIPT', 'BR', 'PATH', 'CIRCLE', 'RECT', 'LINE', 'POLYLINE', 'G', 'USE', 'DEFS', 'TEXT', 'TSPAN'].includes(e.tagName.toUpperCase()));
    const info = new Map();
    // com uma folha/janela aberta, o resto da página fica coberto: só audita o que está dentro dela
    const modal = document.querySelector('dialog[open]') || document.querySelector('#folha:not([hidden])') || document.querySelector('.folha:not([hidden])') || document.querySelector('.sheet:not([hidden])') || document.querySelector('#porta:not([hidden])');
    for (const e of todos) { if (modal && !modal.contains(e)) continue; const cs = getComputedStyle(e); if (visivel(e, cs)) info.set(e, cs); }

    // 1) texto/conteúdo vazando da própria caixa
    for (const [e, cs] of info) {
      if (['INPUT', 'TEXTAREA', 'SELECT', 'IMG', 'SVG', 'CANVAS', 'VIDEO', 'HTML', 'BODY'].includes(e.tagName.toUpperCase())) continue;
      if (cs.display.startsWith('inline') && cs.display !== 'inline-block' && cs.display !== 'inline-flex') continue;
      if (e.clientWidth === 0 && e.clientHeight === 0) continue;
      const ox = cs.overflowX, oy = cs.overflowY;
      const ellip = cs.textOverflow === 'ellipsis';
      const dx = e.scrollWidth - e.clientWidth, dy = e.scrollHeight - e.clientHeight;
      if (dx > 2 && (ox === 'visible' || ((ox === 'hidden' || ox === 'clip') && !ellip))) achado('vaza-largura', e, `conteúdo ${e.scrollWidth}px em caixa de ${e.clientWidth}px (overflow-x:${ox})`, { k: 'x' });
      if (dy > 3 && (oy === 'visible' || oy === 'hidden' || oy === 'clip') && cs.display !== 'inline' && !(cs.webkitLineClamp && cs.webkitLineClamp !== 'none') && !ellip) {
        if (['BUTTON', 'A', 'LABEL', 'SPAN', 'P', 'H1', 'H2', 'H3', 'LI', 'SUMMARY', 'STRONG', 'SMALL', 'B'].includes(e.tagName.toUpperCase()) || cs.height !== 'auto') achado('vaza-altura', e, `conteúdo ${e.scrollHeight}px em caixa de ${e.clientHeight}px (overflow-y:${oy})`, { k: 'y' });
      }
    }

    // 2) estouro para fora da tela (largura da página e elementos cortados à direita/esquerda)
    if (document.documentElement.scrollWidth > innerWidth + 1) achado('pagina-rola-de-lado', document.body, `página com ${document.documentElement.scrollWidth}px em tela de ${innerWidth}px`, { k: 'doc' });
    for (const [e, cs] of info) {
      if (cs.position === 'fixed') continue;
      const r = e.getBoundingClientRect();
      if (r.right > innerWidth + 2 || r.left < -2) {
        let rola = false; for (let x = e.parentElement; x; x = x.parentElement) { const c = getComputedStyle(x); if (/(auto|scroll|hidden|clip)/.test(c.overflowX)) { rola = true; break; } }
        if (!rola && (e.children.length === 0 || ['BUTTON', 'A', 'INPUT', 'LABEL'].includes(e.tagName.toUpperCase()))) achado('fora-da-tela', e, `caixa de ${Math.round(r.left)} a ${Math.round(r.right)}px em tela de ${innerWidth}px`, { k: 'fora' });
      }
    }

    // 3) elementos de texto/ação que se sobrepõem de verdade (só a parte visível, sem pai/filho e sem painel por cima)
    const visivelRect = (e) => {
      let r = e.getBoundingClientRect(); let L = Math.max(r.left, 0), T = Math.max(r.top, 0), R = Math.min(r.right, innerWidth), B = Math.min(r.bottom, innerHeight);
      for (let x = e.parentElement; x && x !== document.body; x = x.parentElement) {
        const c = getComputedStyle(x); if (c.overflowX === 'visible' && c.overflowY === 'visible') continue;
        const q = x.getBoundingClientRect();
        if (c.overflowX !== 'visible') { L = Math.max(L, q.left); R = Math.min(R, q.right); }
        if (c.overflowY !== 'visible') { T = Math.max(T, q.top); B = Math.min(B, q.bottom); }
      }
      return R - L > 1 && B - T > 1 ? { left: L, top: T, right: R, bottom: B, width: R - L, height: B - T } : null;
    };
    const alvos = [];
    for (const [e, cs] of info) {
      const t = e.tagName.toUpperCase();
      const interativo = ['BUTTON', 'A', 'SELECT', 'SUMMARY', 'TEXTAREA'].includes(t) || (t === 'INPUT' && !['hidden', 'checkbox', 'radio', 'file'].includes(e.type)) || e.getAttribute('role') === 'button';
      const folhaTexto = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!(interativo || folhaTexto)) continue;
      if (cs.position === 'absolute' || cs.position === 'fixed' || cs.position === 'sticky' || cs.display === 'inline') continue;
      if (e.closest('[aria-hidden="true"]')) continue;
      const r = visivelRect(e); if (r) alvos.push([e, r]);
    }
    let n = 0;
    for (let i = 0; i < alvos.length && n < 40; i++) for (let j = i + 1; j < alvos.length && n < 40; j++) {
      const [a, ra] = alvos[i], [b, rb] = alvos[j];
      if (a.contains(b) || b.contains(a)) continue;
      const L = Math.max(ra.left, rb.left), R = Math.min(ra.right, rb.right), T = Math.max(ra.top, rb.top), B = Math.min(ra.bottom, rb.bottom);
      const w = R - L, hh = B - T; if (w <= 3 || hh <= 3) continue;
      const area = w * hh, menor = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (area < 40 || area / menor < .25) continue;
      const topo = document.elementFromPoint((L + R) / 2, (T + B) / 2);
      if (!topo || (!a.contains(topo) && !b.contains(topo))) continue; // outro painel está por cima dos dois: não é defeito de layout
      n++; achado('sobreposto', a, `cobre/é coberto por ${caminho(b)} “${texto(b)}” (${Math.round(area)}px²)`, { k: caminho(b) });
    }

    // 4) alvos de toque pequenos
    for (const [e, cs] of info) {
      const t = e.tagName.toUpperCase();
      const inter = t === 'BUTTON' || (t === 'A' && e.hasAttribute('href')) || t === 'SELECT' || t === 'SUMMARY' || (t === 'INPUT' && ['checkbox', 'radio'].includes(e.type)) || e.getAttribute('role') === 'button';
      if (!inter) continue;
      if (cs.display === 'inline' && t === 'A') continue; // link dentro de frase
      let r = e.getBoundingClientRect();
      if (t === 'INPUT') { const l = e.closest('label'); if (l) r = l.getBoundingClientRect(); }
      if (Math.min(r.width, r.height) < 32) achado('alvo-pequeno', e, `${Math.round(r.width)}×${Math.round(r.height)}px (mínimo recomendado 44, aceitável 32)`, { k: 'toque' });
    }

    // 5) letra minúscula e 6) contraste fraco
    for (const [e, cs] of info) {
      if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
      const fs = parseFloat(cs.fontSize);
      if (fs < 12) achado('letra-pequena', e, `${fs.toFixed(1)}px`, { k: 'fonte' });
      const fg = claro(cs.color), bg = fundoEfetivo(e);
      if (bg && fg[3] === undefined || (bg && fg[3] > .9)) {
        const L1 = lum(fg), L2 = lum(bg), r = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
        const grande = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight) >= 700);
        if (r < (grande ? 3 : 4.5) && !e.closest('[disabled]') && !e.disabled) achado('contraste-fraco', e, `razão ${r.toFixed(2)}:1 (cor ${cs.color} sobre ${bg.join(',')}; mínimo ${grande ? 3 : 4.5})`, { k: 'cor' });
      }
    }
  }
  if (window.__AUD_ESC) setInterval(() => document.documentElement.style.setProperty('--esc', String(window.__AUD_ESC)), 400);
  let t = null; const agendar = () => { clearTimeout(t); t = setTimeout(() => { try { auditar(); } catch (e) { rel({ tipo: 'erro-auditor', detalhe: String(e) }); } }, 350); };
  new MutationObserver(agendar).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'open', 'style'] });
  addEventListener('load', agendar); addEventListener('resize', agendar); document.addEventListener('DOMContentLoaded', agendar);
  // várias rodadas depois de abrir: as animações de entrada terminam em ~600 ms
  setInterval(agendar, 2500);
})();
