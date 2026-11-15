// FLUXOGRAMA: entrada (o retrato da produção montado num Postgres embutido + supabase/simulacao-dados.sql e simulacao-externa.sql) -> validação (dados INVENTADOS: atendimentos antigos, exames futuros por situação da confirmação, exames de hoje, conversas esperando, pedidos prontos; confere a base, os horizontes, o dia de hoje, o resultado, a permissão e a privacidade) -> saída (PASS/FAIL por verificação; código de saída 1 se algo falhar)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (área externa da simulação)
// Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(readFileSync(`${REPO}/supabase/simulacao-dados.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/simulacao-externa.sql`, 'utf8'));

const ADMIN = '00000000-0000-4000-8000-0000000000a1', PACIENTE = '00000000-0000-4000-8000-0000000000b1';
await db.exec(`
  insert into auth.users (id, email) values ('${ADMIN}', 'admin@exemplo.invalid'), ('${PACIENTE}', 'paciente@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADMIN}', 'Admin Teste', 'admin@exemplo.invalid', 'admin', true);
  insert into public.jornada_coluna (id, nome, ordem, etapa, origem, sla_min) values
    ('a_confirmar', 'A confirmar', 10, 'agendamento', 'klingo', null), ('confirmado', 'Confirmado', 11, 'agendamento', 'klingo', null),
    ('em_atendimento', 'Em atendimento', 12, 'depois', 'klingo', null), ('finalizado', 'Finalizado', 20, 'depois', 'klingo', null), ('concluido', 'Concluído', 21, 'pos', 'manual', null)
    on conflict (id) do nothing;
`);
const hoje = (await um(`select (now() at time zone 'America/Sao_Paulo')::date as d`)).d.toISOString().slice(0, 10);
const dia = (delta) => { const d = new Date(hoje + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); };
let mid = 5000, n = 0;
const card = async (data, unidade) => (await um(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna) values ($1, $2, $3, 'a_confirmar') returning id`, [`SEGREDO-${++n}`, data, unidade])).id;
const exame = async (data, hora, { unidade = 'CSI 1', status = 'agendado', confirm = 'Confirmado', proc = 'US ABDOME' } = {}) => {
  const c = await card(data, unidade);
  await db.query(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, unidade, agendado_em, agendado_para, status, confirm_status)
    values ($1, $2, $3, $4, ($5::date - 5)::timestamp at time zone 'America/Sao_Paulo', ($5 || ' ' || $6)::timestamp at time zone 'America/Sao_Paulo', $7, $8)`, [c, `m${++mid}`, proc, unidade, data, hora, status, confirm]);
};

// Atendimentos antigos: 3 dias fechados, 10 + 10 + 10 em CSI 1 e 4 + 4 + 4 em CSI 2 -> média 14/dia
for (const d of [-2, -3, -4]) { for (let i = 0; i < 10; i++) await exame(dia(d), '09:00', { status: 'atendido' }); for (let i = 0; i < 4; i++) await exame(dia(d), '10:00', { unidade: 'CSI 2', status: 'atendido', proc: 'RM CRANIO' }); }
// Exames de 14 dias atrás: fora da janela de resultado (14 dias) mas dentro da base se a janela for 28
await exame(dia(-12), '09:00', { status: 'atendido' });
// Futuro: amanhã 3 não confirmados (2 a confirmar + 1 sem resposta) e 1 confirmado; em 5 dias 2 confirmados
await exame(dia(1), '08:00', { confirm: 'A Confirmar' }); await exame(dia(1), '08:30', { confirm: 'A Confirmar' }); await exame(dia(1), '09:00', { confirm: 'Sem Resposta' }); await exame(dia(1), '09:30', { confirm: 'Confirmado' });
await exame(dia(5), '09:00'); await exame(dia(5), '10:00', { unidade: 'CSI 2', proc: 'RM CRANIO' });
// Hoje: 1 atendido, 1 faltou, 1 muito atrasado (horário 00:01, ainda "agendado"), 1 a caminho (23:59)
await exame(hoje, '08:00', { status: 'atendido' }); await exame(hoje, '08:10', { status: 'faltou' }); await exame(hoje, '00:01'); await exame(hoje, '23:59');
// Conversas: 1 esperando há ~2 h, 1 aberta sem espera, 1 de teste esperando (não conta)
await db.exec(`insert into public.contatos (id, nome, telefone) values ('aaaaaaaa-0000-4000-8000-000000000001', 'Contato Teste', '71999990001'), ('aaaaaaaa-0000-4000-8000-000000000002', 'Contato Teste 2', '71999990002'), ('aaaaaaaa-0000-4000-8000-000000000003', 'Contato Teste 3', '71999990003')`);
await db.exec(`insert into public.conversas (id, contato_id, status, cliente_aguarda_desde, teste) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aguardando', now() - interval '2 hours', false),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000002', 'em_atendimento', null, false),
  ('bbbbbbbb-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000003', 'aguardando', now() - interval '5 hours', true)`);
await db.exec(`insert into public.pre_agendamentos (conversa_id, status, atualizado_em) values ('bbbbbbbb-0000-4000-8000-000000000001', 'pronto', now() - interval '30 hours'), ('bbbbbbbb-0000-4000-8000-000000000002', 'rascunho', now())`);

await como(ADMIN);
const j = (await um(`select public.painel_simulacao_externa(28) as j`)).j;
await como(null);

await caso('a função existe, devolve as 7 partes e só admin ou atendente executa', async () => {
  await anonimo(); let a = false; try { await q(`select public.painel_simulacao_externa(28)`); } catch { a = true; }
  await como(PACIENTE); let p = false; try { await q(`select public.painel_simulacao_externa(28)`); } catch { p = true; }
  await como(null);
  const faltam = ['base', 'chat', 'pedidos', 'confirmacao', 'dia_de_hoje', 'resultado', 'gerado_em'].filter((k) => !(k in j));
  return { ok: falhas.length === 0 && !faltam.length && a && p, detalhe: `faltam ${faltam.join(',')}; anon ${a}; paciente ${p}` };
});
await caso('base: total de atendimentos antigos e média por dia, por unidade', async () => {
  const csi1 = j.base.por_unidade.find((u) => u.unidade === 'csi1'), csi2 = j.base.por_unidade.find((u) => u.unidade === 'csi2');
  // dias com dado = 4 (3 dias de 14 + 1 dia de 12 atrás com 1 atendido); total = 3*14 + 1 = 43
  return { ok: j.base.atendidos === 43 && j.base.dias_com_dado === 4 && csi1.atendidos === 31 && csi2.atendidos === 12 && j.base.media_dia === 10.8, detalhe: JSON.stringify(j.base) };
});
await caso('chat: conta só quem espera a equipe e ignora conversa de teste; mostra a mais antiga em minutos', async () => {
  return { ok: j.chat.esperando === 1 && j.chat.abertas === 2 && j.chat.mais_antiga_min >= 119 && j.chat.mais_antiga_min <= 125, detalhe: JSON.stringify(j.chat) };
});
await caso('pedidos: pedido pronto parado e a idade do mais antigo', async () => ({ ok: j.pedidos.prontos === 1 && j.pedidos.mais_antigo_h >= 29 && j.pedidos.rascunhos === 1, detalhe: JSON.stringify(j.pedidos) }));
await caso('confirmação por horizonte e unidade: amanhã 3 sem confirmar de 4; em 4 a 7 dias tudo confirmado', async () => {
  const amanha = j.confirmacao.find((c) => c.ordem === 2 && c.unidade === 'csi1');
  const sete = j.confirmacao.filter((c) => c.ordem === 4);
  return { ok: amanha.a_confirmar === 2 && amanha.sem_resposta === 1 && amanha.confirmado === 1 && amanha.total === 4 && sete.length === 2 && sete.every((c) => c.a_confirmar === 0 && c.sem_resposta === 0 && c.confirmado === 1) && j.confirmacao.find((c) => c.horizonte === 'Amanhã'), detalhe: JSON.stringify(amanha) };
});
await caso('hoje: atendido, falta, atrasado e a caminho', async () => {
  const h = j.dia_de_hoje;
  return { ok: h.previstos === 4 && h.atendidos === 1 && h.faltaram === 1 && h.atrasados >= 1 && h.a_caminho >= 1, detalhe: JSON.stringify(h) };
});
await caso('resultado: faixas por idade, e a entrega registrada é zero (ponto cego)', async () => {
  const r = j.resultado;
  return { ok: r.atendidos_14d === 44 && r.entregues_registrados === 0 && r.faixas.reduce((s, f) => s + f.n, 0) === 44, detalhe: JSON.stringify(r) };
});
await caso('nenhum dado pessoal no resultado e a função só lê', async () => {
  const antes = await um(`select (select count(*) from public.jornada_exame)::int a, (select count(*) from public.conversas)::int b`);
  await como(ADMIN); await q(`select public.painel_simulacao_externa(28)`); await como(null);
  const depois = await um(`select (select count(*) from public.jornada_exame)::int a, (select count(*) from public.conversas)::int b`);
  const txt = JSON.stringify(j);
  return { ok: antes.a === depois.a && antes.b === depois.b && !/SEGREDO|Contato Teste|7199999|nome|telefone|cpf/i.test(txt), detalhe: '' };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
