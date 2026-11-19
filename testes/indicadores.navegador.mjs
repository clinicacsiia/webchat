// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com conversas de hoje, duas delas da mesma pessoa e uma de teste da TI) -> validação (cartões do topo e aba Indicadores) -> lógica (pessoas atendidas = quem a equipe assumiu ou respondeu hoje; teste fora; período livre com atalhos; sem "Conversas por pessoa" nem "Confirmaram"; unidade e teste vão para as três consultas) -> saída (PASS/FAIL e código de saída)
// Versão 2.0 — 10/11/2026 / Mudança: indicadores novos (IND-01 a IND-05). Versão 1.0 (09/11/2026): indicadores por unidade.
//
// Não substitui o teste com o Supabase real: as funções do banco são simuladas aqui. As contas do banco (supabase/indicadores-v2.sql) são provadas em testes/sql-indicadores-v2.test.mjs.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const RAIZ = resolve(import.meta.dirname, '..');
const UMD = resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const HOST = 'nrvuynjwcgwpjdptkiay.supabase.co';
const EU = { id: '11111111-1111-4111-8111-111111111111', nome: 'Atendente de Teste', email: 'a@teste.local', papel: 'atendente', ativo: true };
const ADM = { ...EU, nome: 'Admin de Teste', papel: 'admin' };
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const agora = new Date().toISOString();
const isoSP = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const mais = (iso, n) => { const [a, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10); };
const HOJE = isoSP();
const conversa = (id, nome, status, unidade, extra = {}) => ({ id, status, agente_id: null, ultima_mensagem: 'oi', nao_lidas_agente: 0, criado_em: agora, atualizado_em: agora, contato_id: 'ct-' + id, ia_ativa: false, motor: 'fluxo',
  triagem_resumo: null, triagem_urgencia: null, alerta_agenda: null, nome_informado: nome, email_informado: null, unidade_inicial: unidade, cliente_aguarda_desde: null, aguarda_paciente_desde: null,
  teste: false, primeiro_humano_em: null, encerrada_em: null, contatos: { id: 'ct-' + id, nome, telefone: '7190000' + id.slice(1), email: null }, ...extra });
// c1 e c2 são a mesma pessoa (c1 ainda sem ninguém, c2 atendida); c4 é da CSI; c5 foi encerrada hoje; c6 é conversa de TESTE da TI.
const CONVERSAS = [conversa('c7', 'Sem Unidade Teste', 'em_atendimento', null), conversa('c1', 'Maria Souza', 'aguardando', 'desenvoar'), conversa('c2', 'Maria Souza', 'em_atendimento', 'desenvoar', { primeiro_humano_em: agora }),
  conversa('c3', 'Ana Paula', 'em_atendimento', 'desenvoar', { primeiro_humano_em: agora }), conversa('c4', 'Pedro Alves', 'em_atendimento', 'csi', { primeiro_humano_em: agora }),
  conversa('c5', 'Lia Nunes', 'encerrada', 'desenvoar', { primeiro_humano_em: agora, encerrada_em: agora }), conversa('c6', 'Teste da TI', 'em_atendimento', 'desenvoar', { teste: true, primeiro_humano_em: agora })];
const antes = new Date(Date.now() - 3600e3).toISOString();
CONVERSAS[2].aguarda_paciente_desde = antes; CONVERSAS[3].aguarda_paciente_desde = antes; CONVERSAS[3].cliente_aguarda_desde = antes;
const GRUPOS = [{ conversa_id: 'c1', grupo_id: 'g1', sinais: ['nome'], origem: 'auto', confirmado_por: null }, { conversa_id: 'c2', grupo_id: 'g1', sinais: ['nome'], origem: 'auto', confirmado_por: null }];
// Respostas de painel_indicadores_decisao (supabase/indicadores-decisao.sql). Por unidade: "desenvoar" = 40 pessoas; "rmtc" = poucas pessoas (4 agora, 3 antes).
const DECISAO = (a) => {
  const un = a.p_unidade, pequeno = un === 'rmtc', ent = pequeno ? 4 : un === 'desenvoar' ? 40 : 60;
  const atual = { chat: { entraram: ent, funil: { entraram: ent, pedido: pequeno ? 3 : 45, data_hora: pequeno ? 2 : 40, horario: pequeno ? 2 : 22, completo: pequeno ? 1 : 20, agendaram: pequeno ? 1 : un === 'desenvoar' ? 10 : 15, agendaram_so_pelo_motivo: pequeno ? 0 : 2 },
      parou_em: { conversou: 15, exame: 2, plano: 1, preferencias: 0, data_hora: 18, dados: 2, pronto: 5 }, sem_agendar_motivo: { nao_respondido: 20, sem_equipe: 5, apenas_informacoes: 10, desistiu: 3, outro: 2, em_andamento: 5 }, espera_mediana_min: 20,
      por_tipo: { consulta: { pedido: 42, data_hora: 38, horario: 21, completo: 19, agendaram: 14 }, exame: { pedido: 3, data_hora: 2, horario: 1, completo: 1, agendaram: 1 } } },
    clinica: { novas_marcacoes: 200, novas_pelo_chat: 15, previstos: 300, atendidos: 200, faltaram: 50, cancelados: 20, remarcados: 15, por_vir: 15,
      falta_confirmacao: [{ nome: 'Confirmado', atendidos: 150, faltaram: 20 }, { nome: 'Sem Resposta', atendidos: 30, faltaram: 25 }],
      falta_antecedencia: [{ nome: 'No mesmo dia ou no dia seguinte', atendidos: 90, faltaram: 5 }, { nome: 'Mais de 15 dias antes', atendidos: 60, faltaram: 20 }],
      falta_unidade: [{ nome: 'CSI 1', atendidos: 120, faltaram: 30 }, { nome: 'CSI 2', atendidos: 80, faltaram: 20 }], falta_plano: [{ nome: 'Convênio', atendidos: 170, faltaram: 40 }, { nome: 'Particular', atendidos: 30, faltaram: 10 }],
      cancel_motivos: { paciente_cancelou: 9, erro_duplicidade: 6, sem_motivo: 3, convenio_cobertura: 2 } } };
  const anterior = { chat: { entraram: pequeno ? 3 : 50, funil: { entraram: pequeno ? 3 : 50, pedido: 40, data_hora: 35, horario: 28, completo: 25, agendaram: pequeno ? 1 : 20 }, parou_em: {}, sem_agendar_motivo: {}, espera_mediana_min: 8 },
    clinica: { novas_marcacoes: 250, novas_pelo_chat: 30, previstos: 300, atendidos: 220, faltaram: 30, cancelados: 10, remarcados: 10, por_vir: 30, falta_confirmacao: [], falta_antecedencia: [], falta_unidade: [], falta_plano: [], cancel_motivos: {} } };
  atual.clinica_consulta = { ...atual.clinica, previstos: 90, atendidos: 60, faltaram: 10, cancelados: 10, remarcados: 5, por_vir: 5, novas_marcacoes: 60 };
  atual.clinica_exame = { ...atual.clinica, previstos: 210, atendidos: 140, faltaram: 40, cancelados: 10, remarcados: 10, por_vir: 10, novas_marcacoes: 140 };
  if (a.p_de.endsWith('-01') && a.p_ate > a.p_de) { const mm = Number(a.p_de.slice(5, 7)); atual.chat.funil.entraram = 10 * mm; atual.chat.funil.agendaram = mm; }   // gráfico mês a mês: cada mês com valor próprio
  return { periodo: { de: a.p_de, ate: a.p_ate }, anterior_periodo: { de: mais(a.p_de, -1), ate: mais(a.p_de, -1) }, unidade: un, incluir_teste: !!a.p_incluir_teste, gerado_em: agora, atual, anterior };
};
const ATENDENTES = (a) => ({ periodo: { de: a.p_de, ate: a.p_ate }, unidade: a.p_unidade, gerado_em: agora, nota_media_geral: 8.5,
  pessoas: [{ nome: 'Ana', conversas: 40, agendados: 12, agendados_a_mao: 4, agendados_automaticos: 8, avaliacoes: 8, nota_media: 9.4, primeiras: 30, espera_mediana_min: 6 }, { nome: 'Bia', conversas: 25, agendados: 3, agendados_a_mao: 0, agendados_automaticos: 3, avaliacoes: 2, nota_media: 6.5, primeiras: 9, espera_mediana_min: 45 }, { nome: 'Caio', conversas: 10, agendados: 0, avaliacoes: 0, nota_media: null, primeiras: 1, espera_mediana_min: 12 }] });
const EXTRAS = (admin) => ({ por_hora: [], pedidos: {}, avaliacoes: admin ? { total: 10, media_atendimento: 8.5, media_site: 7.9, por_canal: { WhatsApp: 4, Instagram: 5, Google: 1 } } : null });
const jwt = (sub) => { const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })}.x`; };

// Respostas de painel_automacao_resumo (marcação automática pelo chat). Tudo inventado.
const AUTOMACAO = { operacoes: { sucesso: 30, falha: 2, incerto: 1, horario_tomado: 4 }, pos: { 'cancelar:sucesso': 6, 'remarcar:sucesso': 3, 'cancelar:falha': 1 }, agendadas_sozinhas: 25, resolvidas_sem_humano: 18, tempo_medio_s: 42, motivos_falha: [{ codigo: 'horario_tomado', n: 4 }] };

function servidor() {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      let c = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let a = join(RAIZ, c); if (existsSync(a) && !extname(a)) a = join(a, 'index.html');
      if (!existsSync(a)) { res.writeHead(404); res.end('x'); return; }
      res.writeHead(200, { 'content-type': TIPOS[extname(a)] ?? 'application/octet-stream' }); res.end(await readFile(a));
    }).listen(0, '127.0.0.1', () => ok(s));
  });
}


// Respostas de painel_indicadores_diretoria (por unidade, pedidos e planos). Tudo inventado.
const DIRETORIA = { unidades: {
    csi: { pessoas: 43, agendaram: 6, marcacoes: { total: 6, canceladas: 1, remarcadas: 0, ativas: 5, atendidas: 2, faltaram: 0, por_vir: 3 }, por_tipo: { consulta: { total: 1 }, exame: { total: 5 } } },
    rmtc: { pessoas: 31, agendaram: 6, marcacoes: { total: 6, canceladas: 0, remarcadas: 2, ativas: 4, atendidas: 0, faltaram: 0, por_vir: 4 }, por_tipo: { exame: { total: 6 } } },
    desenvoar: { pessoas: 320, agendaram: 112, marcacoes: { total: 122, canceladas: 4, remarcadas: 5, ativas: 113, atendidas: 15, faltaram: 3, por_vir: 95 }, por_tipo: { consulta: { total: 121 }, exame: { total: 1 } } },
    sem: { pessoas: 6, agendaram: 1, marcacoes: { total: 0, canceladas: 0, remarcadas: 0, ativas: 0, atendidas: 0, faltaram: 0, por_vir: 0 }, por_tipo: {} } },
  pedidos: [{ nome: 'CONSULTA', pessoas: 100, agendaram: 45 }, { nome: 'CONSULTA NEUROPEDIATRIA', pessoas: 60, agendaram: 6 }, { nome: 'CONSULTA ORTOPEDIATRA', pessoas: 25, agendaram: 6 }],
  planos: [{ nome: 'UNIMED', pessoas: 50, agendaram: 20 }, { nome: 'BRADESCO SAUDE', pessoas: 40, agendaram: 14 }, { nome: 'PLANSERV', pessoas: 10, agendaram: 0 }] };

// Respostas de painel_indicadores_agenda (supabase/indicadores-agenda.sql): só marcações vindas do chat. Contagens REAIS por dia até 16/11/2026 (só números, nenhum dado de paciente).
// Colunas: dia, agendados, cancelados, remarcados, ficaram, confirmaram, atendidos, faltaram, sem_fechamento, chegaram, conf_atend, conf_falt, nconf_atend, nconf_falt
const DIAS_REAIS = [['2026-11-07', 1, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0], ['2026-11-09', 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0], ['2026-11-10', 3, 0, 1, 2, 2, 2, 0, 0, 0, 2, 0, 0, 0], ['2026-11-11', 5, 0, 0, 5, 5, 4, 1, 0, 0, 4, 1, 0, 0],
  ['2026-11-12', 5, 0, 0, 5, 4, 3, 2, 0, 0, 2, 2, 1, 0], ['2026-11-13', 3, 0, 0, 3, 3, 3, 0, 0, 0, 3, 0, 0, 0], ['2026-11-14', 2, 0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0], ['2026-11-16', 10, 0, 2, 8, 8, 3, 0, 5, 3, 3, 0, 0, 0]];
const linhaAg = (r) => ({ dia: r[0], agendados: r[1], canceladas: r[2], remarcadas: r[3], ficaram: r[4], confirmaram: r[5], atendidas: r[6], faltaram: r[7], por_vir: 0, sem_fechamento: r[8], chegaram: r[9], conf_atendidas: r[10], conf_faltaram: r[11], nconf_atendidas: r[12], nconf_faltaram: r[13] });
const somaAg = (ls) => { const t = { agendados: 0, canceladas: 0, remarcadas: 0, ficaram: 0, confirmaram: 0, atendidas: 0, faltaram: 0, por_vir: 0, sem_fechamento: 0, chegaram: 0, conf_atendidas: 0, conf_faltaram: 0, nconf_atendidas: 0, nconf_faltaram: 0 }; for (const l of ls) for (const k of Object.keys(t)) t[k] += l[k] || 0; return t; };
const POR_DIA = DIAS_REAIS.map(linhaAg), TOTAL_AG = somaAg(POR_DIA);
// Respostas de painel_indicadores_pessoas (supabase/indicadores-cinco-numeros.sql): os 5 números do topo, todos em pessoas pelo dia em que abriram o chat.
const PESSOAS = (a) => {
  const pequeno = a.p_unidade === 'rmtc', ent = pequeno ? 4 : a.p_unidade === 'desenvoar' ? 40 : 60;
  const so = a.p_tipo === 'exame';
  const atual = so ? { procuraram: 8, atendidos: 6, agendaram: 1, agendaram_da_coorte: 1, agendaram_conversa_anterior: 0, robo: 1, robo_sem_atendente: 1, faltaram: 0, cancelaram: 0, faltaram_ou_cancelaram: 0 }
    : { procuraram: ent, atendidos: Math.round(ent * 0.95), agendaram: Math.round(ent / 4), agendaram_da_coorte: Math.round(ent / 4), agendaram_conversa_anterior: 3, robo: 5, robo_sem_atendente: 3, faltaram: 2, cancelaram: 1, faltaram_ou_cancelaram: 3 };
  const anterior = pequeno ? { procuraram: 3, atendidos: 3, agendaram: 1, robo: 0, robo_sem_atendente: 0, faltaram: 0, cancelaram: 0, faltaram_ou_cancelaram: 0 }
    : { procuraram: 50, atendidos: 45, agendaram: 20, robo: 4, robo_sem_atendente: 1, faltaram: 1, cancelaram: 1, faltaram_ou_cancelaram: 2 };
  return { periodo: { de: a.p_de, ate: a.p_ate }, anterior_periodo: { de: a.p_de, ate: a.p_ate }, unidade: a.p_unidade, tipo: a.p_tipo || null, gerado_em: new Date().toISOString(), atual, anterior };
};
const AGENDA = (a) => {
  const pequeno = a.p_unidade === 'rmtc', ent = pequeno ? 4 : a.p_unidade === 'desenvoar' ? 40 : 60;
  const un = (f) => { const o = {}; for (const k of Object.keys(TOTAL_AG)) o[k] = Math.round(TOTAL_AG[k] * f); return o; };
  const bloco = (agendados, canceladas, remarcadas, ficaram, confirmaram, atendidas, faltaram, sem_fechamento, chegaram, conf_atendidas, conf_faltaram, nconf_atendidas, nconf_faltaram) => ({ agendados, canceladas, remarcadas, ficaram, confirmaram, atendidas, faltaram, por_vir: 0, sem_fechamento, chegaram, conf_atendidas, conf_faltaram, nconf_atendidas, nconf_faltaram });
  const atual = { total: TOTAL_AG, por_dia: POR_DIA, por_tipo: { consulta: bloco(25, 0, 3, 22, 20, 15, 3, 4, 3, 13, 3, 2, 0), exame: bloco(5, 0, 1, 4, 4, 3, 0, 1, 0, 3, 0, 0, 0) },
    por_unidade: { csi: un(0.2), rmtc: un(0.1), desenvoar: un(0.7), sem: { ...un(0), agendados: 0 } },
    hoje: { agendados: 11, saiu: 4, ficaram: 7, confirmaram: 6, chegaram: 0, atendidas: 0 },
    proximos: [{ dia: mais(HOJE, 1), ficaram: 13, confirmaram: 7 }, { dia: mais(HOJE, 2), ficaram: 6, confirmaram: 0 }],
    novas: { total: 135, ativas: 124, canceladas: 4, remarcadas: 7 },
    pessoas: { procuraram: ent, atendidas: Math.round(ent * 0.95), agendaram: Math.round(ent / 4), sem_ajuda: 3 },
    site: { com_marcacao: 82, com_marcacao_ativa: 76 }, site_por_dia: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ dia: mais(a.p_ate, -i), pessoas: 10 + i, agendaram: 3 + (i % 3) })).filter((x) => x.dia >= a.p_de),
    dados_desde: '2026-10-30', checkin_desde: '2026-11-16' };
  const anterior = { ...atual, total: somaAg([]), por_dia: [], por_tipo: {}, por_unidade: {}, novas: { total: 100, ativas: 90, canceladas: 8, remarcadas: 4 }, pessoas: { procuraram: pequeno ? 3 : 50, atendidas: pequeno ? 3 : 45, agendaram: pequeno ? 1 : 20, sem_ajuda: 1 }, site: { com_marcacao: 0, com_marcacao_ativa: 0 }, site_por_dia: [] };
  return { periodo: { de: a.p_de, ate: a.p_ate }, anterior_periodo: { de: mais(a.p_de, -1), ate: mais(a.p_de, -1) }, unidade: a.p_unidade, gerado_em: agora, atual, anterior: pequeno ? anterior : { ...anterior, total: somaAg(POR_DIA.slice(0, 3)) } };
};
// Respostas de painel_indicadores_plataforma (marcações do chat, consulta x exame). Tudo inventado; total = canceladas + remarcadas + ativas.
const PLATAFORMA = { conversas: 38, total: { total: 134, canceladas: 5, remarcadas: 7, ativas: 122, atendidas: 17, faltaram: 3, por_vir: 102, sem_dado: 0 },
  por_tipo: { consulta: { total: 122, canceladas: 4, remarcadas: 5, ativas: 113, atendidas: 15, faltaram: 3, por_vir: 95, sem_dado: 0 }, exame: { total: 12, canceladas: 1, remarcadas: 2, ativas: 9, atendidas: 2, faltaram: 0, por_vir: 7, sem_dado: 0 } },
  por_origem: { Whatsapp: 40, Telefone: 20, Webchat: 1, sem_origem: 73 }, por_ligacao: { pedido: 100, telefone_nome: 34 }, cancel_motivos: { paciente_cancelou: 3, sem_motivo: 2 }, clinica_mesmo_periodo: { consulta: 559, exame: 2215 } };
// Respostas de painel_indicadores_mensal (gráfico mensal). Tudo inventado; total = atendidos + faltaram + cancelados + remarcados + por vir.
const MENSAL = { de: '2026-06-01', ate: '2026-11-01', meses: [
  { mes: '2026-06', total: 0, atendidos: 0, faltaram: 0, cancelados: 0, remarcados: 0, por_vir: 0 }, { mes: '2026-07', total: 0, atendidos: 0, faltaram: 0, cancelados: 0, remarcados: 0, por_vir: 0 },
  { mes: '2026-08', total: 0, atendidos: 0, faltaram: 0, cancelados: 0, remarcados: 0, por_vir: 0 }, { mes: '2026-09', total: 0, atendidos: 0, faltaram: 0, cancelados: 0, remarcados: 0, por_vir: 0 },
  { mes: '2026-10', total: 432, atendidos: 273, faltaram: 59, cancelados: 62, remarcados: 38, por_vir: 0 }, { mes: '2026-11', consulta: { total: 1546, atendidos: 700, faltaram: 100, cancelados: 200, remarcados: 246, por_vir: 300 }, exame: { total: 4255, atendidos: 1655, faltaram: 351, cancelados: 463, remarcados: 465, por_vir: 1321 }, total: 5807, atendidos: 2355, faltaram: 451, cancelados: 663, remarcados: 711, por_vir: 1627 }] };
// Respostas de painel_indicadores_conferencia (supabase/klingo-conferencia.sql) e de paciente_avisos com os dois tipos novos. Tudo inventado.
const CONFERENCIA = {
  periodo: { de: HOJE, ate: HOJE }, ultima_leitura: `${HOJE}T15:00:00Z`, dias_sem_leitura: [], total: 200,
  por_origem: { Whatsapp: 90, Telefone: 60, 'Recepção': 30, sem_origem: 20 }, por_status: { Aberta: 170, Cancelada: 30 },
  explicacao: { no_banco: 170, fora_do_banco: 30, remarcadas: 10, novas_marcacoes_indicador: 160, canceladas_no_klingo: 30 },
  webchat: { marcacoes_ligadas: 40, conversas_ligadas: 38, por_ligacao: { pedido: 25, telefone_nome: 15 }, por_origem: { Whatsapp: 36, Telefone: 4 },
    exames: { atendido: 15, faltou: 3, por_vir: 18, cancelado_ou_remarcado: 2, ainda_fora_do_banco: 2 },
    pessoas_que_procuraram: 60, atendidas_pela_equipe: 52, com_pedido_pronto: 30, agendaram_no_chat: 25, agendaram_e_ligadas_ao_klingo: 22, agendadas_sem_marcacao_no_klingo: 3 },
  qualidade_klingo: { sem_cpf: 64, sem_email: 92, sem_celular: 6 },
  problemas: { conflito: 3, dado_faltando: 4, responsavel_diferente_esperado: 9, filho_nos_ligados: 30 },
  lista_problemas: [
    { m: '900001', marcado_em: HOJE, origem: 'Whatsapp', status: 'Aberta', conversa_id: 'c-1', nome: 'MARIA DE TESTE', tipo: 'proprio', conflito: ['cpf'], falta_no_klingo: ['email'], responsavel_diferente: [] },
    { m: '900002', marcado_em: HOJE, origem: 'Telefone', status: 'Aberta', conversa_id: 'c-2', nome: 'PEDRO DE TESTE', tipo: 'filho', conflito: ['nome'], falta_no_klingo: ['celular'], responsavel_diferente: ['cpf', 'email'] }],
  lista_ligadas: [
    { m: '900001', marcado_em: HOJE, origem: 'Whatsapp', ligacao: 'pedido', conversa_id: 'c-1', nome: 'MARIA DE TESTE', tipo: 'proprio', exame: 'atendido', status: 'Aberta', problema: true },
    { m: '900003', marcado_em: HOJE, origem: 'Whatsapp', ligacao: 'telefone_nome', conversa_id: 'c-3', nome: 'ANA DE TESTE', tipo: 'proprio', exame: 'agendado', status: 'Aberta', problema: false }],
  lista_sem_marcacao: [{ conversa_id: 'c-9', nome: 'JOSE DE TESTE', atualizado_em: `${HOJE}T12:00:00Z` }],
};
const AVISOS_CONF = [
  { id: 71, conversa_id: 'c-1', tipo: 'klingo_conflito', detalhe: { marcacoes: ['900001'], campos: ['cpf'], filho: false }, criado_em: `${HOJE}T15:00:00Z`, nome: 'MARIA DE TESTE' },
  { id: 72, conversa_id: 'c-2', tipo: 'klingo_dado_faltando', detalhe: { marcacoes: ['900002'], campos: ['celular'], filho: true }, criado_em: `${HOJE}T15:00:00Z`, nome: 'PEDRO DE TESTE' },
  { id: 73, conversa_id: 'c-4', tipo: 'klingo_dado_faltando', detalhe: { marcacoes: ['900004'], campos: ['celular', 'email'], filho: false }, criado_em: `${HOJE}T15:00:00Z`, nome: 'LUCIA DE TESTE' }];

async function pagina(browser, { semSql = false, admin = false, semAtend = false, conf = false, semPlat = false, semAgenda = false, semPessoas = false } = {}) {
  const eu = admin ? ADM : EU;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });   // cartões do topo somem em telas baixas (<= 820 px)
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
    try { localStorage.removeItem('painel.unidade'); } catch {}
  }, [eu.id, jwt(eu.id), eu.email]);
  const reg = { excecoes: [], rpcs: [] };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => reg.excecoes.push(e.message));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(UMD) }));
  await ctx.route(`https://${HOST}/**`, async (rota) => {
    const req = rota.request();
    if (req.method() === 'OPTIONS') return rota.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url()); const p = url.pathname;
    const objeto = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    let corpo; let status = 200;
    if (p.startsWith('/auth/v1/user')) corpo = { id: eu.id, aud: 'authenticated', role: 'authenticated', email: eu.email };
    else if (p.startsWith('/rest/v1/agentes')) corpo = url.searchParams.get('id') ? (objeto ? eu : [eu]) : [eu];
    else if (p.startsWith('/rest/v1/conversas')) corpo = CONVERSAS;
    else if (p.startsWith('/rest/v1/conversa_grupo')) corpo = GRUPOS;
    else if (p.endsWith('/rpc/painel_indicadores_atendentes')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['atendentes', b]); if (semAtend) { status = 404; corpo = { code: 'PGRST202', message: 'function not found' }; } else corpo = ATENDENTES(b); }
    else if (p.endsWith('/rpc/painel_indicadores_extras_v2')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['extras', b]); corpo = EXTRAS(admin); }
    else if (p.endsWith('/rpc/painel_indicadores_decisao')) {
      const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['decisao', b]);
      if (semSql) { status = 404; corpo = { code: 'PGRST202', message: 'Could not find the function public.painel_indicadores_decisao in the schema cache' }; } else corpo = DECISAO(b);
    }
    else if (p.endsWith('/rpc/painel_indicadores_diretoria')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['diretoria', b]); corpo = DIRETORIA; }
    else if (p.endsWith('/rpc/painel_indicadores_pessoas')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['pessoas', b]); if (semPessoas) { status = 404; corpo = { code: 'PGRST202', message: 'function not found' }; } else corpo = PESSOAS(b); }
    else if (p.endsWith('/rpc/painel_indicadores_agenda')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['agenda', b]); if (semAgenda) { status = 404; corpo = { code: 'PGRST202', message: 'function not found' }; } else corpo = AGENDA(b); }
    else if (p.endsWith('/rpc/painel_indicadores_plataforma')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['plataforma', b]); if (semPlat) { status = 404; corpo = { code: 'PGRST202', message: 'function not found' }; } else corpo = PLATAFORMA; }
    else if (p.endsWith('/rpc/painel_automacao_resumo')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['automacao', b]); corpo = AUTOMACAO; }
    else if (p.endsWith('/rpc/painel_indicadores_mensal')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['mensal', b]); corpo = MENSAL; }
    else if (p.endsWith('/rpc/painel_indicadores_conferencia')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['conferencia', b]); corpo = conf ? CONFERENCIA : {}; }
    else if (p.endsWith('/rpc/paciente_avisos')) corpo = conf ? AVISOS_CONF : [];
    else if (p.startsWith('/rest/v1/rpc/')) corpo = {};
    else if (p.startsWith('/rest/v1/')) corpo = objeto ? null : [];
    else corpo = {};
    return rota.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(corpo) });
  });
  if (typeof page.routeWebSocket === 'function') await page.routeWebSocket(/supabase\.co/, (ws) => ws.close());
  return { page, ctx, reg };
}

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + e.message.split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const abrir = async (opc) => { const t = await pagina(browser, opc); await t.page.goto(`${base}/painel/`); await t.page.waitForSelector('#kpis .kpi', { timeout: 10000 }); return t; };
const cartoes = (page) => page.locator('#kpis .kpi').evaluateAll((l) => Object.fromEntries(l.map((k) => [k.querySelector('small').textContent, k.querySelector('strong').textContent])));
const esperaCartao = (page, rot, v) => page.waitForFunction(([r, x]) => [...document.querySelectorAll('#kpis .kpi')].some((k) => k.querySelector('small').textContent === r && k.querySelector('strong').textContent === x), [rot, v], { timeout: 5000 });
const abaInd = async (t) => { await t.page.click('.nav button[data-aba=indicadores]'); await t.page.waitForSelector('.ind-kpis .ind-kpi', { timeout: 8000 }).catch((e) => { throw new Error(e.message.split('\n')[0] + ' | erros da página: ' + (t.reg.excecoes.join(' ; ') || 'nenhum')); }); await t.page.evaluate(() => document.querySelectorAll('.ind-det, .ind-num-det').forEach((d) => { d.open = true; })); };
const ultimoD = async (t) => { const [de, ate] = await t.page.locator('.ind-ctl input[type=date]').evaluateAll((l) => l.map((i) => i.value)); return t.reg.rpcs.filter((r) => r[0] === 'decisao' && r[1].p_de === de && r[1].p_ate === ate).at(-1)?.[1]; };   // as consultas do gráfico mensal têm outras datas
const ultimo = (reg, k) => reg.rpcs.filter((r) => r[0] === k).at(-1)?.[1];

await caso('Cartões do topo (mesma base dos Indicadores: pessoas pelo dia em que abriram o chat): 5 procuraram (uma sem unidade), 4 atendidas e 1 encerrada; a conversa de TESTE fica fora e duas conversas da mesma pessoa contam uma vez', async () => {
  const { page, ctx, reg } = await abrir(); await esperaCartao(page, 'Foram atendidos', '4');
  const k = await cartoes(page);
  await ctx.close();
  return { ok: k['Procuraram o chat hoje'] === '5' && k['Foram atendidos'] === '4' && k['Já encerradas'] === '1' && !('Conversas hoje' in k) && !('Conversas por pessoa' in k) && !reg.excecoes.length, detalhe: JSON.stringify(k) + (reg.excecoes[0] ?? '') };
});
await caso('A conversa de teste aparece na lista com o selo "Teste"', async () => {
  const { page, ctx } = await abrir(); await esperaCartao(page, 'Foram atendidos', '4');
  await page.click('.chip >> text=Abertas');
  await page.waitForSelector('.item');
  const selos = await page.locator('.item', { hasText: 'Teste da TI' }).locator('.urg').allInnerTexts();
  await ctx.close();
  return { ok: selos.includes('Teste'), detalhe: selos.join(',') };
});
await caso('Filtro de unidade Desenvoar vale para os cartões do topo (3 pessoas procuraram, 3 atendidas, 1 encerrada; quem não tem unidade fica de fora, como nos Indicadores)', async () => {
  const { page, ctx } = await abrir(); await esperaCartao(page, 'Foram atendidos', '4');
  await page.selectOption('#selUnidade', 'desenvoar'); await esperaCartao(page, 'Foram atendidos', '3');
  const k = await cartoes(page); await ctx.close();
  return { ok: k['Procuraram o chat hoje'] === '3' && k['Já encerradas'] === '1', detalhe: JSON.stringify(k) };
});
await caso('Quadrado "Aguardando paciente" continua certo (1) e o filtro de unidade vale', async () => {
  const { page, ctx } = await abrir(); await esperaCartao(page, 'Aguardando paciente', '1');
  await page.selectOption('#selUnidade', 'csi'); await esperaCartao(page, 'Aguardando paciente', '0');
  await page.selectOption('#selUnidade', 'desenvoar'); await esperaCartao(page, 'Aguardando paciente', '1');
  await ctx.close(); return { ok: true };
});

const textoAba = async (t) => (await t.page.locator('.pagina').first().innerText()).replace(/\n+/g, ' ');

const kpiTxt = async (t) => t.page.locator('.ind-kpi').evaluateAll((l) => Object.fromEntries(l.map((k) => [k.querySelector('.ind-kpi-rot').textContent, [k.querySelector('b').textContent, k.querySelector('.ind-kpi-sub').textContent, k.querySelector('.ind-delta')?.textContent ?? ''].join(' | ')])));
await caso('Aba Indicadores: período padrão é Hoje e cada bloco pede só a sua consulta (marcações do chat, equipe, chat, diretoria; sem avaliações, conferência nem gráfico mensal)', async () => {
  const t = await abrir(); await abaInd(t);
  const a = await ultimoD(t), ctrl = await t.page.locator('.ind-ctl input[type=date]').evaluateAll((l) => l.map((i) => i.value));
  const nomes = [...new Set(t.reg.rpcs.map((r) => r[0]))].sort().join();
  const ag = ultimo(t.reg, 'agenda');
  await t.ctx.close();
  return { ok: a.p_de === HOJE && a.p_ate === HOJE && a.p_unidade === null && a.p_incluir_teste === false && ctrl.join() === `${HOJE},${HOJE}` && nomes === 'agenda,atendentes,decisao,diretoria,pessoas' && ag.p_incluir_teste === false && !t.reg.excecoes.length, detalhe: JSON.stringify(a) + ' ' + nomes + (t.reg.excecoes[0] ?? '') };
});
await caso('Topo: só os 5 números pedidos (procuraram, atendidos, agendaram no Klingo, robô sozinho, faltaram ou cancelaram), todos na mesma base, com comparação neutra e nomes que não se repetem', async () => {
  const t = await abrir(); await abaInd(t);
  const k = await kpiTxt(t); const topo = await t.page.locator('.ind-kpis').first().locator('.ind-kpi-rot').allInnerTexts(); const coloridos = await t.page.locator('.ind-kpis').first().locator('.ind-delta.bom, .ind-delta.ruim').count();
  const ordem = await t.page.locator('.ind-pg h3.ind-sec').first().innerText();
  const todos = await t.page.locator('.ind-kpi-rot').allInnerTexts();
  const ped = ultimo(t.reg, 'pessoas');
  await t.ctx.close();
  return { ok: topo.join('|') === 'Procuraram o chat|Foram atendidos|Agendaram, confirmado no Klingo|Desses, o robô marcou sozinho|Faltaram ou cancelaram' && ordem === 'Visão da agenda (marcações)' && new Set(todos).size === todos.length
    && k['Procuraram o chat'].startsWith('60 | pessoas, pelo dia em que abriram o chat; cada uma conta uma vez | ▲ 20%') && k['Foram atendidos'].startsWith('57 | 95% de quem procurou') && k['Agendaram, confirmado no Klingo'].startsWith('15 | 3 de conversas abertas antes do período')
    && k['Desses, o robô marcou sozinho'].startsWith('5 | 33,3% dos que agendaram · 3 sem nenhum atendente na conversa') && k['Faltaram ou cancelaram'].startsWith('3 | 20% dos que agendaram · 2 faltaram · 1 cancelaram') && coloridos === 0
    && ped.p_tipo === null && ped.p_incluir_teste === false, detalhe: JSON.stringify(k) + ' ' + topo.join(',') };
});
await caso('Filtro "Só exames": os 5 números e a história das marcações passam a ser só de exames', async () => {
  const t = await abrir(); await abaInd(t);
  await t.page.click('.ind-tipo .chip >> text=Só exames'); await t.page.waitForFunction(() => [...document.querySelectorAll('.ind-kpi')].find((x) => x.querySelector('.ind-kpi-rot').textContent === 'Procuraram o chat')?.querySelector('b').textContent === '8');
  const k = await kpiTxt(t); const ped = ultimo(t.reg, 'pessoas'); const txt = await textoAba(t);
  const hist = await t.page.locator('.ind-painel', { hasText: 'A história das marcações' }).first().locator('.ind-rot').allInnerTexts();
  await t.ctx.close();
  return { ok: ped.p_tipo === 'exame' && k['Procuraram o chat'].startsWith('8 | pessoas que começaram um pedido de exame') && k['Agendaram, confirmado no Klingo'].startsWith('1 |') && /Filtro "Só exames"/.test(txt) && hist[0] === '1. Agendados', detalhe: JSON.stringify(k['Procuraram o chat']) + ' ' + hist.join(',') };
});
await caso('Sem a função dos 5 números no banco: avisa o arquivo a aplicar e o resto da aba continua', async () => {
  const t = await abrir({ semPessoas: true }); await abaInd(t);
  const txt = await textoAba(t); await t.ctx.close();
  return { ok: /supabase\/indicadores-cinco-numeros\.sql/.test(txt) && /Visão da agenda \(marcações\)/.test(txt) && /Caminho do paciente no chat/.test(txt) && !t.reg.excecoes.length, detalhe: txt.slice(0, 200) + (t.reg.excecoes[0] ?? '') };
});
await caso('Gráfico "Procura e agendamento": consultas e exames, cada um com a procura (começaram um pedido) e quantos agendaram, e a porcentagem', async () => {
  const t = await abrir(); await abaInd(t);
  const p = t.page.locator('.ind-painel', { hasText: 'Consultas e exames: quem começou um pedido' }).first();
  const grupos = await p.locator('svg .rot').allTextContents(), pcts = await p.locator('svg .pct').allTextContents(), vals = await p.locator('svg .val').allTextContents(), barras = await p.locator('svg rect').count();
  const leg = (await p.locator('.ind-leg').innerText()).replace(/\s+/g, ' '), titulos = await p.locator('svg rect title').allTextContents();
  const posicao = await t.page.locator('.ind-pg h3.ind-sec, .ind-pg .ind-painel h4').allInnerTexts();
  await t.ctx.close();
  return { ok: grupos.join('|') === 'Consultas|Exames' && vals.join('|') === '42|14|3|1' && pcts.join('|') === '33,3% marcaram|33,3% marcaram' && barras === 4 && /Começaram um pedido 45/.test(leg) && /Pedido marcado 15/.test(leg)
    && titulos[0] === 'Consultas: 42 começaram um pedido' && titulos[1] === 'Consultas: 14 pedido marcado' && posicao.indexOf('Consultas e exames: quem começou um pedido') < posicao.indexOf('Visão da agenda (marcações)'), detalhe: JSON.stringify({ grupos, vals, pcts, barras, leg, titulos }) };
});
await caso('Chat do site: começaram pedido e 1ª resposta (a prova do Klingo agora está no topo)', async () => {
  const t = await abrir(); await abaInd(t);
  const k = await kpiTxt(t); await t.ctx.close();
  return { ok: k['Começaram um pedido'].startsWith('45 |') && !('Com marcação no Klingo' in k) && k['1ª resposta da equipe'].startsWith('20 min'), detalhe: JSON.stringify(k) };
});

await caso('Marcações do chat: a história em ordem (agendados, saíram, ficaram, confirmaram, atendidos, faltaram) e a frase "de cada 100 marcações que já passaram"', async () => {
  const t = await abrir(); await abaInd(t);
  const p = t.page.locator('.ind-painel', { hasText: 'A história das marcações (pela data do exame)' }).first();
  const rots = await p.locator('.ind-rot').allInnerTexts(), frase = (await p.locator('.ind-resumo').first().innerText()).replace(/\s+/g, ' '), perda = (await p.locator('.ind-perda').first().innerText()).replace(/\s+/g, ' ');
  const leg = (await p.locator('.ind-leg').innerText()).replace(/\s+/g, ' ');
  await t.ctx.close();
  const T = TOTAL_AG, esperado = Math.round((T.atendidas / (T.atendidas + T.faltaram)) * 100);   // só quem ficou na agenda e já teve desfecho
  return { ok: rots.slice(0, 5).join('|') === '1. Agendados|2. Ficaram na agenda|3. Confirmaram (dos que ficaram)|4. Vieram e foram atendidos|5. Faltaram' && rots.some((x) => /Klingo ainda não fechou/.test(x))
    && frase.startsWith(`De cada 100 marcações que ficaram na agenda e já tiveram desfecho, ${esperado} viraram atendimento.`) && /ainda sem fechamento no Klingo ficam fora desta conta/.test(frase) && /4 saíram da agenda: 0 cancelados e 4 remarcados/.test(perda) && /Atendidos 18/.test(leg) && /Faltaram 3/.test(leg), detalhe: rots.join('|') + ' || ' + frase + ' || ' + perda + ' || ' + leg };
});
await caso('Marcações do chat: "Confirmar adianta?" avisa quando há poucas marcações passadas para comparar (menos de 20 de cada lado)', async () => {
  const t = await abrir(); await abaInd(t);
  const txt = (await t.page.locator('.ind-painel', { hasText: 'Confirmar adianta?' }).first().innerText()).replace(/\s+/g, ' ');
  await t.ctx.close();
  return { ok: /Poucas marcações com data passada para comparar/.test(txt) && !/vezes mais/.test(txt), detalhe: txt };
});
await caso('Marcações do chat: "Hoje e próximos dias" mostra marcados, confirmados, chegaram e quantos dos próximos dias ainda faltam confirmar', async () => {
  const t = await abrir(); await abaInd(t);
  const p = t.page.locator('.ind-painel', { hasText: 'Hoje e próximos dias' }).first();
  const minis = await p.locator('.ind-mini').evaluateAll((l) => l.map((m) => m.innerText.replace(/\s+/g, ' ').trim())), barras = await p.locator('.ind-bd-n').allInnerTexts(), frase = (await p.locator('.ind-resumo').innerText()).replace(/\s+/g, ' ');
  await t.ctx.close();
  return { ok: minis[0].startsWith('7 do chat marcados para hoje') && /4 já saíram/.test(minis[0]) && minis[1].startsWith('6 confirmados') && minis[2].startsWith('0 já chegaram') && minis[4].startsWith('7 ainda faltam atender')
    && barras.join('|') === '7 de 13 · 53,8%|0 de 6 · 0%' && frase.startsWith('12 marcações do chat nos próximos 3 dias ainda sem confirmação'), detalhe: minis.join(' ; ') + ' || ' + barras.join('|') + ' || ' + frase };
});
await caso('Marcações do chat: gráfico "Dia a dia" (colunas empilhadas, SVG puro): uma coluna por dia com marcação, legenda com totais e tooltip ao passar o mouse', async () => {
  const t = await abrir(); await abaInd(t);
  const g = t.page.locator('.ind-painel', { hasText: 'Dia a dia' }).first();
  const zonas = await g.locator('.zona').count(), rects = await g.locator('svg rect:not(.zona)').count(), externos = await t.page.locator('script[src^="http"]:not([src*="supabase"])').count();
  await g.locator('.zona').nth(3).hover(); await t.page.waitForSelector('.ind-area-dica:not([hidden])');
  const dica = (await g.locator('.ind-area-dica').innerText()).replace(/\s+/g, ' '), leg = (await g.locator('.ind-leg').innerText()).replace(/\s+/g, ' ');
  const linhas = await g.locator('table tbody tr').count(), primeira = (await g.locator('table tbody tr').first().innerText()).replace(/\s+/g, ' ');
  await t.ctx.close();
  return { ok: zonas === 8 && rects >= 8 && externos === 0 && /qua, 11\/11\/2026/.test(dica) && /Atendidos: 4/.test(dica) && /Faltaram: 1/.test(dica) && /Total: 5/.test(dica)
    && /Atendidos 18/.test(leg) && /Faltaram 3/.test(leg) && linhas === 8 && /seg, 16\/11\/2026\s*10/.test(primeira), detalhe: JSON.stringify({ zonas, rects, dica, leg, linhas, primeira }) };
});
await caso('Marcações do chat: tabela de consultas, exames e unidades com saíram, confirmaram, atendidos e faltaram', async () => {
  const t = await abrir(); await abaInd(t);
  const linhas = await t.page.locator('.ind-painel', { hasText: 'Consultas, exames e unidades' }).first().locator('tbody tr').evaluateAll((l) => l.map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.trim()).join('|')));
  await t.ctx.close();
  return { ok: linhas.length >= 3 && linhas[0] === 'Consultas|25|12%|90,9%|15|16,7%' && linhas[1].startsWith('Exames|5|20%|100%|3|0%'), detalhe: linhas.join(' ; ') };
});
await caso('Equipe de atendimento: barra de agendamentos por atendente e tabela com conversas, 1ª resposta e nota (só com casos suficientes)', async () => {
  const t = await abrir(); await abaInd(t);
  const p = t.page.locator('.ind-painel', { hasText: 'Por atendente' }).first();
  const rots = await p.locator('.ind-rot').allInnerTexts(), linhas = await p.locator('tbody tr').evaluateAll((l) => l.map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.trim()).join('|')));
  await t.ctx.close();
  return { ok: rots[0] === 'Ana' && linhas[0] === 'Ana|40|4|8|6 min|9,4' && /^Bia\|25\|0\|3\|/.test(linhas[1]), detalhe: rots.join(',') + ' || ' + linhas.join(' ; ') };
});
await caso('Sem a função da agenda no banco: avisa o arquivo a aplicar e o resto da página (funil do chat) continua', async () => {
  const t = await abrir({ semAgenda: true }); await abaInd(t);
  const txt = await textoAba(t); await t.ctx.close();
  return { ok: /supabase\/indicadores-agenda\.sql/.test(txt) && /Caminho do paciente no chat/.test(txt) && /Não consegui carregar as marcações do chat/.test(txt) && !t.reg.excecoes.length, detalhe: txt.slice(0, 200) + (t.reg.excecoes[0] ?? '') };
});
await caso('Poucos casos no período anterior: mostra o número de antes em vez de só "sem base para comparar"', async () => {
  const t = await abrir({ unidade: 'rmtc' }); await t.page.click('.nav button[data-aba=indicadores]'); await t.page.selectOption('#selUnidade', 'rmtc');
  await t.page.waitForFunction(() => /Unidade CSI RM\/TC/.test(document.querySelector('.pagina')?.innerText || ''));
  const k = await kpiTxt(t); await t.ctx.close();
  return { ok: /período anterior: 3 \(poucos casos para comparar\)/.test(k['Procuraram o chat']) && !/sem base/.test(k['Procuraram o chat']), detalhe: JSON.stringify(k['Procuraram o chat']) };
});
await caso('Gráfico "Chat por dia" (área em SVG puro): soma e melhor dia calculados sozinhos, tooltip ao passar o mouse e troca para "Pedidos marcados pelo chat"', async () => {
  const t = await abrir(); await abaInd(t);
  await t.page.click('.ind-atalhos .chip >> text=Últimos 7 dias'); await t.page.waitForFunction(() => document.querySelector('.ind-atalhos .chip[aria-pressed=true]')?.textContent === 'Últimos 7 dias');
  const p = t.page.locator('.ind-painel', { hasText: 'Chat por dia' }).first(); await p.locator('.ind-area').waitFor();
  const pontos = await p.locator('.ind-area .pt').count(), grad = await p.locator('.ind-area linearGradient').count(), caminhos = await p.locator('.ind-area path').count();
  const minis = (await p.locator('.ind-mini').allInnerTexts()).map((x) => x.replace(/\s+/g, ' '));
  await p.locator('.ind-area .zona').nth(1).hover(); await t.page.waitForSelector('.ind-area-dica:not([hidden])');
  const dica = (await p.locator('.ind-area-dica').innerText()).replace(/\s+/g, ' ');
  await p.locator('.chip', { hasText: 'Pedidos marcados pelo chat' }).click(); await p.locator('.ind-area').waitFor();
  const minis2 = (await p.locator('.ind-mini').allInnerTexts()).map((x) => x.replace(/\s+/g, ' '));
  await t.ctx.close();
  return { ok: pontos === 7 && grad === 1 && caminhos === 2 && minis[0] === `${[0, 1, 2, 3, 4, 5, 6].reduce((q, i) => q + 10 + i, 0)} soma dos 7 dias` && /melhor dia \(16\)/.test(minis[1]) && /pessoas que abriram o chat/.test(dica) && minis2[0] === `${[0, 1, 2, 3, 4, 5, 6].reduce((q, i) => q + 3 + (i % 3), 0)} soma dos 7 dias`, detalhe: JSON.stringify({ pontos, grad, caminhos, minis, dica, minis2 }) };
});
await caso('Sem veredito: nada de "Bom/Ruim/Atenção", "período foi bom", "o que fazer" ou "por quê"; só números', async () => {
  const t = await abrir(); await abaInd(t);
  const txt = await textoAba(t); const chips = await t.page.locator('.ind-chip, .ind-faixa, .ind-dir, .ind-why').count();
  await t.ctx.close();
  return { ok: chips === 0 && !/O período (foi|pede)|Ver por quê|O que fazer|O que dá para melhorar|Poucos dados|Causa:|Melhorar:/.test(txt), detalhe: `chips=${chips} ` + (txt.match(/O período (foi|pede)|Ver por quê|O que fazer|Causa:|Melhorar:/) || [''])[0] };
});
await caso('Ordem da página: números do chat, marcações do chat, equipe, chat do site, onde o chat é usado e marcação automática (nada de clínica toda, avaliações, conferência nem gráfico mensal)', async () => {
  const t = await abrir({ admin: true }); await abaInd(t);
  const tits = await t.page.locator('.ind-pg h3.ind-sec').allInnerTexts(); const txt = await textoAba(t);
  await t.ctx.close();
  return { ok: tits.join('|') === 'Visão da agenda (marcações)|A equipe de atendimento|O chat do site|Onde o chat mais é usado' && !/Avaliações dos pacientes|Nota média|Conferência|Para comparar: a clínica toda|Faltas por|Motivos dos cancelamentos/.test(txt), detalhe: tits.join('|') };
});
await caso('Funil: 6 passos, a maior queda marcada (só uma) e os dois painéis de por que pararam', async () => {
  const t = await abrir(); await abaInd(t);
  const rots = await t.page.locator('.ind-painel', { hasText: 'Caminho do paciente no chat' }).first().locator('.ind-rot').allInnerTexts();
  const fortes = await t.page.locator('.ind-perda.forte').allInnerTexts();
  const txt = await textoAba(t);
  await t.ctx.close();
  return { ok: rots.length === 6 && rots[0] === 'Abriram o chat' && rots[5] === 'Chat deu como agendado' && fortes.length === 1 && /18 pessoas pararam aqui \(45%\) · maior queda/.test(fortes[0])
    && /Último passo de quem não agendou/.test(txt) && /Escolha de data e horário/.test(txt) && /Como a conversa terminou sem agendar/.test(txt) && /Ninguém da equipe respondeu/.test(txt), detalhe: rots.join(',') + fortes.join('|') };
});
await caso('Por unidade: pessoas, agendaram, marcações da plataforma (consultas · exames), canceladas ou remarcadas e faltas', async () => {
  const t = await abrir(); await abaInd(t);
  const linhas = await t.page.locator('.ind-card', { has: t.page.locator('h4', { hasText: 'Por unidade' }) }).locator('tbody tr').evaluateAll((l) => l.map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.trim()).join('|')));
  await t.ctx.close();
  return { ok: linhas.join(';') === 'CSI|43|6 (14%)|6|1 · 5|1 (16,7%)|0 de 2 (0%);CSI RM/TC|31|6 (19,4%)|6|0 · 6|2 (33,3%)|—;Desenvoar|320|112 (35%)|122|121 · 1|9 (7,4%)|3 de 18 (16,7%);Sem unidade definida|6|1 (16,7%)|0|0 · 0|0 (—)|—', detalhe: linhas.join(';') };
});
await caso('Por unidade: quem não escolheu unidade fica em "Sem unidade definida" (não repete em todas) e as linhas somam o total de pessoas', async () => {
  const t = await abrir(); await abaInd(t);
  const cartao = t.page.locator('.ind-card', { has: t.page.locator('h4', { hasText: 'Por unidade' }) });
  const rots = await cartao.locator('.ind-bd-rot').allInnerTexts(), total = (await cartao.innerText()).match(/Total: (\d+) pessoas/);
  await t.ctx.close();
  return { ok: rots.join('|') === 'CSI|CSI RM/TC|Desenvoar|Sem unidade definida' && total && total[1] === '400', detalhe: rots.join('|') + ' ' + (total ? total[0] : 'sem total') };
});
await caso('Funil: a pessoa encerrada como "Agendado" sem pedido agendado aparece em nota (conta em Agendaram, não nas etapas do meio)', async () => {
  const t = await abrir(); await abaInd(t);
  const txt = (await t.page.locator('.ind-painel', { hasText: 'Caminho do paciente no chat' }).first().innerText()).replace(/\s+/g, ' ');
  await t.ctx.close();
  return { ok: /2 pessoas foram encerradas como "Agendado", mas o pedido não está agendado/.test(txt) && /Chat deu como agendado/.test(txt) && /\d+ confirmados no Klingo · \d+ sem confirmação/.test(txt), detalhe: txt.slice(-260) };
});
await caso('O que mais pedem e planos: pedidos e planos com pessoas, agendaram e %; os que quase não agendam ficam destacados', async () => {
  const t = await abrir(); await abaInd(t);
  const sec = t.page.locator('.ind-card', { has: t.page.locator('h4', { hasText: /^(Mais pedidos|Planos mais usados)$/ }) });
  const linhas = await sec.locator('tbody tr').evaluateAll((l) => l.map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.trim()).join('|')));
  const baixos = await sec.locator('tr.ind-baixo').count();
  await t.ctx.close();
  return { ok: linhas.join(';') === 'Consulta (sem especialidade informada)|100|45|45%;Consulta Neuropediatria|60|6|10%;Consulta Ortopediatra|25|6|24%;Unimed|50|20|40%;Bradesco Saude|40|14|35%;Planserv|10|0|0%' && baixos === 2, detalhe: linhas.join(';') + ' baixos=' + baixos };
});
await caso('Funil por tipo (recolhido): consultas e exames separados', async () => {
  const t = await abrir(); await abaInd(t);
  const linhas = await t.page.locator('.ind-det table tbody tr').evaluateAll((l) => l.map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.trim()).join('|')));
  const fechado = await abrir(); await fechado.page.click('.nav button[data-aba=indicadores]'); await fechado.page.waitForSelector('.ind-kpis .ind-kpi');
  const aberto = await fechado.page.evaluate(() => document.querySelector('.ind-det').open); await fechado.ctx.close();
  await t.ctx.close();
  return { ok: linhas.join(';') === 'Começaram o pedido|42|3;Chegaram à escolha de data|38|2;Escolheram o horário|21|1;Terminaram o pedido|19|1;Pedido marcado|14|1' && aberto === false, detalhe: linhas.join(';') + ' aberto=' + aberto };
});

await caso('Atalhos de período: Ontem, 7 dias, 30 dias, Este mês e Mês anterior pedem as datas certas', async () => {
  const t = await abrir(); await abaInd(t);
  const [a, m] = HOJE.split('-').map(Number), p2 = (x) => String(x).padStart(2, '0');
  const esperado = { 'Ontem': [mais(HOJE, -1), mais(HOJE, -1)], 'Últimos 7 dias': [mais(HOJE, -6), HOJE], 'Últimos 30 dias': [mais(HOJE, -29), HOJE], 'Este mês': [`${a}-${p2(m)}-01`, HOJE],
    'Mês anterior': [new Date(Date.UTC(a, m - 2, 1)).toISOString().slice(0, 10), new Date(Date.UTC(a, m - 1, 0)).toISOString().slice(0, 10)] };
  const falhas = [];
  for (const [rot, [de, ate]] of Object.entries(esperado)) {
    await t.page.click(`.ind-atalhos .chip >> text=${rot}`);
    await t.page.waitForFunction(([r]) => document.querySelector('.ind-atalhos .chip[aria-pressed=true]')?.textContent === r, [rot]);
    await t.page.waitForSelector('.ind-kpis .ind-kpi');
    const q = await ultimoD(t); if (q.p_de !== de || q.p_ate !== ate) falhas.push(`${rot}: ${q.p_de}..${q.p_ate} (esperado ${de}..${ate})`);
  }
  await t.ctx.close();
  return { ok: !falhas.length && !t.reg.excecoes.length, detalhe: falhas.join(' | ') };
});

await caso('Período livre: "Ver período" pede esse intervalo, datas invertidas são arrumadas e os atalhos soltam', async () => {
  const t = await abrir(); await abaInd(t);
  const d1 = mais(HOJE, -20), d2 = mais(HOJE, -10);
  await t.page.fill('.ind-ctl input[aria-label="Data inicial"]', d2); await t.page.fill('.ind-ctl input[aria-label="Data final"]', d1);   // invertido de propósito
  await t.page.click('.ind-ctl .btn >> text=Ver período');
  await t.page.waitForFunction(([x]) => document.querySelector('.pagina .sub')?.textContent.includes(x), [d1.split('-').reverse().join('/')]);
  const a = await ultimoD(t), aprox = await t.page.locator('.ind-atalhos .chip[aria-pressed=true]').count();
  await t.ctx.close();
  return { ok: a.p_de === d1 && a.p_ate === d2 && aprox === 0 && !t.reg.excecoes.length, detalhe: `${a.p_de}..${a.p_ate}` };
});
await caso('Período livre: mudar as duas datas carrega sozinho (sem clicar) e data futura avisa em vez de ser aceita em silêncio', async () => {
  const t = await abrir(); await abaInd(t);
  const d = mais(HOJE, -3), fut = mais(HOJE, 5);
  await t.page.fill('.ind-ctl input[aria-label="Data inicial"]', d); await t.page.fill('.ind-ctl input[aria-label="Data final"]', d);
  await t.page.waitForFunction(([x]) => document.querySelector('.pagina .sub')?.textContent.includes(x), [d.split('-').reverse().join('/')], { timeout: 4000 });
  const a = await ultimoD(t);
  await t.page.fill('.ind-ctl input[aria-label="Data inicial"]', fut); await t.page.fill('.ind-ctl input[aria-label="Data final"]', fut);
  await t.page.click('.ind-ctl .btn >> text=Ver período'); await new Promise((r) => setTimeout(r, 1300));
  const aviso = await t.page.locator('.toast, #toast').first().innerText().catch(() => '');
  const futuras = t.reg.rpcs.filter((r) => r[0] === 'decisao' && (r[1].p_de > HOJE || r[1].p_ate > HOJE)).length;
  await t.ctx.close();
  return { ok: a.p_de === d && a.p_ate === d && futuras === 0 && /ainda não chegaram/.test(aviso) && !t.reg.excecoes.length, detalhe: `${a.p_de}..${a.p_ate} futuras=${futuras} ${aviso}` };
});
await caso('Filtro de unidade do topo vai para a consulta e os números mudam (60 → 40 pessoas)', async () => {
  const t = await abrir(); await abaInd(t);
  await t.page.selectOption('#selUnidade', 'desenvoar'); await t.page.waitForFunction(() => /Unidade Desenvoar/.test(document.querySelector('.pagina')?.innerText || ''));
  const v = (await t.page.locator('.ind-kpi', { hasText: 'Procuraram o chat' }).locator('b').innerText()).trim();
  const un = (await ultimoD(t)).p_unidade;
  await t.ctx.close();
  return { ok: v === '40' && un === 'desenvoar' && !t.reg.excecoes.length, detalhe: `${v} ${un}` };
});
await caso('"Incluir conversas de teste": só o administrador vê a caixa; marcar manda p_incluir_teste = true', async () => {
  const comum = await abrir(); await abaInd(comum);
  const vistaComum = await comum.page.locator('.ind-teste').count();
  await comum.ctx.close();
  const t = await abrir({ admin: true }); await abaInd(t);
  const vistaAdm = await t.page.locator('.ind-teste').count();
  await t.page.check('.ind-teste input'); await t.page.waitForFunction(() => document.querySelector('.ind-teste input')?.checked);
  await new Promise((r) => setTimeout(r, 300));
  const a = await ultimoD(t);
  await t.ctx.close();
  return { ok: vistaComum === 0 && vistaAdm === 1 && a.p_incluir_teste === true, detalhe: `comum=${vistaComum} adm=${vistaAdm} ${a.p_incluir_teste}` };
});
await caso('Sem o SQL novo no banco, mostra a mensagem com o arquivo a aplicar e não quebra', async () => {
  const t = await abrir({ semSql: true });
  await t.page.click('.nav button[data-aba=indicadores]'); await t.page.waitForSelector('.pagina .erro');
  const txt = await t.page.locator('.pagina').first().innerText();
  await t.ctx.close();
  return { ok: /supabase\/indicadores-decisao\.sql/.test(txt) && !t.reg.excecoes.length };
});

await caso('Avisos: conflito, dado faltando (adulto) e dado faltando de FILHO chegam como cartões na aba Avisos; no filho, o CPF do responsável não vai para a criança', async () => {
  const t = await abrir({ conf: true }); await t.page.click('.nav button[data-aba=avisos]'); await t.page.waitForSelector('#avisosPaciente .sug');
  const cartoes = await t.page.locator('#avisosPaciente .sug').evaluateAll((l) => l.map((c) => c.innerText.replace(/\s+/g, ' ')));
  await t.ctx.close();
  const conf = cartoes.find((x) => /Conflito entre o chat e o Klingo/.test(x)) || '', filho = cartoes.find((x) => /filho\(a\)/.test(x) && /Falta dado/.test(x)) || '', adulto = cartoes.find((x) => /Lucia/i.test(x)) || '';
  return { ok: cartoes.length === 3 && /CPF diferente/.test(conf) && /marcação 900001/.test(conf) && /do responsável e o Klingo está sem/.test(filho) && /Não coloque o CPF do responsável no cadastro da criança/.test(filho)
    && /celular e e-mail e o Klingo está sem\. Adicione no cadastro do Klingo/.test(adulto) && /Conferido/.test(conf), detalhe: cartoes.join(' || ') };
});


await browser.close(); srv.close();

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
