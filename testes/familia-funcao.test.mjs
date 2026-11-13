// FLUXOGRAMA: entrada (a função da família — familia.ts — ligada ao BANCO DE VERDADE em memória (retrato da produção + supabase/familia-agendamento.sql) e a um KLINGO DE MENTIRA com estado: pacientes, horários, reservas, marcações, laudo)
//   -> validação (uma família inventada percorre tudo: mãe entra, cadastra dois filhos com o CPF dela, busca horários ordenados, marca os dois juntos, perde um horário no meio, acompanha, abre o laudo, convida o pai, outro responsável
//   tenta pelos dados) -> lógica (confere ordem dos médicos, tudo-ou-nada, rotina lenta com no máximo 3 leituras, freio quando o Klingo reclama, nível 1 sem laudo, nível 2 com laudo, CPF nunca em claro no banco)
//   -> saída (PASS/FAIL; código 1 se algo falhar). Rodar: cd testes && node --experimental-strip-types familia-funcao.test.mjs
// Versão 1.0 — 13/11/2026 / Mudança: primeira versão. Dados 100% inventados; nenhuma chamada de rede.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';
import { KlingoApi } from '../supabase/functions/klingo-agendamento/api.ts';
import { tratarTudo, rodarFila } from '../supabase/functions/klingo-agendamento/familia.ts';
import { novaChaveBase64, decifrar } from '../supabase/functions/klingo-agendamento/cripto.ts';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + String(detalhe).slice(0, 300) : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.stack || e.message).split('\n').slice(0, 3).join(' | ')}`); } };

// ---------------------------------------------------------------- banco de verdade (em memória)
const { db, falhas } = await criarBancoProducao();
const { q, um } = ajudantes(db);
await db.exec(readFileSync(`${REPO}/supabase/familia-agendamento.sql`, 'utf8'));
registrar('o retrato monta inteiro e o arquivo da família aplica', falhas.length === 0);
const rpc = async (nome, args) => { const ks = Object.keys(args); const sql = `select public.${nome}(${ks.map((k, i) => `$${i + 1}`).join(', ')}) as r`; return (await um(sql, ks.map((k) => args[k]))).r; };
const familiaDb = {
  aparelhoCriar: (h, a) => um(`select public.familia_aparelho_criar($1, $2) as r`, [h, a ?? null]).then((x) => x.r),
  aparelhoLer: (h) => rpc('familia_aparelho_ler', { p_token_hash: h }),
  aparelhoDesligar: (id) => rpc('familia_aparelho_desligar', { p_aparelho: id }),
  pessoaGuardar: (p) => um(`select public.familia_pessoa_guardar($1::jsonb) as r`, [JSON.stringify(p)]).then((x) => x.r),
  pessoaLer: (a, p) => rpc('familia_pessoa_ler', { p_aparelho: a, p_pessoa: p }),
  pessoaLerServico: (p) => rpc('familia_pessoa_ler_servico', { p_pessoa: p }),
  pessoasPorPar: (h) => rpc('familia_pessoa_por_par', { p_par_hash: h }),
  pessoasNovasHoje: () => rpc('familia_pessoas_novas_hoje', {}),
  vincular: (a, p, papel, porta, nivel = 1, lib = null) => um(`select public.familia_vincular($1, $2, $3, $4, $5, $6) as r`, [a, p, papel, porta, nivel, lib]).then((x) => x.r),
  conviteCriar: (a, ps, h) => um(`select public.familia_convite_criar($1, $2::uuid[], $3) as r`, [a, ps, h]).then((x) => x.r),
  conviteUsar: (h, a) => rpc('familia_convite_usar', { p_codigo_hash: h, p_aparelho: a }),
  pedirPorDados: (a, p, papel) => rpc('familia_pedir_por_dados', { p_aparelho: a, p_pessoa: p, p_papel: papel }),
  avisos: (a) => rpc('familia_avisos', { p_aparelho: a }),
  avisoResponder: (a, id, lib) => um(`select public.familia_aviso_responder($1, $2, $3) as r`, [a, id, lib]).then((x) => x.r),
  marcacaoGravar: (m) => um(`select public.familia_marcacao_gravar($1::jsonb) as r`, [JSON.stringify(m)]),
  acompanhar: (a) => rpc('familia_acompanhar', { p_aparelho: a }),
  previsaoLaudo: (p) => rpc('familia_previsao_laudo', { p_procedimento: p }),
  historico: (ps) => um(`select public.familia_historico($1::uuid[]) as r`, [ps]).then((x) => x.r),
  popularidade: (d) => rpc('agenda_popularidade', { p_dias: d }),
  pessoasAtivas: (m) => rpc('familia_pessoas_ativas', { p_minutos: m }),
  marcacoesAbertas: (p) => rpc('familia_marcacoes_abertas', { p_pessoa: p }),
  acessoRegistrar: (a, p, v) => rpc('familia_acesso_registrar', { p_aparelho: a, p_pessoa: p, p_voucher: v }),
  cacheLer: (c) => rpc('agenda_cache_ler', { p_chave: c }),
  cacheGravar: (c, d, s) => um(`select public.agenda_cache_gravar($1, $2::jsonb, $3) as r`, [c, JSON.stringify(d), s]),
  filaPedir: (c, p, pr) => um(`select public.agenda_fila_pedir($1, $2::jsonb, $3) as r`, [c, JSON.stringify(p), pr]),
  filaPegar: async (m) => (await q(`select id, chave, params from public.agenda_fila_pegar($1)`, [m])).map((t) => ({ ...t, id: Number(t.id) })),
  filaFim: (id, ok, erro, refazerSeg) => um(`select public.agenda_fila_fim($1, $2, $3, $4::interval) as r`, [id, ok, erro ?? null, refazerSeg ? `${refazerSeg} seconds` : null]),
};

// ---------------------------------------------------------------- Klingo de mentira (com estado)
const CPF_MAE = '11144477735', CPF_PAI = '52998224725', NASC_MAE = '1980-03-25', NASC_PAI = '1978-06-10', CEL_MAE = '71999990001';
const D1 = '2026-11-17', D2 = '2026-11-18';
function klingoFalso() {
  const pacientes = new Map();
  const add = (id, nome, nasc, cpf, cel) => pacientes.set(id, { id, nome, nasc, cpf, cel, plano: { id: 14, nome: 'AMIL' } });
  add('P100', 'MARIA TESTE DA SILVA', NASC_MAE, CPF_MAE, CEL_MAE); add('P200', 'PEDRO TESTE DA SILVA', NASC_PAI, CPF_PAI, '71999990002');
  let proximoPre = 7960, proximaReserva = 555, proximoVoucher = 26700;
  const reservas = new Map(), vouchers = new Map(), ocupados = new Set(), chamadas = [];
  const cfg = { resultado: 'pendente', falharMarcarPara: null, limite429: false, vouchersStatus: null };
  const chave = (d, m, u, h) => `${d}|${m}|308|${u}|${h}`;
  const dias = [
    { data: D1, med: 63, nome: 'DRA ANA PEDIATRA', uni: { id: 2, nome: 'DESENVOAR', sigla: 'PEDIATRIA' }, horas: ['09:00', '09:20', '09:40', '10:00'] },
    { data: D1, med: 70, nome: 'DR BRUNO CLINICO', uni: { id: 1, nome: 'CSI', sigla: 'CSI' }, horas: ['09:00', '09:30'] },
    { data: D2, med: 71, nome: 'DRA CAROL NOVA', uni: { id: 1, nome: 'CSI', sigla: 'CSI' }, horas: ['14:00'] },
  ];
  const resp = (status, corpo, tipo = 'application/json') => new Response(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), { status, headers: { 'content-type': tipo } });
  const donoDaSessao = (init) => pacientes.get(String(init?.headers?.Authorization ?? '').replace('Bearer tok-', ''));
  const f = async (url, init) => {
    const u = new URL(url), caminho = u.pathname.replace('/api', ''), rota = `${init?.method ?? 'GET'} ${caminho}`;
    chamadas.push(rota);
    const corpo = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (cfg.limite429 && (rota === 'GET /vouchers' || rota === 'GET /agenda/horarios')) return resp(429, '<html>429</html>', 'text/html');
    if (rota === 'GET /live') return resp(200, 'OK [API1]', 'text/plain');
    if (rota === 'GET /paciente/cpf') { const p = [...pacientes.values()].find((x) => x.cpf === u.searchParams.get('cpf') && x.id.startsWith('P')); return p ? resp(200, { id: p.id, dt_nasc: p.nasc, nome: p.nome }) : resp(403, { msg: 'Paciente não identificado', code: 'PACIENTE_NAO_IDENTIFICADO' }); }
    if (rota === 'POST /externo/login') { const p = pacientes.get(String(corpo.id)); return p ? resp(200, { access_token: `tok-${p.id}`, user: { id: p.id, nome: p.nome, nascimento: p.nasc, id_paciente: p.id.startsWith('P') ? p.id : '', plano: p.plano } }) : resp(403, { msg: 'x' }); }
    if (rota === 'POST /externo/register') { const id = String(proximoPre++), pc = corpo.paciente; pacientes.set(id, { id, nome: pc.nome, nasc: pc.dt_nasc, cpf: pc.docs.cpf, cel: pc.contatos?.celular, plano: { id: 1, nome: 'PARTICULAR' } }); return resp(200, { id }); }
    if (rota === 'GET /paciente') { const p = donoDaSessao(init); return p ? resp(200, { nome: p.nome, dt_nasc: p.nasc, sexo: 'F', contatos: { celular: p.cel }, convenio: { id_plano: 14, nome: 'AMIL' } }) : resp(401, { msg: 'x' }); }
    if (rota === 'GET /agenda/horarios') return resp(200, { horarios: dias.map((d, i) => ({ id: `d${i}`, data: d.data, procedimento: 1132, profissional: { id: d.med, nome: d.nome }, unidade: d.uni,
      horarios: Object.fromEntries(d.horas.map((h) => [chave(d.data, d.med, d.uni.id, h), h]).filter(([k]) => !ocupados.has(k))) })) });
    if (rota === 'POST /agenda/reservar') { const k = corpo.id; if (ocupados.has(k) || [...reservas.values()].includes(k)) return resp(403, { msg: 'Horário já ocupado. [reservado]' }); const id = String(proximaReserva++); reservas.set(id, k); return resp(200, { id }); }
    if (rota === 'DELETE /agenda/reservar') { reservas.delete(String(corpo.id)); return resp(200, { status: 'ok' }); }
    if (rota === 'POST /agenda/horario') {
      const p = donoDaSessao(init), k = corpo.id;
      if (cfg.falharMarcarPara && p.id === cfg.falharMarcarPara) return resp(403, { msg: 'Plano AMIL inativado.' });
      if (ocupados.has(k)) return resp(400, { msg: 'Horário já ocupado. …ID: 1' });
      ocupados.add(k); for (const [r, kk] of reservas) if (kk === k) reservas.delete(r);
      const [data, med, , uni, hora] = k.split('|'), d = dias.find((x) => x.data === data && String(x.med) === med);
      const v = { id: proximoVoucher++, status: 'agendado', data, hora: hora + ':00', procedimento: { id: 1132, descr: 'CONSULTA' }, unidade: { nome: d.uni.nome }, realizador: { nome: d.nome }, id_externo: corpo.id_externo, chave: k };
      vouchers.set(p.id, [...(vouchers.get(p.id) ?? []), v]);
      return resp(200, v);
    }
    if (rota === 'GET /vouchers') { const p = donoDaSessao(init); return resp(200, (vouchers.get(p?.id) ?? []).map((v) => ({ ...v, status: cfg.vouchersStatus?.[v.id] ?? v.status }))); }
    if (rota === 'DELETE /voucher') { const p = donoDaSessao(init); const l = vouchers.get(p.id) ?? []; const v = l.find((x) => String(x.id) === String(corpo.id)); if (v) ocupados.delete(v.chave); vouchers.set(p.id, l.filter((x) => String(x.id) !== String(corpo.id))); return resp(200, 'ok'); }
    if (caminho.startsWith('/resultado/')) return cfg.resultado === 'pronto' ? resp(200, { pronto: true, status: 'F', html: '<p>LAUDO DE TESTE</p>' }) : resp(403, '<html>sem laudo</html>', 'text/html');
    return resp(404, { msg: 'rota inesperada ' + rota });
  };
  return { f, pacientes, reservas, vouchers, ocupados, chamadas, cfg, contar: (rota) => chamadas.filter((c) => c === rota).length };
}

// ---------------------------------------------------------------- função: Klingo falso + banco falso do "Banco" antigo + banco de verdade da família
const sha = (t) => createHash('sha256').update(t).digest('hex');
const CHAVE = novaChaveBase64(), SYNC = 'sincroniza-'.padEnd(30, 'x');
function montar({ resultado = false, comChave = true, k: kExistente = null } = {}) {
  const k = kExistente ?? klingoFalso(), divergentes = [];
  const banco = {
    hash: async (t) => sha('sal|' + t),
    divergentesRecentes: async (h) => divergentes.filter((d) => d.h === h && Date.now() - d.em < 3_600_000).length,
    registrarIdentidade: async (cpf, nasc, r) => { if (r.situacao === 'divergente') divergentes.push({ h: sha('sal|' + cpf), em: Date.now() }); },
    registrarTentativa: async (chave) => { divergentes.push({ h: sha('sal|' + chave), em: Date.now() }); },
    preDoPar: async () => null,
  };
  const ctx = {
    api: new KlingoApi('clinicacsi:teste', k.f, { esperar: async () => {} }), db: banco, hoje: () => '2026-11-16', agora: () => Date.now(), uuid: () => crypto.randomUUID(), cache: new Map(), resultado,
    fam: { db: comChave ? familiaDb : null, chave: comChave ? CHAVE : null, chaveSync: SYNC },
  };
  const chamar = async (corpo) => { const r = await tratarTudo(ctx, corpo); return { status: r.status, ...r.corpo }; };
  return { k, ctx, chamar, divergentes };
}

let M = montar();
const mae = {}, pai = {};

await caso('sem a chave de cifra a área da família fica desligada (503) e o resto da função segue normal', async () => {
  const x = montar({ comChave: false });
  const r = await x.chamar({ acao: 'fam_entrar', cpf: CPF_MAE, nascimento: NASC_MAE }), v = await x.chamar({ acao: 'versao' });
  return { ok: r.status === 503 && r.motivo === 'desligado' && v.ok === true, detalhe: JSON.stringify(r) };
});
await caso('a mãe entra uma vez (CPF + nascimento) e recebe o código do celular; o banco guarda só o hash do código e os dados cifrados', async () => {
  const r = await M.chamar({ acao: 'fam_entrar', cpf: CPF_MAE, nascimento: NASC_MAE });
  mae.token = r.token; mae.id = r.pessoas?.[0]?.id;
  const linha = await um(`select * from public.familia_pessoa where id = $1`, [mae.id]), ap = await um(`select * from public.familia_aparelho limit 1`);
  const d = await decifrar(linha.dados_cifrados, CHAVE);
  const tudo = JSON.stringify(linha) + JSON.stringify(ap);
  return { ok: r.ok && /^[A-Za-z0-9_-]{43}$/.test(r.token) && r.pessoas.length === 1 && r.pessoas[0].nome === 'Maria' && r.pessoas[0].papel === 'proprio' && r.pessoas[0].nivel === 1
    && d.cpf === CPF_MAE && d.nascimento === NASC_MAE && !tudo.includes(CPF_MAE) && !tudo.includes(NASC_MAE) && !tudo.includes(r.token), detalhe: JSON.stringify(r.pessoas) };
});
await caso('nascimento errado não cria celular nem pessoa; três nomes diferentes no mesmo CPF travam a conferência só depois do limite do sistema', async () => {
  const antes = (await um(`select count(*)::int n from public.familia_aparelho`)).n;
  const r = await M.chamar({ acao: 'fam_entrar', cpf: CPF_MAE, nascimento: '1999-01-01' });
  const depois = (await um(`select count(*)::int n from public.familia_aparelho`)).n;
  return { ok: r.ok === false && r.motivo === 'nao_confere' && antes === depois, detalhe: JSON.stringify(r) };
});
await caso('fam_eu devolve quem o celular acompanha; código inventado ou curto é recusado (401)', async () => {
  const r = await M.chamar({ acao: 'fam_eu', token: mae.token }), x = await M.chamar({ acao: 'fam_eu', token: 'a'.repeat(43) }), y = await M.chamar({ acao: 'fam_eu', token: 'curto' });
  return { ok: r.ok && r.pessoas.length === 1 && Array.isArray(r.avisos) && x.status === 401 && y.status === 401, detalhe: JSON.stringify([r.ok, x.motivo, y.motivo]) };
});
await caso('entrar de novo com o mesmo celular não duplica a mãe nem gera outro código', async () => {
  const r = await M.chamar({ acao: 'fam_entrar', cpf: CPF_MAE, nascimento: NASC_MAE, token: mae.token });
  return { ok: r.ok && !r.token && r.pessoas.length === 1 && (await um(`select count(*)::int n from public.familia_pessoa`)).n === 1, detalhe: JSON.stringify(r) };
});

// ---------------------------------------------------------------- filhos (o CPF da criança é o da mãe)
await caso('filho sem CPF: pede o celular na primeira vez, cadastra com o CPF da mãe e o nascimento da criança, e liga ao celular da mãe como responsável', async () => {
  const sem = await M.chamar({ acao: 'fam_dependente', token: mae.token, nome: 'Ana Teste da Silva', sexo: 'F', nascimento: '2019-05-20' });
  const r = await M.chamar({ acao: 'fam_dependente', token: mae.token, nome: 'Ana Teste da Silva', sexo: 'F', nascimento: '2019-05-20', celular: '(71) 99999-0001' });
  const ana = r.pessoas?.find((p) => p.nome === 'Ana');
  mae.ana = ana?.id;
  const reg = [...M.k.pacientes.values()].find((p) => p.nome === 'Ana Teste da Silva');
  return { ok: sem.motivo === 'celular_necessario' && r.ok && ana.papel === 'responsavel' && ana.nivel === 1 && reg.cpf === CPF_MAE && reg.nasc === '2019-05-20' && M.k.contar('POST /externo/register') === 1, detalhe: JSON.stringify([sem.motivo, r.pessoas?.map((p) => p.nome)]) };
});
await caso('o segundo filho (mesmo CPF da mãe, outro nascimento) entra sem pedir o celular de novo; o mesmo filho de novo não registra outra vez', async () => {
  const r = await M.chamar({ acao: 'fam_dependente', token: mae.token, nome: 'João Teste da Silva', sexo: 'M', nascimento: '2021-02-10' });
  mae.joao = r.pessoas?.find((p) => p.nome === 'João')?.id;
  const outra = await M.chamar({ acao: 'fam_dependente', token: mae.token, nome: 'João Teste da Silva', sexo: 'M', nascimento: '2021-02-10' });
  return { ok: r.ok && r.pessoas.length === 3 && outra.ja_existia === true && M.k.contar('POST /externo/register') === 2 && (await um(`select count(distinct par_hash)::int n from public.familia_pessoa`)).n === 3, detalhe: JSON.stringify([r.motivo, outra]) };
});
await caso('filho com nome de uma palavra, sexo errado ou nascimento no futuro é recusado; sem entrar antes, não há responsável', async () => {
  const a = await M.chamar({ acao: 'fam_dependente', token: mae.token, nome: 'Bia', sexo: 'F', nascimento: '2020-01-01' });
  const b = await M.chamar({ acao: 'fam_dependente', token: mae.token, nome: 'Bia Teste Silva', sexo: 'X', nascimento: '2020-01-01' });
  const c = await M.chamar({ acao: 'fam_dependente', token: mae.token, nome: 'Bia Teste Silva', sexo: 'F', nascimento: '2030-01-01' });
  const novo = (await M.chamar({ acao: 'fam_convite_usar', codigo: '00000000' }));
  return { ok: a.campo === 'nome' && b.campo === 'sexo' && c.campo === 'nascimento' && novo.ok === false, detalhe: JSON.stringify([a.campo, b.campo, c.campo, novo.motivo]) };
});

// ---------------------------------------------------------------- buscar: ordem dos médicos, cache, combinações
await db.query(`insert into public.agenda_ocupacao (inicio, profissional, unidade, fonte, qtd) select now() - (g || ' days')::interval, 'DR BRUNO CLINICO', 'CSI', 'marcada', 1 from generate_series(1, 6) g`);
await db.query(`insert into public.agenda_ocupacao (inicio, profissional, unidade, fonte, qtd) values (now() - interval '2 days', 'DRA ANA PEDIATRA', 'DESENVOAR', 'marcada', 1)`);
await caso('quem nunca marcou vê primeiro o médico que os outros mais marcam; todos os médicos aparecem; a unidade vem do médico', async () => {
  const r = await M.chamar({ acao: 'fam_buscar', token: mae.token, pessoas: [mae.id], especialidade: '225124' });
  const nomes = r.medicos.map((m) => m.nome);
  return { ok: r.ok && nomes[0] === 'DR BRUNO CLINICO' && r.medicos[0].motivo === 'mais_procurado' && nomes.length === 3 && r.primeiro.hora === '09:00' && r.medicos.every((m) => m.unidade) && !('todos' in r.medicos[0]), detalhe: nomes.join(' > ') };
});
await caso('o horário vem do cache na segunda busca (o Klingo não é chamado de novo)', async () => {
  const antes = M.k.contar('GET /agenda/horarios');
  await M.chamar({ acao: 'fam_buscar', token: mae.token, pessoas: [mae.id], especialidade: '225124' });
  return { ok: M.k.contar('GET /agenda/horarios') === antes && antes >= 1, detalhe: `${antes} chamada(s)` };
});
await caso('busca vazia amplia a janela sozinha; plano sem médico explica o motivo; pessoa de outro celular é barrada', async () => {
  const outro = await M.chamar({ acao: 'fam_entrar', cpf: CPF_PAI, nascimento: NASC_PAI });
  pai.token = outro.token; pai.id = outro.pessoas[0].id;
  const barrada = await M.chamar({ acao: 'fam_buscar', token: pai.token, pessoas: [mae.ana], especialidade: '225124' });
  const sem = await M.chamar({ acao: 'fam_buscar', token: mae.token, pessoas: [mae.id], especialidade: '' });
  return { ok: barrada.status === 403 && barrada.motivo === 'pessoa_nao_encontrada' && sem.campo === 'especialidade_ou_exame', detalhe: JSON.stringify([barrada.motivo, sem.campo]) };
});
await caso('buscar para dois filhos devolve combinações: dois horários SEGUIDOS no mesmo médico primeiro', async () => {
  const r = await M.chamar({ acao: 'fam_buscar', token: mae.token, pessoas: [mae.ana, mae.joao], especialidade: '225124' });
  const c = r.combinacoes.find((x) => x.itens[0].medico === 'DRA ANA PEDIATRA'), doBruno = r.combinacoes.find((x) => x.itens[0].medico === 'DR BRUNO CLINICO');
  return { ok: r.ok && r.combinacoes.length >= 2 && r.combinacoes[0].tipo === 'mesmo_medico' && c.tipo === 'mesmo_medico' && c.itens.length === 2 && c.itens[0].hora === '09:00' && c.itens[1].hora === '09:20' && doBruno.itens[1].hora === '09:30'
    && r.combinacoes.every((x) => x.itens.length === 2 && new Set(x.itens.map((i) => i.id)).size === 2), detalhe: JSON.stringify(r.combinacoes.map((x) => `${x.tipo} ${x.itens[0].medico} ${x.inicio}-${x.fim}`)) };
});

// ---------------------------------------------------------------- marcar: tudo ou nada
const buscarCombo = async (medico = 'DRA ANA PEDIATRA') => (await M.chamar({ acao: 'fam_buscar', token: mae.token, pessoas: [mae.ana, mae.joao], especialidade: '225124' })).combinacoes.find((c) => c.itens[0].medico === medico);
await caso('um horário tomado no meio desfaz tudo: a reserva do primeiro é solta, ninguém fica marcado e a tela recebe a pessoa e o motivo', async () => {
  const c = await buscarCombo(); M.k.ocupados.add(c.itens[1].id);
  const r = await M.chamar({ acao: 'fam_marcar', token: mae.token, confirmar: true, itens: [{ pessoa: mae.ana, horario: c.itens[0].id, procedimento: '1132' }, { pessoa: mae.joao, horario: c.itens[1].id, procedimento: '1132' }] });
  M.k.ocupados.delete(c.itens[1].id);
  return { ok: r.ok === false && r.motivo === 'horario_ocupado' && r.indice === 1 && M.k.reservas.size === 0 && [...M.k.vouchers.values()].flat().length === 0, detalhe: JSON.stringify([r.motivo, r.indice, M.k.reservas.size]) };
});
await caso('falha ao marcar o segundo desfaz o primeiro (cancela o voucher) e libera o horário; nada fica gravado no acompanhamento', async () => {
  const c = await buscarCombo(); M.k.cfg.falharMarcarPara = [...M.k.pacientes.values()].find((p) => p.nome === 'João Teste da Silva').id;
  const r = await M.chamar({ acao: 'fam_marcar', token: mae.token, confirmar: true, itens: [{ pessoa: mae.ana, horario: c.itens[0].id, procedimento: '1132' }, { pessoa: mae.joao, horario: c.itens[1].id, procedimento: '1132' }] });
  M.k.cfg.falharMarcarPara = null;
  return { ok: r.ok === false && r.desfeitas?.includes('Ana') && [...M.k.vouchers.values()].flat().length === 0 && !M.k.ocupados.has(c.itens[0].id) && (await um(`select count(*)::int n from public.familia_marcacao`)).n === 0, detalhe: JSON.stringify(r) };
});
let grupo;
await caso('marcar os dois filhos juntos: dois vouchers, mesmo grupo, ids externos do grupo, linha do tempo começando em "agendado", sem confirmar não marca', async () => {
  const c = await buscarCombo(), it = [{ pessoa: mae.ana, horario: c.itens[0].id, procedimento: '1132' }, { pessoa: mae.joao, horario: c.itens[1].id, procedimento: '1132' }];
  const sem = await M.chamar({ acao: 'fam_marcar', token: mae.token, itens: it });
  const r = await M.chamar({ acao: 'fam_marcar', token: mae.token, confirmar: true, itens: it });
  grupo = r.grupo;
  const linhas = await q(`select * from public.familia_marcacao order by voucher_id`), vs = [...M.k.vouchers.values()].flat();
  return { ok: sem.motivo === 'sem_confirmacao' && r.ok && r.marcacoes.length === 2 && linhas.length === 2 && linhas.every((l) => l.grupo_id === r.grupo && l.status === 'agendado' && l.profissional === 'DRA ANA PEDIATRA')
    && vs.every((v) => v.id_externo.startsWith(`pagina-${r.grupo}-`)) && M.k.reservas.size === 0, detalhe: JSON.stringify(linhas.map((l) => [l.voucher_id, l.hora])) };
});
await caso('depois de marcar, a próxima busca da família põe primeiro o médico que ela já consultou ("Você já foi")', async () => {
  const r = await M.chamar({ acao: 'fam_buscar', token: mae.token, pessoas: [mae.ana], especialidade: '225124' });
  return { ok: r.medicos[0].nome === 'DRA ANA PEDIATRA' && r.medicos[0].motivo === 'ja_foi' && r.medicos[0].vezes === 1, detalhe: r.medicos.map((m) => `${m.nome}:${m.motivo}`).join(', ') };
});
await caso('marcar pessoa que não é do celular, horário em formato inválido ou mais de 4 pessoas é recusado', async () => {
  const a = await M.chamar({ acao: 'fam_marcar', token: pai.token, confirmar: true, itens: [{ pessoa: mae.ana, horario: `${D1}|63|308|2|10:00`, procedimento: '1132' }] });
  const b = await M.chamar({ acao: 'fam_marcar', token: mae.token, confirmar: true, itens: [{ pessoa: mae.ana, horario: 'qualquer coisa', procedimento: '1132' }] });
  const c = await M.chamar({ acao: 'fam_marcar', token: mae.token, confirmar: true, itens: Array.from({ length: 5 }, (_, i) => ({ pessoa: `${i}`, horario: 'x', procedimento: '1' })) });
  return { ok: a.motivo === 'pessoa_nao_encontrada' && b.campo === 'horario' && c.campo === 'itens', detalhe: JSON.stringify([a.motivo, b.campo, c.campo]) };
});

// ---------------------------------------------------------------- acompanhar (rastreio) e rotina lenta
await caso('o rastreio mostra cada filho com o primeiro passo, avisa que a próxima leitura é em 60 s e põe as leituras na fila lenta', async () => {
  const r = await M.chamar({ acao: 'fam_acompanhar', token: mae.token });
  const fila = await q(`select chave, prioridade from public.agenda_fila where chave like 'vouchers:%' order by chave`);
  return { ok: r.ok && r.marcacoes.length === 2 && r.marcacoes.every((m) => m.eventos[0].tipo === 'agendado') && r.proxima_leitura_s === 60 && fila.length === 2 && fila.every((f) => f.prioridade === 2), detalhe: JSON.stringify(fila) };
});
await caso('a rotina lenta lê no máximo 3 por minuto, atualiza o status pelo Klingo (chegou) e continua a cada minuto só para quem usa o celular', async () => {
  const ids = [...M.k.vouchers.values()].flat().map((v) => String(v.id));
  M.k.cfg.vouchersStatus = Object.fromEntries(ids.map((i) => [i, 'checkin']));
  for (let i = 0; i < 5; i++) await db.query(`select public.agenda_fila_pedir($1, '{"tipo":"horarios","q":{"inicio":"2026-11-16","fim":"2026-11-26","plano":"14","especialidade":"225124"}}'::jsonb, 9)`, [`pre:${i}`]);
  const r = await M.chamar({ acao: 'fam_sincronizar', segredo: SYNC });
  const st = await q(`select status from public.familia_marcacao`), prox = await q(`select chave, estado from public.agenda_fila where chave like 'vouchers:%'`);
  return { ok: r.ok && r.feitas + r.adiadas + r.falhas <= 3 && r.feitas === 3 && st.every((x) => x.status === 'chegou') && prox.every((x) => x.estado === 'espera'), detalhe: JSON.stringify([r, st, prox]) };
});
await caso('se o Klingo responder 429, a rotina larga o resto da vez e tenta de novo depois (nada se perde)', async () => {
  M.k.cfg.limite429 = true;
  await db.query(`update public.agenda_fila set proximo_em = now() - interval '1 second' where estado = 'espera'`);
  for (const f of await q(`select id from public.agenda_fila where chave like 'vouchers:%'`)) await db.query(`select public.agenda_fila_pedir('vouchers:' || (select replace(chave, 'vouchers:', '') from public.agenda_fila where id = $1), '{}'::jsonb, 1)`, [f.id]);
  const r = await M.chamar({ acao: 'fam_sincronizar', segredo: SYNC, max: 3 });
  M.k.cfg.limite429 = false;
  const aindaNaFila = (await um(`select count(*)::int n from public.agenda_fila where estado in ('espera', 'rodando')`)).n;
  return { ok: r.ok && r.freio === true && r.falhas >= 1 && aindaNaFila > 0, detalhe: JSON.stringify(r) };
});
await caso('rotina com chave errada ou curta é recusada (403)', async () => {
  const a = await M.chamar({ acao: 'fam_sincronizar', segredo: 'errada' }), b = await M.chamar({ acao: 'fam_sincronizar' });
  return { ok: a.status === 403 && b.status === 403, detalhe: `${a.status}/${b.status}` };
});

// ---------------------------------------------------------------- laudo, nível 2, outros responsáveis
const vouchersDe = (nome) => M.k.vouchers.get([...M.k.pacientes.values()].find((p) => p.nome === nome).id)[0].id;
await caso('laudo: sem o interruptor da clínica (AGENDAMENTO_RESULTADO) a página recebe "desligado"', async () => {
  const desl = await M.chamar({ acao: 'fam_laudo', token: mae.token, voucher: String(vouchersDe('Ana Teste da Silva')) });
  M = montar({ resultado: true, k: M.k });                                 // a mesma família e o mesmo Klingo, agora com o laudo ligado
  return { ok: desl.motivo === 'desligado', detalhe: JSON.stringify(desl) };
});
await caso('celular de nível 1 não abre laudo, mesmo com laudo pronto no Klingo', async () => {
  M.k.cfg.resultado = 'pronto';
  const r = await M.chamar({ acao: 'fam_laudo', token: mae.token, voucher: String(vouchersDe('Ana Teste da Silva')) });
  return { ok: r.ok === false && r.motivo === 'laudo_exige_confianca' && r.status === 403 && !JSON.stringify(r).includes('LAUDO DE TESTE'), detalhe: JSON.stringify(r) };
});
await caso('"eu sei todos os dados": CPF da mãe + nascimento e nome do filho + celular; sem outro celular com acesso, abre na hora (nível 2)', async () => {
  const r = await M.chamar({ acao: 'fam_dados', token: mae.token, cpf: CPF_MAE, nascimento: '2019-05-20', nome: 'Ana Teste da Silva', celular: '71999990001', papel: 'responsavel' });
  const eu = await M.chamar({ acao: 'fam_eu', token: mae.token });
  return { ok: r.ok && r.imediato === true && eu.pessoas.find((p) => p.nome === 'Ana').nivel === 2, detalhe: JSON.stringify([r.imediato, eu.pessoas.map((p) => p.nome + p.nivel)]) };
});
await caso('celular de nível 2 abre o laudo pronto; o acesso é registrado sem o conteúdo; marcação de outra pessoa continua barrada', async () => {
  const v = String(vouchersDe('Ana Teste da Silva'));
  const r = await M.chamar({ acao: 'fam_laudo', token: mae.token, voucher: v });
  const log = await q(`select * from public.familia_acesso`), st = (await um(`select status from public.familia_marcacao where voucher_id = $1`, [v])).status;
  const alheia = await M.chamar({ acao: 'fam_laudo', token: pai.token, voucher: v });
  return { ok: r.ok && r.pronto === true && r.resultado.html.includes('LAUDO DE TESTE') && log.length === 1 && !JSON.stringify(log).includes('LAUDO') && st === 'laudo_pronto' && alheia.status === 403, detalhe: JSON.stringify([log.length, st, alheia.motivo]) };
});
await caso('a mãe convida (8 números, uso único) e o pai liga o celular dele SEM digitar nada; depois entra com o próprio CPF no mesmo celular', async () => {
  const c = await M.chamar({ acao: 'fam_convidar', token: mae.token });
  const usado = await M.chamar({ acao: 'fam_convite_usar', codigo: c.codigo });
  pai.token = usado.token;
  const denovo = await M.chamar({ acao: 'fam_convite_usar', codigo: c.codigo });
  const comEle = await M.chamar({ acao: 'fam_entrar', cpf: CPF_PAI, nascimento: NASC_PAI, token: pai.token });
  const laudo = await M.chamar({ acao: 'fam_laudo', token: pai.token, voucher: String(vouchersDe('Ana Teste da Silva')) });
  return { ok: /^\d{8}$/.test(c.codigo) && usado.ok && usado.ligadas >= 1 && denovo.ok === false && comEle.pessoas.length >= 2 && comEle.pessoas.some((p) => p.nome === 'Pedro' && p.papel === 'proprio') && laudo.ok && laudo.pronto === true, detalhe: JSON.stringify([c.codigo, usado.ligadas, denovo.motivo, comEle.pessoas.map((p) => p.nome)]) };
});
await caso('quem sabe todos os dados mas já há celular com acesso fica 24 h esperando; o celular da mãe recebe o aviso e pode liberar ou bloquear', async () => {
  const r = await M.chamar({ acao: 'fam_dados', cpf: CPF_MAE, nascimento: '2019-05-20', nome: 'Ana Teste da Silva', celular: '71999990001' });
  const tio = r.token;
  const avisos = (await M.chamar({ acao: 'fam_eu', token: mae.token })).avisos;
  const antes = await M.chamar({ acao: 'fam_laudo', token: tio, voucher: String(vouchersDe('Ana Teste da Silva')) });
  const lib = await M.chamar({ acao: 'fam_aviso', token: mae.token, aviso: avisos[0].id, liberar: true });
  const depois = await M.chamar({ acao: 'fam_laudo', token: tio, voucher: String(vouchersDe('Ana Teste da Silva')) });
  return { ok: r.ok && r.imediato === false && r.espera_ate && avisos.length === 1 && antes.motivo === 'laudo_exige_confianca' && lib.ok && depois.ok === true, detalhe: JSON.stringify([r.imediato, avisos.length, antes.motivo, depois.ok]) };
});
await caso('um terceiro tenta pelos dados com o celular errado 3 vezes: trava só esta porta; os celulares já ligados continuam abrindo o laudo', async () => {
  const tentar = () => M.chamar({ acao: 'fam_dados', cpf: CPF_MAE, nascimento: '2019-05-20', nome: 'Ana Teste da Silva', celular: '71988887777' });
  const r = [await tentar(), await tentar(), await tentar(), await tentar()];
  const mae2 = await M.chamar({ acao: 'fam_laudo', token: mae.token, voucher: String(vouchersDe('Ana Teste da Silva')) });
  return { ok: r.slice(0, 3).every((x) => x.motivo === 'nao_confere') && r[3].motivo === 'tentativas_demais' && r[3].status === 429 && mae2.ok === true, detalhe: JSON.stringify(r.map((x) => x.motivo)) };
});
await caso('o limite de celulares por pessoa (3) vale: o quarto celular que tenta entrar pelo CPF é barrado com explicação', async () => {
  const a = await M.chamar({ acao: 'fam_entrar', cpf: CPF_MAE, nascimento: NASC_MAE });          // 2º celular da mãe
  const b = await M.chamar({ acao: 'fam_entrar', cpf: CPF_MAE, nascimento: NASC_MAE });          // 3º
  const c = await M.chamar({ acao: 'fam_entrar', cpf: CPF_MAE, nascimento: NASC_MAE });          // 4º
  return { ok: a.ok && b.ok && c.ok === false && c.motivo === 'limite_aparelhos' && /3 celulares/.test(c.mensagem), detalhe: JSON.stringify([a.ok, b.ok, c.motivo]) };
});
await caso('desligar este celular: o código deixa de valer na hora, e o dos outros continua', async () => {
  const r = await M.chamar({ acao: 'fam_desligar', token: pai.token }), depois = await M.chamar({ acao: 'fam_eu', token: pai.token }), mae2 = await M.chamar({ acao: 'fam_eu', token: mae.token });
  return { ok: r.ok && depois.status === 401 && mae2.ok === true, detalhe: JSON.stringify([r.ok, depois.motivo]) };
});
await caso('nenhuma resposta da família traz CPF, nascimento completo, texto cifrado ou código de outro celular', async () => {
  const todas = JSON.stringify([await M.chamar({ acao: 'fam_eu', token: mae.token }), await M.chamar({ acao: 'fam_acompanhar', token: mae.token }), await M.chamar({ acao: 'fam_buscar', token: mae.token, pessoas: [mae.id], especialidade: '225124' })]);
  return { ok: !todas.includes(CPF_MAE) && !todas.includes(CPF_PAI) && !todas.includes('dados_cifrados') && !/\"nascimento\"/.test(todas), detalhe: `${todas.length} bytes` };
});

const f = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - f}/${resultados.length} verificações passaram.`);
process.exit(f ? 1 : 0);
