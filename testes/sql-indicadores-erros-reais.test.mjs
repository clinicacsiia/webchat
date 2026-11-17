// FLUXOGRAMA: entrada (clone da produção + supabase/indicadores-erros-reais.sql; pessoas, pedidos e mensagens INVENTADOS) -> validação (primeiro reproduz os 3 erros com as funções de antes, guardadas em testes/antes-erros-reais/) -> lógica (aplica o SQL novo e confere: balde "sem unidade", funil com andamento real, crédito de atendente) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 17/11/2026 / Mudança: Implementação inicial (revisão dos indicadores de 17/11/2026: 3 erros reais).
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + String(e.message).split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const { db, falhas } = await criarBancoProducao();
const { um, como } = ajudantes(db);

const ADM = '00000000-0000-4000-8000-0000000000b1', ANA = '00000000-0000-4000-8000-0000000000b2', BIA = '00000000-0000-4000-8000-0000000000b3', CAR = '00000000-0000-4000-8000-0000000000b4';
await db.exec(`
  insert into auth.users (id, email) values ('${ADM}', 'adm@exemplo.invalid'), ('${ANA}', 'ana@exemplo.invalid'), ('${BIA}', 'bia@exemplo.invalid'), ('${CAR}', 'car@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Admin Teste', 'adm@exemplo.invalid', 'admin', true), ('${ANA}', 'Ana Teste', 'ana@exemplo.invalid', 'atendente', true),
    ('${BIA}', 'Bia Teste', 'bia@exemplo.invalid', 'atendente', true), ('${CAR}', 'Carla Teste', 'car@exemplo.invalid', 'atendente', true);
`);
for (const [chave, rotulo] of [['csi', 'CSI'], ['rmtc', 'CSI RM/TC'], ['desenvoar', 'Desenvoar']]) {
  await db.query(`insert into public.unidade_config (chave, catalogo, rotulo, descricao, fluxo, instrucao) values ($1, $1, $2, 'teste', 'exame_consulta', 'teste') on conflict (chave) do nothing`, [chave, rotulo]);
}
let seq = 0;
// Uma pessoa = um contato + uma conversa (+ um pedido). unidade = unidade_inicial do formulário (null = não escolheu).
const pessoa = async ({ unidade = null, status = 'rascunho', etapa = 'pedido', motivo = null, dono = null, msgs = [], semPedido = false } = {}) => {
  seq++;
  const ct = (await um(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, ['Paciente Teste ' + seq, '7197' + (3000000 + seq)])).id;
  const conv = (await um(`insert into public.conversas (contato_id, nome_informado, status, agente_id, ia_ativa, unidade_inicial) values ($1, $2, 'em_atendimento', $3, false, $4) returning id`, [ct, 'Paciente Teste ' + seq, dono, unidade])).id;
  if (!semPedido) await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, procedimento, status, etapa) values ($1, 'consulta', 'CONSULTA TESTE', $2, $3)`, [conv, status, etapa]);
  for (const [ag, n] of msgs) for (let i = 0; i < n; i++) await db.query(`insert into public.mensagens (conversa_id, autor, texto, agente_id) values ($1, 'agente', 'oi', $2)`, [conv, ag]);
  if (motivo) await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = $2 where id = $1`, [conv, motivo]);
  return conv;
};
const ler = async (fn, args = '') => { await como(ADM); try { return (await um(`select public.${fn}(${args}) as r`)).r; } finally { await como(null); } };
const hoje = `(now() at time zone 'America/Sao_Paulo')::date`;
const chat = async (un) => (await um(`select public.ind_decisao_periodo(${hoje}, ${hoje}, ${un ? `'${un}'` : 'null'}, false) -> 'chat' as r`)).r;

// 12 pessoas: 2 em CSI, 1 em RM/TC, 3 em Desenvoar, 4 sem unidade (2 só começaram o pedido, 1 só o rascunho do plano mas encerrada "Agendado", 1 conversou sem pedido) e 2 com pedido agendado de verdade.
await pessoa({ unidade: 'csi', status: 'agendado', etapa: 'pronto' });
await pessoa({ unidade: 'csi', status: 'pronto', etapa: 'pronto' });
await pessoa({ unidade: 'rmtc', etapa: 'data_hora' });
await pessoa({ unidade: 'desenvoar', status: 'agendado', etapa: 'pronto' });
await pessoa({ unidade: 'desenvoar', etapa: 'plano' });
await pessoa({ unidade: 'desenvoar', etapa: 'pedido' });
await pessoa({ etapa: 'pedido' });
await pessoa({ etapa: 'pedido' });
await pessoa({ etapa: 'plano', motivo: 'agendado' });   // encerrada como "Agendado", pedido ainda rascunho no plano: ERRO 2
await pessoa({ semPedido: true });

// Antes: as funções de antes (guardadas em testes/antes-erros-reais/).
for (const n of ['ind_decisao_periodo', 'ind_agenda_periodo', 'painel_indicadores_plataforma', 'painel_indicadores_diretoria', 'painel_indicadores_atendentes', 'painel_indicadores_equipe']) {
  await db.exec(readFileSync(`${REPO}/testes/antes-erros-reais/${n}.sql`, 'utf8'));
}
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));

await caso('ERRO 1 (função de antes): quem não tem unidade conta em CSI, RM/TC e Desenvoar ao mesmo tempo', async () => {
  const [t, c, r, d] = [await chat(null), await chat('csi'), await chat('rmtc'), await chat('desenvoar')];
  return { ok: t.entraram === 10 && c.entraram === 2 + 4 && r.entraram === 1 + 4 && d.entraram === 3 + 4, detalhe: `total=${t.entraram} csi=${c.entraram} rmtc=${r.entraram} desenvoar=${d.entraram}` };
});
await caso('ERRO 2 (função de antes): quem foi encerrado "Agendado" sem pedido agendado entra em todas as etapas do funil', async () => {
  const f = (await chat(null)).funil;
  return { ok: f.data_hora === 5 && f.horario === 4 && f.completo === 4 && f.agendaram === 3, detalhe: JSON.stringify(f) };   // reais: 4, 3 e 3; a encerrada "Agendado" soma +1 em cada
});

await db.exec(readFileSync(`${REPO}/supabase/indicadores-erros-reais.sql`, 'utf8'));

await caso('ERRO 1 corrigido: cada pessoa conta numa unidade só; as sem unidade ficam no balde "sem" e a soma fecha com o total', async () => {
  const [t, c, r, d, s] = [await chat(null), await chat('csi'), await chat('rmtc'), await chat('desenvoar'), await chat('sem')];
  const soma = c.entraram + r.entraram + d.entraram + s.entraram;
  return { ok: t.entraram === 10 && c.entraram === 2 && r.entraram === 1 && d.entraram === 3 && s.entraram === 4 && soma === t.entraram, detalhe: `total=${t.entraram} csi=${c.entraram} rmtc=${r.entraram} desenvoar=${d.entraram} sem=${s.entraram}` };
});
await caso('ERRO 1 corrigido: os agendaram também fecham (2 no total = 1 CSI + 1 Desenvoar + 1 sem unidade... só os com pedido ou motivo)', async () => {
  const [t, c, r, d, s] = [await chat(null), await chat('csi'), await chat('rmtc'), await chat('desenvoar'), await chat('sem')];
  const soma = c.funil.agendaram + r.funil.agendaram + d.funil.agendaram + s.funil.agendaram;
  return { ok: t.funil.agendaram === 3 && soma === 3 && s.funil.agendaram === 1, detalhe: `total=${t.funil.agendaram} csi=${c.funil.agendaram} rmtc=${r.funil.agendaram} desenvoar=${d.funil.agendaram} sem=${s.funil.agendaram}` };
});
await caso('ERRO 2 corrigido: a pessoa encerrada "Agendado" com rascunho no plano conta em Agendaram, mas não em horário nem em pedido completo', async () => {
  const f = (await chat(null)).funil;
  // etapas reais: pedido=9 (todos com pedido), data_hora=4 (RM/TC em data_hora, 2 prontos/agendados CSI, 1 agendado Desenvoar), horario/completo=3 (pronto CSI + os 2 agendados)
  return { ok: f.pedido === 9 && f.data_hora === 4 && f.horario === 3 && f.completo === 3 && f.agendaram === 3 && f.agendaram_so_pelo_motivo === 1, detalhe: JSON.stringify(f) };
});
await caso('ERRO 2 corrigido: o "por tipo" segue a mesma regra', async () => {
  const pt = (await chat(null)).por_tipo.consulta;
  return { ok: pt.pedido === 9 && pt.horario === 3 && pt.completo === 3 && pt.agendaram === 3, detalhe: JSON.stringify(pt) };
});
await caso('a diretoria traz a unidade "sem" e as unidades somam o total de pessoas', async () => {
  const r = await ler('painel_indicadores_diretoria');
  const u = r.unidades || {}, soma = ['csi', 'rmtc', 'desenvoar', 'sem'].reduce((t, k) => t + ((u[k] || {}).pessoas || 0), 0);
  return { ok: !!u.sem && u.sem.pessoas === 4 && soma === 10, detalhe: `sem=${(u.sem || {}).pessoas} soma=${soma}` };
});
await caso('a aba de marcações aceita o filtro de unidade sem repetir quem não tem unidade', async () => {
  const [c, r, d] = [await ler('painel_indicadores_agenda', `${hoje}, ${hoje}, 'csi'`), await ler('painel_indicadores_agenda', `${hoje}, ${hoje}, 'rmtc'`), await ler('painel_indicadores_agenda', `${hoje}, ${hoje}, 'desenvoar'`)];
  const pc = c.atual.pessoas.procuraram, pr = r.atual.pessoas.procuraram, pd = d.atual.pessoas.procuraram;
  return { ok: pc === 2 && pr === 1 && pd === 3, detalhe: `csi=${pc} rmtc=${pr} desenvoar=${pd}` };
});

// ERRO 3: crédito do atendente.
const AGORA = 'now()';
const pa = async (conv, { por = null, auto = false } = {}) => {   // por = uuid (atendente marcando no painel: o gatilho grava agendado_por) ou auto = o sistema (sem login)
  await db.exec(`reset role;`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [por ? JSON.stringify({ sub: por, role: 'authenticated' }) : '']);
  await db.query(`update public.pre_agendamentos set status = 'agendado', agendado_auto_em = case when $2 then now() end where conversa_id = $1`, [conv, auto]);
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};
await db.exec(`delete from public.mensagens; delete from public.pre_agendamentos; delete from public.conversas;`);
const m1 = await pessoa({ status: 'pronto', etapa: 'pronto', dono: ANA, msgs: [[ANA, 2]] });            // sistema confirmou; dono Ana escreveu
const m2 = await pessoa({ status: 'pronto', etapa: 'pronto', dono: CAR });                                // sistema confirmou; dona Carla NÃO escreveu nada
const m3 = await pessoa({ status: 'pronto', etapa: 'pronto', dono: CAR, msgs: [[BIA, 3]] });             // sistema confirmou; dona Carla não escreveu, Bia escreveu
const m4 = await pessoa({ status: 'pronto', etapa: 'pronto', dono: ANA, msgs: [[ANA, 1]] });            // Bia marcou à mão
const m5 = await pessoa({ status: 'pronto', etapa: 'pronto', dono: ANA, msgs: [[ANA, 1]] });            // sistema confirmou, mas a marcação foi cancelada no Klingo
const m6 = await pessoa({ status: 'pronto', etapa: 'pronto', dono: BIA, msgs: [[BIA, 1]] });            // sistema confirmou; depois o paciente remarcou (o Klingo mostra "Cancelada", mas é troca de data): continua contando
await pa(m6, { auto: true }); await pa(m1, { auto: true }); await pa(m2, { auto: true }); await pa(m3, { auto: true }); await pa(m4, { por: BIA }); await pa(m5, { auto: true });
await db.query(`update public.pre_agendamentos set klingo_marcacoes = array['9000001'] where conversa_id = $1`, [m5]);
await db.query(`insert into public.klingo_conferencia (m, marcado_em, origem, status_klingo, conversa_id, ligacao) values ('9000001', current_date, 'webchat', 'Cancelada', $1, 'pedido')`, [m5]);
await db.query(`update public.pre_agendamentos set klingo_marcacoes = array['9000002'] where conversa_id = $1`, [m6]);
await db.query(`insert into public.klingo_conferencia (m, marcado_em, origem, status_klingo, conversa_id, ligacao) values ('9000002', current_date, 'webchat', 'Cancelada', $1, 'pedido')`, [m6]);
await db.query(`insert into public.jornada_coluna (id, nome, ordem, etapa, origem) values ('agendado', 'Agendado', 1, 'agendamento', 'klingo') on conflict (id) do nothing`);
const card = (await um(`insert into public.jornada_card (paciente_chave, data_ref, coluna) values ('teste-remarcado', current_date, 'agendado') returning id`)).id;
await db.query(`insert into public.jornada_exame (card_id, marcacao_id, status, procedimento, agendado_para) values ($1, 'm9000002', 'remarcado', 'CONSULTA TESTE', now())`, [card]);
const por = (r, nome) => (r.pessoas || []).find((p) => p.nome === nome) || {};

await caso('ERRO 3 corrigido (atendentes): quem escreveu ou marcou ganha; dono que não escreveu não ganha; cancelado não conta', async () => {
  const r = await ler('painel_indicadores_atendentes');
  const ana = por(r, 'Ana Teste'), bia = por(r, 'Bia Teste'), car = por(r, 'Carla Teste');
  return { ok: ana.agendados === 1 && ana.agendados_automaticos === 1 && ana.agendados_a_mao === 0 && ana.agendados_cancelados === 1
    && bia.agendados === 3 && bia.agendados_a_mao === 1 && bia.agendados_automaticos === 2 && bia.agendados_cancelados === 0 && (car.agendados || 0) === 0, detalhe: `Ana=${ana.agendados}/${ana.agendados_a_mao}/${ana.agendados_automaticos}/canc ${ana.agendados_cancelados} Bia=${bia.agendados}/${bia.agendados_a_mao}/${bia.agendados_automaticos} Carla=${car.agendados}` };
});
await caso('ERRO 3 corrigido (equipe): mesma regra', async () => {
  const r = await ler('painel_indicadores_equipe');
  return { ok: por(r, 'Ana Teste').agendados === 1 && por(r, 'Bia Teste').agendados === 3 && (por(r, 'Carla Teste').agendados || 0) === 0, detalhe: `Ana=${por(r, 'Ana Teste').agendados} Bia=${por(r, 'Bia Teste').agendados} Carla=${por(r, 'Carla Teste').agendados}` };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
