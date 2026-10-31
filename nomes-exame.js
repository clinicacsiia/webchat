/* FLUXOGRAMA: entrada (nome do exame como vem do Klingo: caixa alta, prefixo técnico, "(UNILATERAL)", texto cortado) -> validação (tira o ruído, separa o que está entre parênteses, detecta nome cortado) -> lógica (título em frase normal + detalhe em letra menor; ordena os exames comuns primeiro; junta os que ficam iguais na tela) -> saída ({ titulo, detalhe, chave } para o chat desenhar)
   Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial

   Os nomes vêm de uma tabela de convênio e foram feitos para faturar, não para o paciente escolher:
     "RM MÃO (NÃO INCLUI PUNHO)"                              -> Mão            · Não inclui punho
     "RM DE MÃO E PUNHO - INCLUI ARTRO-RESSONÂNCIA (UNILATERAL)" -> Mão e punho    · Inclui artro-ressonância
   O código do exame (id) nunca muda: só o texto mostrado. Roda no navegador e no Node (testes/nomes-exame.test.mjs). */
(function (raiz, fabrica) {
  'use strict';
  const N = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = N;
  if (raiz) raiz.NomesExame = N;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const SIGLAS = new Set(['RM', 'RNM', 'TC', 'US', 'USG', 'RX', 'ATM', 'PCT', 'PET', 'CT', 'TV', 'ECG', 'DEXA']);
  const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Frase normal: tudo minúsculo, siglas em maiúsculo e a primeira letra maiúscula.
  function frase(t) {
    const s = String(t || '').toLowerCase().replace(/\p{L}+/gu, (p) => (SIGLAS.has(p.toUpperCase()) ? p.toUpperCase() : p)).trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  // "RM", "TC", "US"... no começo repete o tipo de exame que o paciente já escolheu.
  const PREFIXO = /^(?:(?:RM|RNM|TC|USG|US)\s+|ULTRA-SONOGRAFIA(?:\s+DE)?\s+)(?:(?:DE|DO|DA|DOS|DAS)\s+)?/i;

  // apresentar(nome, { semPrefixo, regiao }) -> { titulo, detalhe, chave, unilateral }
  // "regiao" é o nome da parte do corpo escolhida (ex.: "Punho / mão"): o exame genérico "por articulação" vale para ela.
  function apresentar(bruto, opcoes) {
    const o = opcoes || {};
    let t = String(bruto || '').replace(/\s+/g, ' ').trim();
    const unilateral = /\bUNILATERAL\b/i.test(t);
    const cortado = (t.match(/\(/g) || []).length > (t.match(/\)/g) || []).length;   // o banco guarda só os primeiros caracteres de alguns nomes
    // O lado o paciente escolhe à parte: "(UNILATERAL)" só atrapalha.
    t = t.replace(/\(\s*UNILATERAL\s*\)/gi, ' ').replace(/\bUNILATERAL\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (o.semPrefixo) { const sem = t.replace(PREFIXO, ''); if (sem.replace(/[^\p{L}]/gu, '').length >= 3) t = sem; }
    let titulo = t, detalhe = '';
    const p = /^(.*?)\s*\(([^)]*)\)?\s*(.*)$/.exec(t);   // primeiro parêntese, fechado ou cortado
    if (p && p[1]) { titulo = p[1]; detalhe = [p[2], p[3]].map((x) => x.trim()).filter(Boolean).join(' · '); }
    const h = /^(.*?)\s+-\s+(.+)$/.exec(titulo);   // "MÃO E PUNHO - INCLUI ARTRO-RESSONÂNCIA"
    if (h && h[1]) { titulo = h[1]; detalhe = [h[2], detalhe].filter(Boolean).join(' · '); }
    titulo = frase(titulo.replace(/[\s,;:-]+$/, ''));
    detalhe = frase(detalhe.replace(/[\s,;:-]+$/, ''));
    if (cortado) { if (detalhe) detalhe += '…'; else titulo += '…'; }
    // "Articular (por articulação)" não diz qual articulação: vale a parte do corpo que o paciente escolheu.
    const articulacao = /^articula(?:r|cao|coes)…?$/.test(semAcento(titulo));
    if (articulacao) { titulo = o.regiao ? `Articulação (${o.regiao})` : 'Articulação'; detalhe = 'Exame de uma articulação só'; }
    // Palavras técnicas explicadas em linguagem simples.
    if (/artro-ressonância/i.test(detalhe) && !/contraste/i.test(detalhe)) detalhe = detalhe.replace(/artro-ressonância/i, 'artro-ressonância (contraste injetado na articulação)');
    if (/\bANGIO/i.test(bruto) && !/vasos/i.test(detalhe)) detalhe = [detalhe, 'Estuda os vasos sanguíneos'].filter(Boolean).join(' · ');
    return { titulo: titulo || frase(bruto), detalhe, unilateral, articulacao, chave: semAcento(titulo + '|' + detalhe).replace(/[^a-z0-9|]/g, '') };
  }

  // Exames de uso comum primeiro (nome simples), os especiais (angio, estresse, PCT, contraste...) depois, e por fim os com muita explicação.
  const ESPECIAL = /ANGIO|PCT|PRIMOVIST|NEURONAV|TRACTOGRAF|ESTRESSE|FETAL|TRANSESOF|ARTRO|PERFUS|CINE|FERRO|ELASTOGRAF|HIDRO|COLANGIO|ENTERO|INTRACARD|MARCA/i;
  const peso = (nome) => (ESPECIAL.test(nome) ? 2 : /\(|-/.test(nome) ? 1 : 0);
  // Recebe os exames ({ id, nome, ... }) e devolve { principais, outros }: sem repetição na tela, comuns primeiro.
  function organizar(lista, opcoes, limite) {
    const max = limite || 5, vistos = new Set(), ok = [];
    const ordenados = (lista || []).map((e, i) => ({ e, i, a: apresentar(e.nome, opcoes) }))
      .sort((x, y) => peso(x.e.nome) - peso(y.e.nome) || x.a.titulo.length - y.a.titulo.length || x.i - y.i);
    for (const x of ordenados) { if (vistos.has(x.a.chave)) continue; vistos.add(x.a.chave); ok.push({ ...x.e, titulo: x.a.titulo, detalhe: x.a.detalhe, unilateral: !!(x.e.unilateral || x.a.unilateral) }); }
    return ok.length <= max + 1 ? { principais: ok, outros: [] } : { principais: ok.slice(0, max), outros: ok.slice(max) };
  }
  return { apresentar, organizar, frase };
});
