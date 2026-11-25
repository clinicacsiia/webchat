/* CSI WebChat — camada de integração da tela do teste v20261125a em PRODUÇÃO (só no piloto).
   FLUXOGRAMA: entrada (index.html chama CSI_SIM.ligar com a conversa já criada, com PIN) -> validação (leituras de horários e planos: funções de leitura do Klingo)
     -> lógica (marcar() conduz o motor do banco e entrega o que não sabe responder à tela por etapas) -> saída (marcação real; 'Acompanhe seus pedidos').
   Versão 1.0 — 25/11/2026 / Mudança: criada a partir de integracao-simulada.js; marcar() agora é real (docs/integracao-teste-no-piloto.md).
   O que segue do teste (leituras):
   O contrato (nomes e formatos) espelha as funções reais do motor, para a troca futura ser pontual:
     catalogo()            ~ chat_exames_buscar / chat_consultas
     convenios()           ~ convênios que restringem as agendas (reais, do catalogo_agenda)
     disponibilidade()     ~ chat_horarios / chat-agenda-api   (HOJE: horários REAIS do Klingo ao vivo, pela função teste-agenda-klingo, só leitura)
     marcar()              ~ chat_horario_escolher + klingo-executar   (AQUI É REAL: conduz o motor; ver bloco MARCAR DE VERDADE)
     solicitacoes*()       ~ app_pedidos / "Acompanhe seus pedidos"
   Regras de negócio (antecedência, ativação de exames, exigência de carteirinha, política) ficam na CONFIG, não na tela. */
(function () {
  'use strict';
  const K_CFG = 'csi_marc_config_v1';
  const ler = (k, pad) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? pad : v; } catch { return pad; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };   // false = não coube / sem armazenamento (quem chama avisa o paciente)
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
    'Você pode cancelar ou remarcar sem custo até 24 horas antes do horário marcado.',
    'Com menos de 24 horas, o cancelamento deve ser feito pelo telefone da clínica.',
    'Cada solicitação pode ser remarcada até 2 vezes pelo site.',
    'Se faltar sem avisar, o horário é liberado e uma nova marcação pode precisar de confirmação da equipe.',
    'A pré-marcação não garante o horário. Ele só vale depois que a equipe confirmar com você.'
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
  async function convenios() { return convenios_(); }

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
    if (!naApi(procId)) return { estado: 'fora_do_escopo', motivo: 'Esta consulta é agendada apenas pela equipe.', slots: [] };
    const chave = pid(procId) + '|' + String(pagador).toLowerCase() + '|' + c.antecedencia_horas, c0 = vivo.get(chave);
    if (c0 && Date.now() - c0.t < 60000) return c0.r;
    const chamar = async (janela) => {
      const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CHAVE_PUB, Authorization: 'Bearer ' + CHAVE_PUB }, body: JSON.stringify({ consulta: pid(procId), pagador, janela, semFiltro: true }) });
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
      const [y, m, d] = h.data.split('-').map(Number), [H, M] = h.hora.split(':').map(Number), quando = new Date(Date.UTC(y, m - 1, d, H + 3, M));   // horário da Bahia (UTC-3, sem horário de verão): não depende do fuso do aparelho
      slots.push({ data: h.data, hora: h.hora, profissional: bonito(h.profissional || 'Médico(a)'), profId: String(h.profissionalId || h.profissional || 'sem-nome'), local: '', unidade: h.unidade ? bonito(h.unidade) : 'Desenvoar', segurada: quando < limite, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay(), min: H * 60 + M });
    }
    const r = { estado: slots.length ? 'com_horarios' : 'sem_horarios', motivo: rs[0].motivo || '', slots, truncado: rs.some((x) => x.truncado), consultadoEm: rs[0].consultadoEm || new Date().toISOString() };
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
    const c = config();
    return CATALOGO.map((p) => Object.assign({}, p, { ativo: !c.exames_inativos.includes(p.id), naApi: naApi(p.id) }));
  }
  // Médicas com horário real para o pagador (e quantos horários passam na regra de antecedência).
  async function medicos(procId, pagador = '') {
    const r = await buscarAoVivo(procId, pagadorChave(pagador)), por = new Map();
    for (const sl of r.slots) { const m = por.get(sl.profId) || { id: sl.profId, nome: sl.profissional, horarios: 0, segurados: 0 }; if (sl.segurada) m.segurados++; else m.horarios++; por.set(sl.profId, m); }
    return { estado: r.estado, motivo: r.motivo, truncado: !!r.truncado, consultadoEm: r.consultadoEm, lista: [...por.values()].sort((a, b) => a.nome.localeCompare(b.nome)) };
  }
  // Horários reais do Klingo, filtrados pela(s) médica(s) escolhida(s) e pela regra de antecedência.
  async function disponibilidade({ procId, medico = '', pagador = '' } = {}) {
    const c = config(), r = await buscarAoVivo(procId, pagadorChave(pagador));
    if (r.estado === 'indisponivel' || r.estado === 'limite') { const e = new Error('Klingo indisponível'); e.codigo = r.estado; throw e; }
    const todos = r.slots.filter((x) => !medico || medico === 'qualquer' || x.profId === medico), por = new Map(); let bloqueadosPelaRegra = 0;
    for (const x of todos) { if (x.segurada) { bloqueadosPelaRegra++; continue; } if (!por.has(x.data)) por.set(x.data, []); por.get(x.data).push(x); }
    const dias = [...por.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([data, hs]) => ({ data, horarios: hs.sort((a, b) => a.min - b.min || a.profissional.localeCompare(b.profissional)) }));
    return { dias, bloqueadosPelaRegra, truncado: !!r.truncado, existentes: todos.length, antecedenciaHoras: c.antecedencia_horas, consultadoEm: r.consultadoEm };
  }


  /* ---------- MARCAR DE VERDADE: conduz o motor do banco (as mesmas funções e travas do chat de hoje) ----------
     A tela do teste junta todas as respostas; aqui elas são entregues ao motor na ORDEM DELE (cadastro, consulta, médico, plano, horário, confirmar).
     Qualquer pergunta que esta camada não sabe responder (pré-marcação, valor Particular, carteirinha, endereço…) NÃO é adivinhada:
     a conversa segue na tela por etapas, na MESMA conversa (erro com codigo 'continuar'). */
  const LIG = { db: null, conv: null, aoDados: null };
  const ligar = (o) => Object.assign(LIG, o);
  const nm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const sair = (motivo) => { const e = new Error('continuar'); e.codigo = 'continuar'; e.motivo = motivo; return e; };
  async function rpc(nome, args) {
    const { data, error } = await LIG.db.rpc(nome, args);
    if (error) { if (/pin_obrigatorio/i.test(error.message || '')) { const e = new Error('pin'); e.codigo = 'pin'; throw e; } throw error; }
    return data;
  }
  const base = () => ({ p_conversa: LIG.conv.id, p_token: LIG.conv.token });
  async function pergunta() {
    const r = await rpc('chat_listar', Object.assign(base(), { p_apos: 0 }));
    const ms = (r && r.mensagens) || [];
    const p = [...ms].reverse().find((m) => m.autor === 'agente' && m.opcoes && typeof m.opcoes === 'object');
    return { r, p, aberta: !!(r && r.motor_ativo !== false && (!r.status || r.status === 'aguardando')) };
  }
  const responder = (passo, valor, texto) => rpc('chat_responder', Object.assign(base(), { p_passo: passo, p_valor: valor, p_texto: texto || null }));
  async function agendaApi(janela, fresco) {
    try { const { data } = await Promise.race([LIG.db.functions.invoke('chat-agenda-api', { body: { conversa: LIG.conv.id, token: LIG.conv.token, janela, fresco } }), new Promise((_, no) => setTimeout(() => no(new Error('tempo')), 14000))]); return data || null; } catch { return null; }
  }
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const achar = (itens, alvo, extra) => {
    const a = nm(alvo); if (!a) return null;
    return (itens || []).find((i) => nm(i.valor) === a || nm(i.rotulo) === a) || (itens || []).find((i) => nm(i.rotulo).includes(a) || a.includes(nm(i.rotulo))) || (extra ? (itens || []).find((i) => nm(i.valor) === nm(extra)) : null) || null;
  };
  const protocolo = () => 'CSI-' + LIG.conv.id.slice(0, 8).toUpperCase();
  // Foto da carteirinha: vai para a conversa (mesma função que o chat usa para anexos); se falhar, a equipe pede a foto depois.
  async function enviarFoto(dados) {
    if (!dados.fotoCart || LIG.fotoEnviada === LIG.conv.id) return;
    try { await rpc('chat_anexo_enviar', Object.assign(base(), { p_mime: 'image/jpeg', p_base64: dados.fotoCart, p_ocr: null })); LIG.fotoEnviada = LIG.conv.id; } catch (e) { if (e && e.codigo === 'pin') throw e; /* segue sem a foto */ }
  }
  // Ciência da pré-marcação gravada NO SERVIDOR (hora, IP e aparelho).
  async function registrarCiencia(dados, motivo) {
    if (LIG.cienciaFeita === LIG.conv.id) return;
    const c = (dados.preferencia && dados.preferencia.ciencia) || {};
    await rpc('marcacao_ciencia_registrar', Object.assign(base(), { p_aparelho: { aparelho: c.aparelho || '', fuso: c.fuso || '', navegador: c.navegador || '', idioma: navigator.language || '', tela: screen.width + 'x' + screen.height }, p_motivo: motivo || null }));
    LIG.cienciaFeita = LIG.conv.id;
  }
  const NAO_SEI = 'nao_sei';
  // Conduz o motor. pre = true: pré-marcação (o que a pessoa não soube vira "Não sei" e o pedido vai para a equipe).
  async function marcar(dados, { preMarcacao = false, motivo = '' } = {}) {
    if (!LIG.db || !LIG.conv) throw sair('sem conversa');
    const pre = !!preMarcacao, vistos = {};
    const resultado = () => ({ protocolo: protocolo(), criadoEm: new Date().toISOString(), status: pre ? 'aguardando_equipe' : 'marcado', tipo: pre ? 'pre_marcacao' : 'marcacao', motivo: pre ? motivo : '', remarcacoes: 0, venceEm: null, dados });
    if (pre) await registrarCiencia(dados, motivo);
    await enviarFoto(dados);
    for (let volta = 0; volta < 30; volta++) {
      const { p, aberta } = await pergunta();
      if (!p) throw sair('sem pergunta');
      const o = p.opcoes, passo = o.passo || o.tipo;
      if (o.tipo === 'marcado' || o.tipo === 'acompanhar' || o.tipo === 'despedida' || o.tipo === 'nova') return resultado();
      if (!aberta) { if (pre) return resultado(); throw sair('equipe assumiu'); }
      if (o.tipo === 'marcando' || o.tipo === 'espera') { if (pre) return resultado(); await new Promise((r) => setTimeout(r, 2500)); vistos.espera = (vistos.espera || 0) + 1; if (vistos.espera > 28) throw sair('demora'); continue; }
      vistos[passo] = (vistos[passo] || 0) + 1;
      if (vistos[passo] > 2) throw sair('sem avanço em ' + passo);   // a mesma pergunta voltou: não insiste
      if (passo === 'cpf_nasc' || passo === 'cpf_confirma' || passo === 'identidade') { const ok = LIG.aoDados ? await LIG.aoDados() : false; if (!ok) throw sair('cadastro'); continue; }
      if (passo === 'motivo') { await responder('motivo', 'consulta', 'Consulta'); continue; }
      if (o.tipo === 'pedido_consulta') {
        const r = await rpc('chat_consultas', base());
        if (r && r.sem_unidade_autorizada) throw sair('unidade');
        const c = achar((r.consultas || []).map((x) => ({ valor: x.id, rotulo: x.rotulo })), dados.procNome);
        if (!c) throw sair('consulta');
        await rpc('chat_consulta_salvar', Object.assign(base(), { p_procedimento_id: c.valor })); continue;
      }
      if (passo === 'medico') {
        const livre = !dados.medico || dados.medico === 'qualquer';
        const it = livre ? (o.itens || []).find((i) => i.valor === '') : achar(o.itens, dados.medicoNome || (dados.slot && dados.slot.profissional));
        if (!it) throw sair('médico');
        await responder('medico', it.valor, it.rotulo); continue;
      }
      if (passo === 'plano') {
        if (dados.pagto === 'particular') { const it = (o.itens || []).find((i) => nm(i.valor) === 'particular'); if (!it) throw sair('pagamento'); await responder('plano', it.valor, it.rotulo); continue; }
        const it = dados.convId && dados.convId !== NAO_SEI ? achar(o.itens, dados.convId || dados.convenio) : null;
        if (it) { await responder('plano', it.valor, it.rotulo); continue; }
        if (pre) { await responder('plano', { outro: 'Não sei' }, 'Não sei'); continue; }   // não sabe pagamento/convênio: o motor leva para a equipe
        throw sair('convênio');
      }
      if (passo === 'plano_exato') {
        const it = dados.plano && dados.plano !== NAO_SEI ? achar(o.itens, dados.plano, dados.planoId) : null;
        if (it && it.valor !== NAO_SEI) { await responder('plano_exato', it.valor, it.rotulo); continue; }
        if (pre) { await responder('plano_exato', NAO_SEI, 'Não sei qual é o meu plano'); continue; }
        throw sair('plano');
      }
      if (passo === 'plano_confirma') { await responder('plano_confirma', 'sim', 'Sim, é o mesmo'); continue; }
      if (passo === 'dados_carteira' && pre) { await responder('dados_carteira', { pular: true }, null); continue; }
      if (o.tipo === 'calendario') {
        const grupo = o.grupo || 1;
        if (!dados.slot) { if (pre) { await responder('horario', 'sem_horario', 'Nenhum horário serve para mim'); continue; } throw sair('horário'); }
        await agendaApi(0, false);
        const hoje = new Date();
        const r = await rpc('chat_horarios', Object.assign(base(), { p_grupo: grupo, p_de: ymd(hoje), p_ate: ymd(new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + 45)), p_unidade: null, p_periodo: null }));
        const sl = ((r && r.dias) || []).flatMap((d) => (d.slots || []).map((s) => Object.assign({ data: d.data }, s))).find((s) => s.data === dados.slot.data && s.hora === dados.slot.hora);
        if (!sl) { if (pre) { await responder('horario', 'sem_horario', 'Nenhum horário serve para mim'); continue; } throw sair('horário indisponível'); }
        await agendaApi(0, true);
        try { await rpc('chat_horario_escolher', Object.assign(base(), { p_grupo: grupo, p_data: sl.data, p_hora: sl.hora, p_unidade: sl.unidade || null })); }
        catch (e) { if (e && e.code === 'P0002') throw sair('horário ocupado'); throw e; }
        continue;
      }
      if (passo === 'valor') {   // Particular: o paciente precisa ver e concordar com o valor (a tela do teste mostra e chama responderValor)
        const e = new Error('valor'); e.codigo = 'valor'; e.destaque = o.destaque || null; e.texto = p.texto || ''; e.itens = o.itens || []; throw e;
      }
      if (passo === 'confirmar') { await responder('confirmar', 'ok', 'Está tudo certo'); continue; }
      throw sair(passo);   // dados do cadastro (endereço, contato…), previsão…: a tela por etapas pergunta
    }
    throw sair('muitas voltas');
  }
  const responderValor = async (v) => { await responder('valor', v, v === 'sim' ? 'Concordo com o valor e quero marcar' : 'Não quero marcar por causa do valor'); };
  // "Não, obrigado: quero falar com a equipe": vira pedido de atendente na fila do painel (o mesmo "Falar com um atendente" do chat).
  function avisoWhatsapp(dados) {
    if (LIG.db && LIG.conv) pergunta().then(({ p }) => { const passo = p && p.opcoes && (p.opcoes.passo || ''); if (passo) return responder(passo, { acao: 'atendente' }, null); }).catch(() => {});
    return { protocolo: LIG.conv ? protocolo() : 'CSI-WHATS', criadoEm: new Date().toISOString(), status: 'aviso_equipe', tipo: 'contato_whatsapp', remarcacoes: 0, dados };
  }
  const solicitacoes = () => [], solicitacaoAtualizar = () => null, solicitacoesApagarTudo = () => {};

  window.CSI_SIM = { catalogo, convenios, planos, medicos, disponibilidade, marcar, responderValor, avisoWhatsapp, config, configSalvar, configRestaurar, solicitacoes, solicitacaoAtualizar, solicitacoesApagarTudo, CATALOGO, iso, ligar, get aoMenu() { return LIG.aoMenu; }, get aoPin() { return LIG.aoPin; }, get aoEtapas() { return LIG.aoEtapas; }, get aoAcompanhar() { return LIG.aoAcompanhar; } };
})();
