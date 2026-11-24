/* CSI WebChat — TESTE: camada de integração SIMULADA (homologação).
   Nada aqui usa rede: catálogo, convênios, horários, marcação e solicitações são FICTÍCIOS e ficam só neste navegador (localStorage "teste_*").
   O contrato (nomes e formatos) espelha as funções reais do motor, para a troca futura ser pontual:
     catalogo()            ~ chat_exames_buscar / chat_consultas
     convenios()           ~ convênios que restringem as agendas (reais, do catalogo_agenda)
     disponibilidade()     ~ chat_horarios / chat-agenda-api   (HOJE: grade real das médicas, de agenda-real.js; ainda não é a disponibilidade ao vivo do Klingo)
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
  async function catalogo() {
    await espera(250);
    const c = config();
    return CATALOGO.map((p) => Object.assign({}, p, { ativo: !c.exames_inativos.includes(p.id) }));
  }
  async function convenios() { await espera(150); return convenios_(); }

  /* ---------- grade REAL das médicas (snapshot de leitura da produção; ver agenda-real.js) ---------- */
  const NOME_MIN = ['de', 'da', 'do', 'dos', 'das', 'e', 's/a'];
  const bonito = (n) => String(n).toLowerCase().split(' ').map((w, i) => (i && NOME_MIN.includes(w) ? (w === 's/a' ? 'S/A' : w) : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const pid = (procId) => Number(String(procId).replace(/^c-/, ''));
  const GRADE = () => (window.CSI_AGENDA_REAL && window.CSI_AGENDA_REAL.grade) || [];
  const gradeDe = (procId) => GRADE().filter((g) => g[0] === pid(procId));
  // Convênios que aparecem nas restrições das agendas reais (os demais convênios da clínica não restringem a grade). "OUTRO" = não está na lista.
  function convenios_() {
    const ops = new Set(); GRADE().forEach((g) => (g[9] || []).forEach((o) => { if (o !== 'Particular') ops.add(o); }));
    return [...ops].sort().map((o) => ({ id: o, nome: bonito(o) })).concat([{ id: 'OUTRO', nome: 'Outro convênio' }]);
  }
  // A agenda aceita o pagador? operadoras null = sem restrição (suposição a confirmar).
  const aceita = (g, pagador) => !g[9] || !pagador || g[9].some((o) => o.toLowerCase() === String(pagador).toLowerCase());
  // Todos os horários da grade (28 dias) para a consulta e o pagador; marca os que a regra de antecedência segura.
  function gerarSlots({ procId, pagador = '', diasAdiante = 28 }) {
    const c = config(), agora = new Date(), limite = new Date(agora.getTime() + c.antecedencia_horas * 3600e3);
    const grade = gradeDe(procId).filter((g) => aceita(g, pagador)), out = [];
    for (let i = 0; i <= diasAdiante; i++) {
      const d = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + i), dd = iso(d), ds = d.getDay();
      for (const [, prof, dia, ini, fim, dur, local, vi, vf] of grade) {
        if (dia !== ds || dd < vi || dd > vf) continue;
        const [h1, m1] = ini.split(':').map(Number), [h2, m2] = fim.split(':').map(Number);
        for (let t = h1 * 60 + m1; t + dur <= h2 * 60 + m2; t += dur) {
          const quando = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(t / 60), t % 60);
          if (quando <= agora) continue;
          out.push({ data: dd, hora: String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'), profissional: bonito(prof), profId: prof, local: bonito(local), unidade: 'Desenvoar', segurada: quando < limite, dow: ds, min: t });
        }
      }
    }
    return out;
  }
  // Médicas que atendem esse pagador nessa consulta, com quantos horários livres (pela grade) já passam na regra.
  async function medicos(procId, pagador = '') {
    await espera(200);
    const slots = gerarSlots({ procId, pagador }), porMed = new Map();
    for (const sl of slots) { const m = porMed.get(sl.profId) || { id: sl.profId, nome: sl.profissional, horarios: 0, segurados: 0 }; if (sl.segurada) m.segurados++; else m.horarios++; porMed.set(sl.profId, m); }
    return [...porMed.values()].sort((a, b) => a.nome.localeCompare(b.nome));
  }
  // Horários = a grade real de cada médica, filtrada por convênio e médica escolhidos (sem descontar horários já ocupados).
  async function disponibilidade({ procId, medico = '', pagador = '' } = {}) {
    await espera(450);
    const c = config();
    if (c.simular_falha) { const e = new Error('Integração simulada indisponível'); e.codigo = 'integracao_fora'; throw e; }
    const todos = gerarSlots({ procId, pagador }).filter((x) => !medico || medico === 'qualquer' || x.profId === medico);
    const porDia = new Map(); let bloqueadosPelaRegra = 0;
    for (const x of todos) { if (x.segurada) { bloqueadosPelaRegra++; continue; } if (!porDia.has(x.data)) porDia.set(x.data, []); porDia.get(x.data).push(x); }
    const dias = [...porDia.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([data, hs]) => ({ data, horarios: hs.sort((a, b) => a.min - b.min || a.profissional.localeCompare(b.profissional)) }));
    return { dias, bloqueadosPelaRegra, existentes: todos.length, antecedenciaHoras: c.antecedencia_horas };
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
      tipo: preMarcacao ? 'pre_marcacao' : 'marcacao', motivo, remarcacoes: 0, dados
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

  window.CSI_SIM = { catalogo, convenios, medicos, disponibilidade, marcar, config, configSalvar, configRestaurar, solicitacoes, solicitacaoAtualizar, solicitacoesApagarTudo, CATALOGO, iso };
})();
