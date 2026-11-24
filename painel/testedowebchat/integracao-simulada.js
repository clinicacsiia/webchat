/* CSI WebChat — TESTE: camada de integração SIMULADA (homologação).
   Nada aqui usa rede: catálogo, convênios, horários, marcação e solicitações são FICTÍCIOS e ficam só neste navegador (localStorage "teste_*").
   O contrato (nomes e formatos) espelha as funções reais do motor, para a troca futura ser pontual:
     catalogo()            ~ chat_exames_buscar / chat_consultas
     convenios()           ~ convênios que restringem as agendas (reais, do catalogo_agenda)
     disponibilidade()     ~ chat_horarios / chat-agenda-api   (HOJE: horários REAIS do Klingo ao vivo, pela função teste-agenda-klingo, só leitura)
     marcar()              ~ chat_horario_escolher + klingo-executar   (aqui NUNCA chama o Klingo)
     solicitacoes*()       ~ app_pedidos / "Acompanhe seus pedidos"
   Regras de negócio (antecedência, ativação de exames, exigência de carteirinha, política) ficam na CONFIG, não na tela. */
(function () {
  'use strict';
  const K_CFG = 'teste_marc_config_v1', K_SOL = 'teste_marc_solicitacoes_v1';
  const ler = (k, pad) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? pad : v; } catch { return pad; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- catálogo fictício ---------- */
  // Lista oficial em produção (consultas_da_unidade, unidade DESENVOAR, 24/11/2026). Sem valor e sem médico: o chat real não os traz nesta etapa.
  const CATALOGO = [
    { id: 'c-1132', tipo: 'consulta', nome: 'Consulta com pediatra', detalhe: '9 profissionais', preco: null, preparo: '' },
    { id: 'c-1003', tipo: 'consulta', nome: 'Consulta de Cirurgia Pediátrica', detalhe: '1 profissional', preco: null, preparo: '' },
    { id: 'c-1474', tipo: 'consulta', nome: 'Consulta com ortopediatra', detalhe: '2 profissionais', preco: null, preparo: '' },
    { id: 'c-1470', tipo: 'consulta', nome: 'Consulta com endocrinopediatra', detalhe: '1 profissional', preco: null, preparo: '' },
    { id: 'c-1471', tipo: 'consulta', nome: 'Consulta com gastropediatra', detalhe: '1 profissional', preco: null, preparo: '' },
    { id: 'c-1472', tipo: 'consulta', nome: 'Consulta com neuropediatra', detalhe: '1 profissional', preco: null, preparo: '' },
    { id: 'c-2100', tipo: 'consulta', nome: 'Consulta pediátrica pré-natal', detalhe: '7 profissionais', preco: null, preparo: '' }
  ];
  const POLITICA_PADRAO = [
    'Cancelamento ou remarcação sem custo até 24 horas antes do horário marcado.',
    'Com menos de 24 horas, o cancelamento deve ser feito pelo telefone da clínica.',
    'Cada solicitação pode ser remarcada até 2 vezes pelo site.',
    'Faltou sem avisar? O horário é liberado e uma nova marcação pode precisar de confirmação da equipe.',
    'Pré-marcação não garante o horário: ela só vale depois que a equipe confirmar com você.'
  ];

  /* ---------- configuração (o que a diretoria vai ajustar) ---------- */
  const CFG_PADRAO = {
    prazo_pre_horas: 24,             // regra configurável: quanto tempo o paciente tem para completar uma pré-marcação (plano, carteirinha, médica e horário)
    antecedencia_horas: 24,          // regra configurável: horário com menos que isso só pela equipe (pré-marcação)
    exames_inativos: [],   // ativação/desativação por procedimento: inativo = só pré-marcação
    exigir_carteirinha: true,        // convênio exige foto da carteirinha para marcar
    simular_falha: false,            // simula a integração fora do ar
    politica: POLITICA_PADRAO
  };
  const config = () => Object.assign({}, CFG_PADRAO, ler(K_CFG, {}));
  const configSalvar = (parcial) => { gravar(K_CFG, Object.assign(config(), parcial)); };
  const configRestaurar = () => { try { localStorage.removeItem(K_CFG); } catch { /* ignora */ } };

  /* ---------- consultas ---------- */
  async function convenios() { await espera(150); return convenios_(); }

  /* ---------- horários REAIS do Klingo (função teste-agenda-klingo: só leitura, não grava nada) ---------- */
  const FN = 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/teste-agenda-klingo', CHAVE_PUB = 'sb_publishable_e2GK1YGEj06STa_ESCevow_nvtATB-y';
  const NOME_MIN = ['de', 'da', 'do', 'dos', 'das', 'e', 's/a'];
  const bonito = (n) => String(n).toLowerCase().split(' ').map((w, i) => (i && NOME_MIN.includes(w) ? (w === 's/a' ? 'S/A' : w) : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const pid = (procId) => Number(String(procId).replace(/^c-/, ''));
  const REAL = () => window.CSI_AGENDA_REAL || { convenios: [], consultasNaApi: [] };
  const naApi = (procId) => REAL().consultasNaApi.includes(pid(procId));
  function convenios_() { return REAL().convenios.map((o) => ({ id: o, nome: bonito(o) })).concat([{ id: 'OUTRO', nome: 'Outro convênio' }]); }
  // Uma consulta ao vivo (3 janelas = 45 dias), com cache de 60 s no navegador. Devolve { estado, motivo, slots, consultadoEm }.
  const vivo = new Map();
  async function buscarAoVivo(procId, pagador) {
    const c = config();
    if (c.simular_falha) return { estado: 'indisponivel', motivo: 'simulado', slots: [] };
    if (!naApi(procId)) return { estado: 'fora_do_escopo', motivo: 'A API do Klingo não oferece horários desta consulta; só a equipe agenda.', slots: [] };
    const chave = pid(procId) + '|' + String(pagador).toLowerCase(), c0 = vivo.get(chave);
    if (c0 && Date.now() - c0.t < 60000) return c0.r;
    const chamar = async (janela) => {
      const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CHAVE_PUB, Authorization: 'Bearer ' + CHAVE_PUB }, body: JSON.stringify({ consulta: pid(procId), pagador, janela }) });
      return r.json();
    };
    let rs;
    // 3 janelas de 15 dias = 45 dias (o Klingo aceita no máximo 15 dias por consulta)
    try { rs = await Promise.all([chamar(0), chamar(1), chamar(2)]); } catch { return { estado: 'indisponivel', motivo: 'rede', slots: [] }; }
    const ruim = rs.find((x) => !x || !x.ok);
    if (ruim) return { estado: ruim && ruim.estado === 'limite' ? 'limite' : 'indisponivel', motivo: (ruim && ruim.motivo) || 'erro', slots: [] };
    const sem = rs.find((x) => x.estado === 'fora_do_escopo' || x.estado === 'sem_plano');
    if (sem) { const r = { estado: sem.estado, motivo: sem.motivo, slots: [] }; vivo.set(chave, { t: Date.now(), r }); return r; }
    const limite = new Date(Date.now() + c.antecedencia_horas * 3600e3), slots = [];
    for (const x of rs) for (const h of x.horarios || []) {
      const [y, m, d] = h.data.split('-').map(Number), [H, M] = h.hora.split(':').map(Number), quando = new Date(y, m - 1, d, H, M);
      slots.push({ data: h.data, hora: h.hora, profissional: bonito(h.profissional || 'Médica(o)'), profId: h.profissional || '', local: '', unidade: h.unidade ? bonito(h.unidade) : 'Desenvoar', segurada: quando < limite, dow: quando.getDay(), min: H * 60 + M });
    }
    const r = { estado: slots.length ? 'com_horarios' : 'sem_horarios', motivo: rs[0].motivo || '', slots, consultadoEm: rs[0].consultadoEm || new Date().toISOString() };
    vivo.set(chave, { t: Date.now(), r });
    return r;
  }
  const pagadorChave = (p) => (p || '').trim();
  // Planos reais do convênio (função teste-planos-klingo, só leitura). Devolve { itens: [{valor, rotulo}], total } (no máximo 40, filtrados por `busca`).
  const FN_PLANOS = 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/teste-planos-klingo';
  async function planos(operadora, busca = '') {
    try {
      const r = await fetch(FN_PLANOS, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CHAVE_PUB, Authorization: 'Bearer ' + CHAVE_PUB }, body: JSON.stringify({ operadora, busca }) });
      const d = await r.json();
      return d && d.ok ? { itens: d.itens || [], total: d.total || 0, exato: !!d.exato } : { itens: [], total: 0, erro: true };
    } catch { return { itens: [], total: 0, erro: true }; }
  }
  // Consultas oferecidas. As que a API do Klingo não oferece ficam marcadas (a equipe agenda → pré-marcação).
  async function catalogo() {
    await espera(200);
    const c = config();
    return CATALOGO.map((p) => Object.assign({}, p, { ativo: !c.exames_inativos.includes(p.id), naApi: naApi(p.id) }));
  }
  // Médicas com horário real para o pagador (e quantos horários passam na regra de antecedência).
  async function medicos(procId, pagador = '') {
    const r = await buscarAoVivo(procId, pagadorChave(pagador)), por = new Map();
    for (const sl of r.slots) { const m = por.get(sl.profId) || { id: sl.profId, nome: sl.profissional, horarios: 0, segurados: 0 }; if (sl.segurada) m.segurados++; else m.horarios++; por.set(sl.profId, m); }
    return { estado: r.estado, motivo: r.motivo, consultadoEm: r.consultadoEm, lista: [...por.values()].sort((a, b) => a.nome.localeCompare(b.nome)) };
  }
  // Horários reais do Klingo, filtrados pela(s) médica(s) escolhida(s) e pela regra de antecedência.
  async function disponibilidade({ procId, medico = '', pagador = '' } = {}) {
    const c = config(), r = await buscarAoVivo(procId, pagadorChave(pagador));
    if (r.estado === 'indisponivel' || r.estado === 'limite') { const e = new Error('Klingo indisponível'); e.codigo = r.estado; throw e; }
    const todos = r.slots.filter((x) => !medico || medico === 'qualquer' || x.profId === medico), por = new Map(); let bloqueadosPelaRegra = 0;
    for (const x of todos) { if (x.segurada) { bloqueadosPelaRegra++; continue; } if (!por.has(x.data)) por.set(x.data, []); por.get(x.data).push(x); }
    const dias = [...por.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([data, hs]) => ({ data, horarios: hs.sort((a, b) => a.min - b.min || a.profissional.localeCompare(b.profissional)) }));
    return { dias, bloqueadosPelaRegra, existentes: todos.length, antecedenciaHoras: c.antecedencia_horas, consultadoEm: r.consultadoEm };
  }

  /* ---------- solicitações (marcadas e pré-marcadas) ---------- */
  const solicitacoes = () => ler(K_SOL, []);
  const solicitacoesSalvar = (l) => gravar(K_SOL, l);
  const protocolo = () => 'TESTE-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + String(Math.floor(Math.random() * 9000) + 1000);
  async function marcar(dados, { preMarcacao = false, motivo = '' } = {}) {
    await espera(700);
    // Simulação: NÃO chama Klingo, NÃO envia aviso/WhatsApp/e-mail/push. Só grava aqui.
    const s = {
      protocolo: protocolo(), criadoEm: new Date().toISOString(), status: preMarcacao ? 'aguardando_equipe' : 'marcado',
      tipo: preMarcacao ? 'pre_marcacao' : 'marcacao', motivo, remarcacoes: 0, dados,
      venceEm: preMarcacao ? new Date(Date.now() + config().prazo_pre_horas * 3600e3).toISOString() : null
    };
    const l = solicitacoes(); l.unshift(s); solicitacoesSalvar(l);
    return s;
  }
  function solicitacaoAtualizar(proto, mudar) {
    const l = solicitacoes(); const s = l.find((x) => x.protocolo === proto);
    if (s) { mudar(s); solicitacoesSalvar(l); }
    return s;
  }
  const solicitacoesApagarTudo = () => { try { localStorage.removeItem(K_SOL); } catch { /* ignora */ } };

  window.CSI_SIM = { catalogo, convenios, planos, medicos, disponibilidade, marcar, config, configSalvar, configRestaurar, solicitacoes, solicitacaoAtualizar, solicitacoesApagarTudo, CATALOGO, iso };
})();
