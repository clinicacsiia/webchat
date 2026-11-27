// FLUXOGRAMA: entrada (o retrato da produção + supabase/pre-marcacao-painel.sql + supabase/pre-marcacao-vencimento.sql; pedidos, consultas e médicos INVENTADOS)
//   -> validação (pre_marcacao_registrar como "anon": prazo vem do servidor no piloto, o aparelho não estica o prazo, pedido vencido não reabre)
//   -> lógica (pre_marcacao_vencer: só pedido "aguardando_equipe" vencido; quem a equipe resolveu ou chamou não some; a rotina existe; consulta_medicos lista os nomes das agendas)
//   -> saída (casos PASS/FAIL)
// Versão 1.0 — 27/11/2026 / Mudança: Implementação inicial (vencimento de 24 h da pré-marcação e lista de médicos da consulta).
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um } = ajudantes(db);
const painel = readFileSync(`${REPO}/supabase/pre-marcacao-painel.sql`, 'utf8'), sql = readFileSync(`${REPO}/supabase/pre-marcacao-vencimento.sql`, 'utf8');
await db.exec(painel);

// executa como um papel do Supabase (anon / service_role) e volta a ser o dono
async function como(papel, texto, params = []) {
  await db.exec(`reset role; set role ${papel}`);
  try { return { ok: true, r: (await q(texto, params))[0]?.r }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec('reset role'); }
}
const horas = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const pedido = (proto, extra = {}) => ({ protocolo: proto, chave: 'chave-inventada-0123456789-' + proto, tipo: 'pre_marcacao', status: 'aguardando_equipe', venceEm: null,
  dados: { paciente: { tipo: 'proprio', nome: 'Ana Teste Inventada', telefone: '71990000001', email: 'ana@exemplo.invalid' }, procNome: 'Consulta com pediatra', pagto: 'convenio', convenio: 'Convenio X', plano: 'Plano Y' }, ...extra });
const reg = (p) => como('anon', `select public.pre_marcacao_registrar($1::jsonb) r`, [JSON.stringify(p)]);
const linha = (proto) => um(`select situacao, fila, obs, origem, vence_em, extract(epoch from (vence_em - now()))/3600 as h, medico from public.pre_marcacao where protocolo = $1`, [proto]);

await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('a migração aplica duas vezes sem erro e o prazo nasce em 24 horas', async () => {
  await db.exec(sql); await db.exec(sql);
  const c = await um(`select valor from public.config where chave = 'pre_marcacao_prazo_horas'`);
  return { ok: c.valor === '24', detalhe: `prazo=${c.valor}` };
});

// ---- piloto: o prazo é do servidor
await caso('piloto: o pedido vence em 24 h, mesmo que o aparelho mande outro prazo', async () => {
  const x = await reg(pedido('CSI-PILOTO01', { origem: 'piloto', venceEm: horas(500) }));
  const l = await linha('CSI-PILOTO01');
  return { ok: x.ok && l.origem === 'piloto' && Math.abs(l.h - 24) < 0.05, detalhe: `origem=${l.origem} prazo=${Number(l.h).toFixed(2)} h` };
});
await caso('piloto: atualizar o pedido não estica o prazo', async () => {
  await db.exec(`update public.pre_marcacao set vence_em = now() + interval '5 hours' where protocolo = 'CSI-PILOTO01'`);
  await reg(pedido('CSI-PILOTO01', { origem: 'piloto', venceEm: horas(500), motivo: 'novo motivo' }));
  const l = await linha('CSI-PILOTO01');
  return { ok: Math.abs(l.h - 5) < 0.05, detalhe: `prazo=${Number(l.h).toFixed(2)} h` };
});
await caso('o prazo vem da configuração (48 h) quando o dono mudar', async () => {
  await db.exec(`update public.config set valor = '48' where chave = 'pre_marcacao_prazo_horas'`);
  await reg(pedido('CSI-PILOTO02', { origem: 'piloto' })); const l = await linha('CSI-PILOTO02');
  await db.exec(`update public.config set valor = 'abc' where chave = 'pre_marcacao_prazo_horas'`);
  await reg(pedido('CSI-PILOTO03', { origem: 'piloto' })); const m = await linha('CSI-PILOTO03');
  await db.exec(`update public.config set valor = '24' where chave = 'pre_marcacao_prazo_horas'`);
  return { ok: Math.abs(l.h - 48) < 0.05 && Math.abs(m.h - 24) < 0.05, detalhe: `48 h -> ${Number(l.h).toFixed(1)}; valor inválido -> ${Number(m.h).toFixed(1)}` };
});
await caso('médico de interesse do piloto (medicoNome) vai para a coluna do painel', async () => {
  await reg(pedido('CSI-PILOTO04', { origem: 'piloto', dados: { ...pedido('x').dados, medicoNome: 'Médica Um', slot: null } }));
  const l = await linha('CSI-PILOTO04');
  return { ok: l.medico === 'Médica Um', detalhe: l.medico };
});

// ---- teste: o seletor da diretoria continua valendo, dentro de 72 h
await caso('teste: o prazo escolhido pela diretoria (48 h) vale; passando de 72 h cai para 24 h', async () => {
  await reg(pedido('TESTE-0001', { venceEm: horas(48) })); const a = await linha('TESTE-0001');
  await reg(pedido('TESTE-0002', { venceEm: horas(500) })); const b = await linha('TESTE-0002');
  return { ok: a.origem === 'teste' && Math.abs(a.h - 48) < 0.05 && Math.abs(b.h - 24) < 0.05, detalhe: `${Number(a.h).toFixed(1)} h e ${Number(b.h).toFixed(1)} h` };
});
await caso('outros tipos (contato por WhatsApp, marcação) não têm prazo', async () => {
  await reg(pedido('TESTE-0003', { tipo: 'contato_whatsapp', status: 'aviso_equipe' })); const l = await linha('TESTE-0003');
  return { ok: l.vence_em === null };
});

// ---- a rotina que vence
const prep = async (proto, { sit = 'aguardando_equipe', fila = 'novo', tipo = 'pre_marcacao', venc = '-1 hour' } = {}) => {
  await reg(pedido(proto, { origem: 'piloto', tipo }));
  await db.query(`update public.pre_marcacao set situacao = $2, fila = $3, vence_em = case when $4 = '' then null else now() + $4::interval end, obs = '' where protocolo = $1`, [proto, sit, fila, venc]);
};
await prep('VENC-NOVO'); await prep('VENC-CONTATO', { fila: 'em_contato' }); await prep('VENC-RESOLVIDO', { fila: 'resolvido' }); await prep('VENC-DESCARTADO', { fila: 'descartado' });
await prep('VENC-MARCADO', { sit: 'marcado' }); await prep('VENC-ZAP', { tipo: 'contato_whatsapp', sit: 'aviso_equipe' }); await prep('VENC-NO-PRAZO', { venc: '3 hours' }); await prep('VENC-SEM-PRAZO', { venc: '' });
await caso('a rotina é do sistema: o público (anon) não consegue rodar', async () => {
  const x = await como('anon', `select public.pre_marcacao_vencer() r`);
  return { ok: x.ok === false, detalhe: (x.msg || '').slice(0, 60) };
});
await caso('vencer: só entram pedidos "aguardando_equipe" com prazo passado, na fila "novo" ou "em_contato"', async () => {
  const x = await como('service_role', `select public.pre_marcacao_vencer() r`);
  return { ok: x.ok && Number(x.r) === 2, detalhe: `vencidos=${x.r} ${x.msg || ''}` };
});
await caso('vencido na fila "novo": situação vencido, sai dos novos (descartado) e a equipe lê o motivo', async () => {
  const l = await linha('VENC-NOVO');
  return { ok: l.situacao === 'vencido' && l.fila === 'descartado' && /Vencido automaticamente/.test(l.obs), detalhe: `${l.situacao}/${l.fila}` };
});
await caso('vencido que a equipe já está atendendo: marca "vencido" mas NÃO some da fila dela', async () => {
  const l = await linha('VENC-CONTATO');
  return { ok: l.situacao === 'vencido' && l.fila === 'em_contato', detalhe: `${l.situacao}/${l.fila}` };
});
await caso('não mexe em resolvido, descartado, marcado, contato por WhatsApp, dentro do prazo ou sem prazo', async () => {
  const ls = await Promise.all(['VENC-RESOLVIDO', 'VENC-DESCARTADO', 'VENC-MARCADO', 'VENC-ZAP', 'VENC-NO-PRAZO', 'VENC-SEM-PRAZO'].map(linha));
  return { ok: ls.every((l) => l.situacao !== 'vencido'), detalhe: ls.map((l) => l.situacao).join(',') };
});
await caso('rodar de novo não muda nada (nada novo para vencer)', async () => {
  const x = await como('service_role', `select public.pre_marcacao_vencer() r`);
  return { ok: x.ok && Number(x.r) === 0 };
});
await caso('pedido vencido não reabre: o mesmo aparelho tenta atualizar e continua vencido', async () => {
  const antes = await linha('VENC-NOVO');
  const x = await reg(pedido('VENC-NOVO', { origem: 'piloto', status: 'aguardando_equipe', motivo: 'tentando reabrir' }));
  const depois = await linha('VENC-NOVO');
  return { ok: x.ok && depois.situacao === 'vencido' && depois.fila === 'descartado', detalhe: `${antes.situacao} -> ${depois.situacao}` };
});
await caso('outro aparelho (outra chave) não mexe no pedido alheio', async () => {
  await reg({ ...pedido('CSI-PILOTO01', { origem: 'piloto', motivo: 'invasor' }), chave: 'outra-chave-inventada-9999999' });
  const l = await um(`select motivo from public.pre_marcacao where protocolo = 'CSI-PILOTO01'`);
  return { ok: l.motivo !== 'invasor', detalhe: l.motivo };
});
await caso('a rotina está agendada a cada 10 minutos', async () => {
  const j = await um(`select schedule, command from cron.job where jobname = 'pre-marcacao-vigia'`);
  return { ok: j && j.schedule === '*/10 * * * *' && /pre_marcacao_vencer/.test(j.command), detalhe: JSON.stringify(j) };
});

// ---- lista de médicos da consulta
await db.exec(`
  insert into public.unidade_config (chave, catalogo, rotulo, descricao, fluxo, instrucao, ordem, ativo) values
    ('desenvoar', 'DESENVOAR', 'Desenvoar', '', 'pediatria', '', 1, true), ('csi', 'CLÍNICA INVENTADA CSI', 'CSI', '', 'exame_consulta', '', 2, true);
  insert into public.config (chave, valor) values ('marcacao_auto_csi', 'nao') on conflict (chave) do update set valor = 'nao';
  insert into public.catalogo_procedimento (id, nome, classe, ativo, especialidade, busca) values (9001, 'CONSULTA INVENTADA PEDIATRA', 'CONSULTAS', true, 'PEDIATRIA', 'consulta inventada pediatra');
  insert into public.catalogo_agenda (unidade, profissional, especialidade, procedimento_id, procedimento, vig_fim) values
    ('DESENVOAR', 'MEDICA UM DA SILVA', 'PEDIATRIA', 9001, 'CONSULTA INVENTADA PEDIATRA', current_date + 30),
    ('DESENVOAR', 'MEDICO DOIS SOUZA', 'PEDIATRIA', 9001, 'CONSULTA INVENTADA PEDIATRA', current_date + 30),
    ('DESENVOAR', 'MEDICO DOIS SOUZA', 'PEDIATRIA', 9001, 'CONSULTA INVENTADA PEDIATRA', current_date + 30),
    ('DESENVOAR', 'MEDICO VENCIDO LIMA', 'PEDIATRIA', 9001, 'CONSULTA INVENTADA PEDIATRA', current_date - 5),
    ('CLÍNICA INVENTADA CSI', 'MEDICO DE OUTRA UNIDADE', 'PEDIATRIA', 9001, 'CONSULTA INVENTADA PEDIATRA', current_date + 30);`);
await caso('consulta_medicos: devolve os nomes (sem repetir), só da unidade que marca sozinha e só de agenda vigente', async () => {
  const x = await como('anon', `select public.consulta_medicos(9001) r`);
  return { ok: x.ok && JSON.stringify(x.r) === JSON.stringify(['MEDICA UM DA SILVA', 'MEDICO DOIS SOUZA']), detalhe: JSON.stringify(x.r) + (x.msg || '') };
});
await caso('consulta_medicos: consulta que não existe devolve lista vazia (não erro)', async () => {
  const x = await como('anon', `select public.consulta_medicos(123456) r`);
  return { ok: x.ok && JSON.stringify(x.r) === '[]' };
});
await caso('consulta_medicos: médico bloqueado pelo painel não aparece', async () => {
  await db.exec(`insert into public.profissional_bloqueio (profissional, nome) values (public.norm_nome('MEDICA UM DA SILVA'), 'MEDICA UM DA SILVA')`);
  const x = await como('anon', `select public.consulta_medicos(9001) r`);
  return { ok: x.ok && JSON.stringify(x.r) === JSON.stringify(['MEDICO DOIS SOUZA']), detalhe: JSON.stringify(x.r) + (x.msg || '') };
});

console.log(`\n${resultados.filter(Boolean).length} de ${resultados.length} passaram`);
process.exit(resultados.every(Boolean) ? 0 : 1);
