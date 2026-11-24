/* FLUXOGRAMA: entrada (status de um exame vindo do chat ou do Klingo) -> validação (status desconhecido vira "sem passo", nunca erro) -> lógica (traduz tudo para um passo único: Pedido, Pedido pronto, Marcado, Confirmado, Chegou, Exame feito, Resultado, e os desvios Faltou, Cancelou, Remarcando, Não concluído; diz o que a equipe faz a seguir) -> saída ({ id, rotulo, ordem, desvio, proximo, precisaAcao } e um resumo do paciente)
   Versão 1.0 — 02/11/2026 / Mudança: Implementação inicial

   Um lugar só define o passo a passo do paciente (do pedido à entrega do resultado). O painel pergunta aqui em vez de repetir a regra em cada tela.
   Para mudar o caminho (um passo novo, outro texto) mexe-se só neste arquivo. Roda no navegador e no Node (testes/paciente-status.test.mjs).
   O resultado (laudo) ainda não vem do Klingo: o passo "Resultado" só existe quando o sistema passar a receber isso (ver docs/klingo-relatorios-pendentes.md). */
(function (raiz, fabrica) {
  'use strict';
  const P = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = P;
  if (raiz) raiz.PacienteStatus = P;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  // Caminho normal, em ordem.
  const CAMINHO = [
    { id: 'pedido', rotulo: 'Pedido', proximo: 'A equipe completa o pedido' },
    { id: 'pronto', rotulo: 'Pedido pronto', proximo: 'A equipe marca o horário' },
    { id: 'marcado', rotulo: 'Marcado', proximo: 'Confirmar com o paciente e aguardar o dia' },
    { id: 'confirmado', rotulo: 'Confirmado', proximo: 'Aguardar a chegada' },
    { id: 'chegou', rotulo: 'Chegou', proximo: 'Acompanhar o atendimento' },
    { id: 'atendido', rotulo: 'Exame feito', proximo: 'Entregar o resultado ao paciente' },
    { id: 'laudo', rotulo: 'Resultado', proximo: 'Concluído' },
  ];
  // Fora do caminho: precisam de uma decisão da equipe.
  const DESVIOS = {
    rascunho: { rotulo: 'Não concluído', proximo: 'Perguntar ao paciente se quer continuar o pedido' },
    faltou: { rotulo: 'Faltou', proximo: 'Oferecer um novo horário ou registrar que o paciente recusou' },
    cancelou: { rotulo: 'Cancelou', proximo: 'Oferecer de novo ou registrar que o paciente recusou' },
    remarcou: { rotulo: 'Remarcando', proximo: 'Acompanhar a remarcação até o novo horário' },
  };
  // Cada origem fala de um jeito: aqui tudo vira um id do caminho ou do desvio.
  const DO_CHAT = { rascunho: 'rascunho', pronto: 'pronto', marcado: 'marcado', agendado: 'marcado', compareceu: 'atendido', faltou: 'faltou', cancelou: 'cancelou', remarcou: 'remarcou' };
  const DO_KLINGO = { pedido: 'pedido', agendado: 'marcado', confirmado: 'confirmado', chegou: 'chegou', atendido: 'atendido', laudo: 'laudo', faltou: 'faltou', cancelado: 'cancelou', cancelada: 'cancelou', remarcado: 'remarcou' };
  const TABELAS = { chat: DO_CHAT, klingo: DO_KLINGO };
  const PRECISA_ACAO = new Set(['rascunho', 'pronto', 'faltou', 'cancelou', 'remarcou', 'atendido']);

  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

  // passo('faltou', 'klingo') -> { id, rotulo, ordem, desvio, proximo, precisaAcao }. Desconhecido: id null, sem erro.
  function passo(status, origem) {
    const id = (TABELAS[origem] || DO_CHAT)[norm(status)];
    if (!id) return { id: null, rotulo: String(status || 'Sem status'), ordem: 0, desvio: false, proximo: '', precisaAcao: false };
    if (DESVIOS[id]) return { id, rotulo: DESVIOS[id].rotulo, ordem: 0, desvio: true, proximo: DESVIOS[id].proximo, precisaAcao: true };
    const i = CAMINHO.findIndex((p) => p.id === id);
    return { id, rotulo: CAMINHO[i].rotulo, ordem: i + 1, desvio: false, proximo: CAMINHO[i].proximo, precisaAcao: PRECISA_ACAO.has(id) };
  }

  // resumo([{ status, origem }]) -> { total, pedindoAcao, porPasso, maisAvancado (id do caminho) }
  function resumo(itens) {
    const lista = Array.isArray(itens) ? itens : [];
    const porPasso = {}; let pedindoAcao = 0, maior = 0, maisAvancado = null;
    for (const x of lista) {
      const p = passo(x && x.status, x && x.origem);
      const k = p.id || 'desconhecido'; porPasso[k] = (porPasso[k] || 0) + 1;
      if (p.precisaAcao) pedindoAcao++;
      if (!p.desvio && p.ordem > maior) { maior = p.ordem; maisAvancado = p.id; }
    }
    return { total: lista.length, pedindoAcao, porPasso, maisAvancado };
  }

  return { CAMINHO, DESVIOS, passo, resumo };
});
