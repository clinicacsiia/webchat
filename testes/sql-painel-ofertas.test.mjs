// FLUXOGRAMA: entrada (clone da produção + partes 1 a 3 do WebChat v2 + supabase/painel-ofertas.sql; pacientes de mentira) -> validação (só admin e atendente; tipo e estado conhecidos) -> processamento (oferecer, aceitar, recusar, dispensar; recusou uma vez não recebe mais; cadastro na Disponibilidade futura pela equipe)
//   -> persistência (só no clone) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 16/11/2026 / Mudança: primeira versão (Etapa 2: sugestões com ação na conversa; regra do dono: recusou uma vez, não oferece mais).
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { await como('').catch(() => {}); registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste'), ('klingo_interno_segredo', 'interno-de-teste')`);
let sqlErro = null;
for (const f of ['webchat-v2-parte1-modos', 'webchat-v2-parte2-calendario-api', 'webchat-v2-parte3-disponibilidade-futura', 'painel-ofertas']) {
  try { await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8')); } catch (e) { sqlErro = `${f}: ${String(e.message).split('\n')[0]}`; }
}
registrar('o retrato da produção monta inteiro e as partes 1 a 3 do WebChat v2 e a painel-ofertas aplicam sem erro', falhas.length === 0 && !sqlErro, sqlErro ?? '');

const ADMIN = '00000000-0000-4000-8000-0000000000a1', ATEND = '00000000-0000-4000-8000-0000000000a2', NAOEQUIPE = '00000000-0000-4000-8000-0000000000b1';
const UNIDADE = 'CLÍNICA DE SAÚDE E IMAGEM - CSI';
await db.exec(`
  insert into auth.users (id, email) values ('${ADMIN}', 'admin@exemplo.invalid'), ('${ATEND}', 'atendente@exemplo.invalid'), ('${NAOEQUIPE}', 'paciente@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADMIN}', 'Admin Teste', 'admin@exemplo.invalid', 'admin', true), ('${ATEND}', 'Ana Atendente', 'atendente@exemplo.invalid', 'atendente', true);
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo'), ('nome_empresa', 'Clínica de Teste'), ('boas_vindas', 'Olá!'), ('reabrir_dias', '2') on conflict (chave) do update set valor = excluded.valor;
  insert into public.catalogo_regiao (codigo, nome, padrao, tem_lado, grupo, ordem) values ('joelho', 'Joelho', 'JOELHO', true, 'perna', 1);
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values (201, 'RESSONANCIA MAGNETICA DO JOELHO (UNILATERAL)', 'RESSONANCIA MAGNETICA', true, 9, '');
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select 201, 'RM JOELHO', '${UNIDADE}', 'RESSONANCIA', 'DRA EXEMPLO IMAGEM', 'RADIOLOGIA', d, '08:00', '12:00', 30, current_date - 30, current_date + 300 from generate_series(0, 6) d;
`);
const cfg = (chave, valor) => db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]);
const dia = (n) => new Date(Date.now() + n * 864e5).toLocaleString('sv-SE', { timeZone: 'America/Bahia' }).slice(0, 10);
const dow = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
const TESTE = '71900000001';
const CAMPO = (c) => (c.tipo === 'sexo' ? 'F' : c.tipo === 'data' ? '25/03/1980' : c.tipo === 'cpf' ? '111.444.777-35' : c.tipo === 'tel' ? '(71) 99999-0001' : c.tipo === 'email' ? 'maria@exemplo.invalid'
  : c.tipo === 'cep' ? '40000-000' : c.tipo === 'uf' ? 'BA' : c.nome === 'nome' ? 'Maria Teste da Silva' : c.nome === 'mae' ? 'Ana Teste da Silva' : c.nome === 'numero' ? '10' : 'Texto de teste');
let nTel = 0;
const telefone = () => '7198' + String(5000000 + ++nTel);
const rpc = async (nome, args) => {
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  const r = await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k])));
  return r[0].r;
};
const comoPaciente = async (fn) => { await anonimo(); try { return await fn(); } finally { await como(''); } };
const erroDe = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, msg: String(e.message).split('\n')[0] }; } };
const lista = new Set([TESTE]);
const ativar = (p) => { lista.add(p.tel); return cfg('klingo_api_telefones_teste', [...lista].join(',')); };
let nNasc = 0;
const nascUnico = () => { nNasc++; return `${String(1 + (nNasc % 27)).padStart(2, '0')}/${String(1 + (nNasc % 11)).padStart(2, '0')}/${1950 + nNasc}`; };   // cada paciente de mentira é uma PESSOA diferente (a mesma pessoa cai na mesma solicitação)
async function ateOCalendario(nasc = nascUnico()) {
  const tel = telefone();
  await anonimo();
  const r = await rpc('chat_iniciar', { p_nome: 'Maria Teste da Silva', p_telefone: tel, p_email: 'maria@exemplo.invalid', p_aceite: true, p_paciente_tipo: 'proprio' });
  const p = { c: r.conversa_id, t: r.token, tel, ult: r.respostas.at(-1) };
  for (let i = 0; i < 30; i++) {
    const o = p.ult.opcoes;
    if (!o || o.tipo === 'calendario' || o.tipo === 'acompanhar') break;
    await anonimo();
    let x;
    if (o.tipo === 'escolha') { const it = (o.itens || [])[0]; x = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: JSON.stringify(it.valor), p_texto: it.rotulo }); }
    else if (o.tipo === 'campos') { const v = {}; for (const cp of o.campos || []) v[cp.nome] = cp.tipo === 'data' && nasc ? nasc : CAMPO(cp); x = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: v, p_texto: null }); }
    else if (o.tipo === 'busca_exame' || o.tipo === 'pedido_exames') {
      const ex = await rpc('chat_exames', { p_conversa: p.c, p_token: p.t, p_modalidade: 'RM', p_regiao: 'joelho' });
      x = await rpc('chat_pedido_enviar', { p_conversa: p.c, p_token: p.t, p_itens: [{ modalidade: 'RM', regiao: 'joelho', lado: 'D', procedimento_id: ex[0].id }] });
    } else throw new Error(`tipo não tratado: ${o.tipo}`);
    const ag = ((x && x.respostas) || []).filter((m) => m.autor === 'agente');
    if (!ag.length) throw new Error(`sem resposta depois de ${o.passo}`);
    p.ult = ag.at(-1);
  }
  await como('');
  if (p.ult.opcoes?.tipo !== 'calendario') throw new Error(`não chegou ao calendário (parou em ${p.ult.opcoes?.passo || p.ult.opcoes?.tipo})`);
  return p;
}
const registrarPedido = (p, dados) => comoPaciente(() => rpc('chat_disponibilidade_registrar', { p_conversa: p.c, p_token: p.t, p_dados: dados }));
const base = (extra = {}) => ({ data_ini: dia(1), data_fim: dia(30), dias_semana: [1, 2, 3, 4, 5], turno: 'manha', aceita_notificacao: true, canais: ['chat'], ...extra });

const comoEquipe = async (uid, fn) => { await como(uid); try { return await fn(); } finally { await como(''); } };
const conversaSimples = async () => {
  const ct = (await um(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, ['Paciente Teste', telefone()])).id;
  return (await um(`insert into public.conversas (contato_id, nome_informado, status, ia_ativa) values ($1, 'Paciente Teste', 'em_atendimento', false) returning id`, [ct])).id;
};
const ofertar = (uid, conv, tipo, estado) => comoEquipe(uid, () => rpc('painel_oferta_registrar', { p_conversa: conv, p_tipo: tipo, p_estado: estado }));
const ver = (uid, convs) => comoEquipe(uid, async () => (await q(`select public.painel_ofertas($1::uuid[]) r`, [convs]))[0].r);

await caso('oferecer horário e depois "recusou": o painel passa a ver "recusado"', async () => {
  const c = await conversaSimples();
  const a = await ofertar(ATEND, c, 'horario', 'oferecido'), b = await ofertar(ATEND, c, 'horario', 'recusado'), v = await ver(ATEND, [c]);
  return { ok: a.ok && b.ok && v.horario?.estado === 'recusado' && !v.disponibilidade, detalhe: JSON.stringify(v) };
});

await caso('REGRA DO DONO: recusou uma vez, não oferece mais (o banco bloqueia a nova oferta do mesmo tipo)', async () => {
  const c = await conversaSimples();
  await ofertar(ATEND, c, 'horario', 'oferecido'); await ofertar(ATEND, c, 'horario', 'recusado');
  const de_novo = await ofertar(ADMIN, c, 'horario', 'oferecido');
  const v = await ver(ADMIN, [c]);
  return { ok: de_novo.ok === false && de_novo.bloqueado === true && de_novo.motivo === 'ja_recusado' && v.horario.estado === 'recusado', detalhe: JSON.stringify(de_novo) };
});

await caso('"Dispensar" também impede nova oferta; o outro tipo de oferta continua livre', async () => {
  const c = await conversaSimples();
  await ofertar(ATEND, c, 'horario', 'dispensado');
  const bloq = await ofertar(ATEND, c, 'horario', 'oferecido');
  const livre = await ofertar(ATEND, c, 'disponibilidade', 'oferecido');
  return { ok: bloq.bloqueado === true && bloq.motivo === 'ja_dispensado' && livre.ok === true, detalhe: JSON.stringify([bloq, livre]) };
});

await caso('repetir o mesmo passo não duplica; aceitou depois de oferecido vale', async () => {
  const c = await conversaSimples();
  await ofertar(ATEND, c, 'horario', 'oferecido');
  const rep = await ofertar(ATEND, c, 'horario', 'oferecido');
  await ofertar(ATEND, c, 'horario', 'aceito');
  const n = (await q(`select count(*)::int n from public.painel_oferta where conversa_id = $1`, [c]))[0].n;
  const v = await ver(ATEND, [c]);
  return { ok: rep.repetido === true && n === 2 && v.horario.estado === 'aceito', detalhe: `n=${n} ${JSON.stringify(v)}` };
});

await caso('conversas unidas da mesma pessoa: vale o último passo entre elas', async () => {
  const c1 = await conversaSimples(), c2 = await conversaSimples();
  await ofertar(ATEND, c1, 'horario', 'oferecido'); await ofertar(ATEND, c2, 'horario', 'recusado');
  const v = await ver(ATEND, [c1, c2]);
  return { ok: v.horario.estado === 'recusado', detalhe: JSON.stringify(v) };
});

await caso('quem não é da equipe (paciente logado, anônimo) não registra nem lê', async () => {
  const c = await conversaSimples();
  const e1 = await erroDe(() => ofertar(NAOEQUIPE, c, 'horario', 'oferecido'));
  const e2 = await erroDe(() => ver(NAOEQUIPE, [c]));
  await anonimo(); const e3 = await erroDe(async () => (await q(`select public.painel_ofertas($1::uuid[]) r`, [[c]]))[0].r); await como('');
  const perm = (await q(`select has_table_privilege('authenticated', 'public.painel_oferta', 'select') a, has_table_privilege('anon', 'public.painel_oferta', 'insert') b`))[0];
  return { ok: e1?.code === '42501' && e2?.code === '42501' && !!e3 && perm.a === false && perm.b === false, detalhe: JSON.stringify([e1, e2, e3?.msg, perm]) };
});

await caso('oferta inválida e conversa inexistente são recusadas', async () => {
  const c = await conversaSimples();
  const e1 = await erroDe(() => ofertar(ATEND, c, 'outro', 'oferecido'));
  const e2 = await erroDe(() => ofertar(ATEND, c, 'horario', 'talvez'));
  const e3 = await erroDe(() => ofertar(ATEND, '00000000-0000-4000-8000-00000000ffff', 'horario', 'oferecido'));
  return { ok: e1?.code === '22023' && e2?.code === '22023' && e3?.code === 'P0002', detalhe: JSON.stringify([e1?.code, e2?.code, e3?.code]) };
});

await caso('Disponibilidade futura pela equipe: sem pedido escolhido, avisa em português e não grava nada', async () => {
  const c = await conversaSimples();
  const e = await erroDe(() => comoEquipe(ATEND, () => rpc('painel_disponibilidade_registrar', { p_conversa: c, p_dados: {} })));
  const n = (await q(`select count(*)::int n from public.disponibilidade_pedido where conversa_id = $1`, [c]))[0].n;
  return { ok: /Escolha o exame ou a consulta/.test(e?.msg || '') && n === 0, detalhe: JSON.stringify(e) };
});

await caso('Disponibilidade futura pela equipe: com pedido completo cadastra com aviso autorizado e registra quem fez', async () => {
  const p = await ateOCalendario();
  const r = await comoEquipe(ATEND, () => rpc('painel_disponibilidade_registrar', { p_conversa: p.c, p_dados: { data_ini: dia(1), data_fim: dia(30) } }));
  const ped = (await q(`select estado, aceita_notificacao, canais from public.disponibilidade_pedido where conversa_id = $1`, [p.c]))[0];
  const ev = (await q(`select origem, detalhe from public.disponibilidade_evento where pedido_id = $1 and tipo = 'registrada_pela_equipe'`, [r.id]));
  const v = await ver(ATEND, [p.c]);
  const sem = await erroDe(() => comoEquipe(NAOEQUIPE, () => rpc('painel_disponibilidade_registrar', { p_conversa: p.c, p_dados: {} })));
  return { ok: r.ok === true && !!r.id && ped?.aceita_notificacao === true && (ped.canais || []).includes('chat') && ev.length === 1 && ev[0].origem === 'equipe' && ev[0].detalhe.agente === ATEND && v.disponibilidade?.estado === 'aceito' && sem?.code === '42501',
    detalhe: JSON.stringify([r, ped, ev, v, sem?.code]) };
});

await db.close?.();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
