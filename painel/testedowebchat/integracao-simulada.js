/* CSI WebChat — TESTE: camada de integração SIMULADA (homologação).
   Nada aqui usa rede: catálogo, convênios, horários, marcação e solicitações são FICTÍCIOS e ficam só neste navegador (localStorage "teste_*").
   O contrato (nomes e formatos) espelha as funções reais do motor, para a troca futura ser pontual:
     catalogo()            ~ chat_exames_buscar / chat_consultas
     convenios(), planos() ~ catálogo de convênios do Klingo
     disponibilidade()     ~ chat_horarios / chat-agenda-api   (já aplica a regra configurável de antecedência)
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
  const CONVENIOS = [
    { id: 'conv-alfa', nome: 'Saúde Alfa (fictício)', planos: ['Alfa Básico', 'Alfa Plus', 'Alfa Empresarial'] },
    { id: 'conv-beta', nome: 'Beta Vida (fictício)', planos: ['Beta Enfermaria', 'Beta Apartamento'] },
    { id: 'conv-gama', nome: 'Gama Saúde (fictício)', planos: ['Gama Mais'] }
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
  async function convenios() { await espera(150); return CONVENIOS.map((c) => ({ id: c.id, nome: c.nome })); }
  async function planos(convId) { await espera(150); const c = CONVENIOS.find((x) => x.id === convId); return c ? c.planos.slice() : []; }

  // Horários determinísticos (mesmo procedimento + dia = mesma grade). Os dias e horários variam por procedimento.
  const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const sem = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
  async function disponibilidade({ procId, diasAdiante = 21 } = {}) {
    await espera(600);
    const c = config();
    if (c.simular_falha) { const e = new Error('Integração simulada indisponível'); e.codigo = 'integracao_fora'; throw e; }
    const proc = CATALOGO.find((p) => p.id === procId);
    if (!proc) throw new Error('Procedimento desconhecido');
    const agora = new Date(), limite = new Date(agora.getTime() + c.antecedencia_horas * 3600e3);
    const base = ['07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00'];
    const dias = []; let bloqueadosPelaRegra = 0, existentes = 0;
    for (let i = 0; i <= diasAdiante; i++) {
      const d = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + i);
      if (d.getDay() === 0) continue;
      const h = sem(procId + iso(d));
      if (h % 5 === 0) continue;   // dia sem agenda
      const horarios = base.filter((_, j) => (h >> (j % 11)) % 3 === 0 || j % 7 === h % 7).slice(0, d.getDay() === 6 ? 4 : 9);
      const ok = [];
      for (const hr of horarios) {
        const [H, M] = hr.split(':').map(Number);
        const quando = new Date(d.getFullYear(), d.getMonth(), d.getDate(), H, M);
        if (quando <= agora) continue;
        existentes++;
        if (quando < limite) { bloqueadosPelaRegra++; continue; }
        ok.push({ hora: hr, unidade: 'Desenvoar', profissional: '' });
      }
      if (ok.length) dias.push({ data: iso(d), horarios: ok });
    }
    return { dias, bloqueadosPelaRegra, existentes, antecedenciaHoras: c.antecedencia_horas };
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

  window.CSI_SIM = { catalogo, convenios, planos, disponibilidade, marcar, config, configSalvar, configRestaurar, solicitacoes, solicitacaoAtualizar, solicitacoesApagarTudo, CATALOGO, iso };
})();
