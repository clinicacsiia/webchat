// FLUXOGRAMA: entrada (clone da produção + supabase/previsao-marcacao-parte1..6.sql; catálogo, grade e pessoas INVENTADOS)
//   -> validação (desligado; exame inexistente; horário e turno fora do padrão viram "sem filtro", nada barra; limite global)
//   -> lógica (lista só do que tem agenda; disponibilidade = grade menos ocupação, com filtro de turno / a partir de / até / até o dia / unidade; pedido vira mensagem para a equipe, robô desligado)
//   -> saída (PASS/FAIL por caso) | ROLLBACK: previsao-marcacao-parte5-rollback.sql
// Versão 1.0 — 17/11/2026 / Mudança: primeira versão (escolha do exame e do horário na página de Previsão). Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo } = ajudantes(db);
registrar('o retrato da produção monta inteiro', falhas.length === 0, `${falhas.length} falhas`);

const partes = ['parte1-tabelas', 'parte2-paciente', 'parte3-painel', 'parte4-carga', 'parte5-escolha', 'parte6-unidades'].map((n) => readFileSync(`${REPO}/supabase/previsao-marcacao-${n}.sql`, 'utf8'));
await caso('as 6 partes aplicam duas vezes sem erro (idempotente)', async () => { for (const s of [...partes, ...partes]) await db.exec(s); return { ok: true }; });
// catálogos do chat (unidade_config): no clone a tabela nasce vazia; liga os três como estavam antes do dono desligar algum
await db.exec(`insert into public.unidade_config (chave, catalogo, rotulo, descricao, fluxo, instrucao, ordem, ativo) values
  ('desenvoar', 'DESENVOAR', 'Desenvoar', 'x', 'pediatria', 'x', 1, true),
  ('csi', 'CLÍNICA DE SAÚDE E IMAGEM - CSI', 'CSI', 'x', 'exame_consulta', 'x', 2, true),
  ('rmtc', 'CLÍNICA DE SAÚDE E IMAGEM - RM/TC', 'CSI RM/TC', 'x', 'exame_consulta', 'x', 3, true) on conflict (chave) do update set ativo = true`);
await db.exec(`insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste') on conflict (chave) do update set valor = excluded.valor`);
const ligar = (v) => db.exec(`update public.config set valor = '${v}' where chave = 'previsao_marcacao_modo'`);
const chamar = async (fn, args = []) => {
  await anonimo();
  try { return (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args))[0].r; }
  catch (e) { return { erro: String(e.message) }; } finally { await db.exec('reset role'); }
};

// ---- catálogo e grade inventados: ultrassom (agenda), consulta (agenda), ressonância SEM agenda, ultrassom inativo ----
// A grade vale de hoje a +60 dias, TODOS os dias da semana, das 07:00 às 19:00 em passos de 30 min, na unidade CSI com o profissional "DR FULANO".
await db.exec(`
  insert into public.catalogo_procedimento (id, nome, classe, busca, ativo, demanda_90d) values
    (9101, 'ULTRASSONOGRAFIA ABDOME TOTAL', 'ULTRASSONOGRAFIA', to_tsvector('simple', 'ultrassonografia abdome total'), true, 50),
    (9102, 'CONSULTA PEDIATRIA', 'CONSULTAS', to_tsvector('simple', 'consulta pediatria'), true, 80),
    (9103, 'RESSONANCIA JOELHO', 'RESSONANCIA MAGNETICA', to_tsvector('simple', 'ressonancia joelho'), true, 5),
    (9104, 'ULTRASSONOGRAFIA ANTIGA', 'ULTRASSONOGRAFIA', to_tsvector('simple', 'ultrassonografia antiga'), false, 1);
  insert into public.catalogo_agenda (unidade, local, profissional, procedimento_id, procedimento, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select 'CLÍNICA DE SAÚDE E IMAGEM - CSI', 'SALA 1', 'DR FULANO', pid, pnome, dn, '07:00', '19:00', 30, current_date - 1, current_date + 60
    from (values (9101, 'ULTRASSONOGRAFIA ABDOME TOTAL'), (9102, 'CONSULTA PEDIATRIA')) p(pid, pnome), generate_series(0, 6) dn;
  insert into public.catalogo_agenda (unidade, local, profissional, procedimento_id, procedimento, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select 'DESENVOAR', 'SALA 9', 'DRA CICRANA', 9101, 'ULTRASSONOGRAFIA ABDOME TOTAL', dn, '14:00', '16:00', 30, current_date - 1, current_date + 60 from generate_series(0, 6) dn;
`);
await db.exec(`
  insert into public.catalogo_procedimento (id, nome, classe, especialidade, busca, ativo, demanda_90d) values
    (9105, 'ULTRASSONOGRAFIA ANTIGA DO PASSADO', 'ULTRASSONOGRAFIA', null, to_tsvector('simple', 'x'), true, 9),
    (9106, 'ULTRASSONOGRAFIA CONTRASTE ADICIONAL', 'ULTRASSONOGRAFIA', null, to_tsvector('simple', 'x'), true, 9),
    (9107, 'CONSULTA MEDICA', 'CONSULTAS', 'CARDIOLOGIA', to_tsvector('simple', 'x'), true, 0),
    (9108, 'CONSULTA MEDICA', 'CONSULTAS', 'NUTRICAO', to_tsvector('simple', 'x'), true, 0),
    (9109, 'RAIO X SO AGENDADO', 'RADIOLOGIA', null, to_tsvector('simple', 'x'), true, 9);
  update public.catalogo_procedimento set especialidade = 'PEDIATRIA' where id = 9102;
  insert into public.catalogo_agenda (unidade, local, profissional, procedimento_id, procedimento, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select 'CLÍNICA DE SAÚDE E IMAGEM - CSI', 'SALA 2', 'DRA SICRANA', pid, pnome, dn, '08:00', '12:00', 30, current_date - 1, current_date + 60
    from (values (9105, 'ULTRASSONOGRAFIA ANTIGA DO PASSADO'), (9107, 'CONSULTA MEDICA'), (9108, 'CONSULTA MEDICA')) p(pid, pnome), generate_series(0, 6) dn;
`);

// ---- Jornada inventada: o que a clínica FEZ nos últimos 30 dias (status atendido) decide a lista de exames ----
await db.exec(`
  insert into public.jornada_coluna (id, nome, ordem, etapa, origem) values ('atendido', 'Atendido', 9, 'depois', 'klingo'), ('agendado', 'Agendado', 1, 'agendamento', 'klingo') on conflict do nothing;
  insert into public.jornada_paciente (prontuario, nome, fone_chave) values ('8801', 'PACIENTE INVENTADO', 'q1') on conflict do nothing;
  insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna) values ('8801', current_date - 5, 'CSI', 'atendido');
`);
const cardJ = (await q(`select id from public.jornada_card where paciente_chave = '8801' limit 1`))[0].id;
for (const [n, nome, dias, st] of [[1, 'ULTRASSONOGRAFIA ABDOME TOTAL', 10, 'atendido'], [2, 'ULTRASSONOGRAFIA ABDOME TOTAL', 3, 'atendido'], [3, 'RESSONANCIA JOELHO', 5, 'atendido'], [4, 'ULTRASSONOGRAFIA ANTIGA DO PASSADO', 45, 'atendido'],
    [5, 'ULTRASSONOGRAFIA CONTRASTE ADICIONAL', 4, 'atendido'], [6, 'RAIO X SO AGENDADO', 2, 'cancelado']]) {
  await db.query(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, unidade, agendado_para, status) values ($1, $2, $3, 'CSI', now() - make_interval(days => $4::int), $5)`, [cardJ, `jx${n}`, nome, dias, st]);
}

await ligar('nao');

await caso('desligado: lista, disponibilidade e pedido respondem "desligado" e nada é gravado', async () => {
  const a = await chamar('pmarc_catalogo', [null, null]); const b = await chamar('pmarc_disponibilidade', [9101, '{}']); const c = await chamar('pmarc_pedido', ['x', '{}']);
  return { ok: a.motivo === 'desligado' && b.motivo === 'desligado' && c.motivo === 'desligado', detalhe: JSON.stringify({ a, b, c }) };
});
await ligar('sim');

await caso('lista: o que foi atendido nos últimos 30 dias (com ou sem agenda) + consultas com agenda; sem adicionais, sem o antigo, sem o inativo, sem o que só foi agendado', async () => {
  const todos = await chamar('pmarc_catalogo', [null, null]); const cons = await chamar('pmarc_catalogo', [null, 'consulta']);
  const ex = await chamar('pmarc_catalogo', [null, 'exame']); const busca = await chamar('pmarc_catalogo', ['ultrassonografia abdôme', null]); const nada = await chamar('pmarc_catalogo', ['zzzz', null]);
  const ids = (r) => (r.itens || []).map((i) => i.id).sort().join(',');
  const por = Object.fromEntries((todos.itens || []).map((i) => [i.id, i]));
  return { ok: ids(todos) === '9101,9102,9103,9107,9108' && ids(cons) === '9102,9107,9108' && ids(ex) === '9101,9103' && ids(busca) === '9101' && (nada.itens || []).length === 0
      && por[9101].agenda === true && por[9103].agenda === false && todos.itens[0].id === 9101 && por[9107].nome === 'Consulta Cardiologia' && por[9108].nome === 'Consulta Nutricao',
    detalhe: JSON.stringify({ todos: ids(todos), cons: ids(cons), ex: ids(ex), nomes: [por[9107]?.nome, por[9108]?.nome] }) };
});

const todos = (r) => (r.dias || []).flatMap((d) => d.slots.map((s) => ({ data: d.data, ...s })));
await caso('disponibilidade sem escolher nada: mostra os próximos horários previstos, com aviso de que não é reserva', async () => {
  const r = await chamar('pmarc_disponibilidade', [9101, '{}']); const s = todos(r);
  return { ok: r.ok === true && s.length > 0 && r.dias.length <= 10 && r.dias.every((d) => d.slots.length <= 8) && /PREVISÃO/.test(r.aviso) && /reservados/.test(r.aviso) && /planos/.test(r.aviso) && r.procedimento.id === 9101 && r.total >= s.length,
    detalhe: JSON.stringify({ dias: r.dias?.length, slots: s.length, total: r.total, erro: r.erro }) };
});
await caso('turno manhã só traz antes das 12h; tarde entre 12h e 18h; noite 18h ou mais', async () => {
  const m = todos(await chamar('pmarc_disponibilidade', [9101, '{"turno":"manha"}'])), t = todos(await chamar('pmarc_disponibilidade', [9101, '{"turno":"tarde"}'])), n = todos(await chamar('pmarc_disponibilidade', [9101, '{"turno":"noite"}']));
  return { ok: m.length > 0 && m.every((s) => s.hora < '12:00') && t.length > 0 && t.every((s) => s.hora >= '12:00' && s.hora < '18:00') && n.every((s) => s.hora >= '18:00'), detalhe: `${m.length}/${t.length}/${n.length}` };
});
await caso('"a partir das" e "até as" cortam os horários; os dois juntos fazem uma faixa', async () => {
  const a = todos(await chamar('pmarc_disponibilidade', [9101, '{"hora_apos":"14:00"}'])), b = todos(await chamar('pmarc_disponibilidade', [9101, '{"hora_ate":"09:00"}'])), c = todos(await chamar('pmarc_disponibilidade', [9101, '{"hora_apos":"10:00","hora_ate":"11:00"}']));
  return { ok: a.length > 0 && a.every((s) => s.hora >= '14:00') && b.length > 0 && b.every((s) => s.hora <= '09:00') && c.length > 0 && c.every((s) => s.hora >= '10:00' && s.hora <= '11:00'), detalhe: `${a.length}/${b.length}/${c.length}` };
});
await caso('"até o dia" limita as datas; hora e turno fora do padrão viram "sem filtro" em vez de erro', async () => {
  const lim = (await um(`select (current_date + 3)::text d`)).d;
  const r = await chamar('pmarc_disponibilidade', [9101, JSON.stringify({ data_ate: lim })]); const s = todos(r);
  const feio = await chamar('pmarc_disponibilidade', [9101, '{"turno":"madrugada","hora_apos":"25:99","hora_ate":"abc","data_ate":"ontem","unidade":"Marte"}']);
  return { ok: s.length > 0 && s.every((x) => x.data <= lim) && r.ate === lim && feio.ok === true && todos(feio).length > 0, detalhe: JSON.stringify({ n: s.length, ate: r.ate, feio: feio.ok }) };
});
await caso('a ocupação do Klingo tira o horário da previsão (e só aquele)', async () => {
  const antes = todos(await chamar('pmarc_disponibilidade', [9101, '{"hora_apos":"10:00","hora_ate":"10:00"}']));
  if (!antes.length) return { ok: false, detalhe: 'sem horário 10:00 para testar' };
  const alvo = antes[0];
  await db.query(`insert into public.agenda_ocupacao (inicio, profissional, unidade, fonte, reserva_min) values ($1::timestamp, 'DR FULANO', 'CLINICA DE SAUDE E IMAGEM CSI', 'marcada', 30)`, [`${alvo.data} 10:00:00`]);
  const depois = todos(await chamar('pmarc_disponibilidade', [9101, '{"hora_apos":"10:00","hora_ate":"10:00"}']));
  const sumiu = !depois.some((s) => s.data === alvo.data && s.hora === '10:00');
  const resto = antes.slice(1).every((a) => depois.some((d) => d.data === a.data && d.hora === a.hora));
  return { ok: sumiu && resto, detalhe: `antes ${antes.length}, depois ${depois.length}, alvo ${alvo.data}` };
});
await caso('unidade: "CSI" e "Desenvoar" filtram pelo nome longo da grade e devolvem o nome curto; unidade desconhecida = sem filtro', async () => {
  const rc = await chamar('pmarc_disponibilidade', [9101, '{"unidade":"CSI"}']), rt = await chamar('pmarc_disponibilidade', [9101, '{"unidade":"Marte"}']);
  const csi = todos(rc), des = todos(await chamar('pmarc_disponibilidade', [9101, '{"unidade":"DESENVOAR"}'])), tudo = todos(rt);
  return { ok: csi.length > 0 && csi.every((s) => s.unidade === 'CSI') && des.length > 0 && des.every((s) => s.unidade === 'DESENVOAR' && s.hora >= '14:00' && s.hora < '16:00') && tudo.length > 0 && rt.total > rc.total,
    detalhe: `${csi.length}/${des.length}/${tudo.length}` };
});
await caso('exame que não existe ou inativo: "procedimento_invalido"; exame sem grade: lista vazia (não dá erro)', async () => {
  const a = await chamar('pmarc_disponibilidade', [999999, '{}']); const b = await chamar('pmarc_disponibilidade', [9104, '{}']); const c = await chamar('pmarc_disponibilidade', [9103, '{}']);
  return { ok: a.motivo === 'procedimento_invalido' && b.motivo === 'procedimento_invalido' && c.ok === true && c.total === 0 && c.dias.length === 0, detalhe: JSON.stringify({ a: a.motivo, b: b.motivo, c: c.total }) };
});
await caso('limite global: depois de 120 consultas no minuto, responde "muitos" (e volta quando passa)', async () => {
  const n = Number((await um(`select count(*) n from public.pmarc_tentativa where marca = 'global' and tipo = 'disp' and quando > now() - interval '1 minute'`)).n);
  await db.exec(`insert into public.pmarc_tentativa (marca, tipo) select 'global', 'disp' from generate_series(1, ${Math.max(0, 120 - n)})`);
  const r = await chamar('pmarc_disponibilidade', [9101, '{}']);
  await db.exec(`delete from public.pmarc_tentativa where marca = 'global'`);
  const ok2 = await chamar('pmarc_disponibilidade', [9101, '{}']);
  return { ok: r.motivo === 'muitos' && ok2.ok === true, detalhe: JSON.stringify({ r: r.motivo, ok2: ok2.ok }) };
});

// ---- pedido ----
const novo = await chamar('pmarc_novo', ['ANA TESTE', '71988887777', '1990-05-17', null]);
const cod = novo.codigo;
await caso('pedido com exame, turno, "a partir de", "até o dia" e o horário visto: vira mensagem para a equipe com o robô DESLIGADO', async () => {
  const lim = (await um(`select (current_date + 10)::text d`)).d;
  const r = await chamar('pmarc_pedido', [cod, JSON.stringify({ procedimento_id: 9101, turno: 'tarde', hora_apos: '13:30', data_ate: lim, unidade: 'CSI', plano: 'Convênio Inventado', horario: { data: lim, hora: '14:00', unidade: 'CSI', profissional: 'DR FULANO' } })]);
  const conv = await um(`select c.id, c.ia_ativa from public.conversas c join public.pmarc_pessoa p on p.conversa_id = c.id where p.codigo = $1`, [cod]);
  const msgs = await q(`select autor, texto from public.mensagens where conversa_id = $1 order by id`, [conv.id]);
  const cli = msgs.find((m) => m.autor === 'cliente' && /Pedido de previsão/.test(m.texto));
  const fim = msgs.some((m) => m.autor === 'agente' && /previsão/.test(m.texto));
  return { ok: r.ok === true && conv.ia_ativa === false && !!cli && /ULTRASSONOGRAFIA ABDOME TOTAL/.test(cli.texto) && /Turno: tarde/.test(cli.texto) && /A partir das: 13:30/.test(cli.texto) && /previsão, não reservado/.test(cli.texto) && /Plano\/convênio informado: Convênio Inventado/.test(cli.texto) && fim,
    detalhe: JSON.stringify({ ok: r.ok, ia: conv.ia_ativa, texto: cli?.texto }) };
});
await caso('"não escolher": só o exame, sem preferência, também vale e é anotado como "só quer ver a disponibilidade"', async () => {
  const r = await chamar('pmarc_pedido', [cod, JSON.stringify({ procedimento_id: 9102, sem_preferencia: true })]);
  const m = await um(`select texto from public.mensagens where autor = 'cliente' and texto like 'Pedido de previsão: CONSULTA PEDIATRIA%' limit 1`);
  const pedidos = (await um(`select jsonb_array_length(informado -> 'pedidos') n from public.pmarc_pessoa where codigo = $1`, [cod])).n;
  return { ok: r.ok === true && /Sem preferência de horário/.test(m.texto) && pedidos === 2, detalhe: `pedidos ${pedidos}` };
});
await caso('texto livre, sem exame escolhido, e dados fora do padrão: anotados, nunca barrados', async () => {
  const r = await chamar('pmarc_pedido', [cod, JSON.stringify({ procedimento_texto: 'exame de sangue', turno: 'madrugada', hora_apos: '99:99', data_ate: 'amanhã', horario: { data: 'x', hora: 'y' }, observacao: 'prefiro de manhã' })]);
  const m = await um(`select texto from public.mensagens where autor = 'cliente' and texto like 'Pedido de previsão: exame de sangue%' limit 1`);
  return { ok: r.ok === true && /Sem preferência de horário/.test(m.texto) && /prefiro de manhã/.test(m.texto) && !/Turno/.test(m.texto), detalhe: m?.texto };
});
await caso('código inválido não abre nada; e mais de 10 pedidos em 1 hora respondem "muitos"', async () => {
  const ruim = await chamar('pmarc_pedido', ['codigo-que-nao-existe', '{}']);
  let aceitos = 0, estoura = null; for (let i = 0; i < 12 && !estoura; i++) { const x = await chamar('pmarc_pedido', [cod, JSON.stringify({ procedimento_id: 9101 })]); if (x.ok) aceitos++; else estoura = x; }
  const guardados = (await um(`select jsonb_array_length(informado -> 'pedidos') n from public.pmarc_pessoa where codigo = $1`, [cod])).n;
  return { ok: ruim.motivo === 'codigo_invalido' && aceitos === 7 && estoura && estoura.motivo === 'muitos' && guardados === 10, detalhe: JSON.stringify({ ruim: ruim.motivo, aceitos, estoura: estoura && estoura.motivo, guardados }) };
});
await caso('permissões: as 3 funções novas abertas ao anon; a auxiliar só do servidor', async () => {
  const f = await q(`select p.proname, has_function_privilege('anon', p.oid, 'execute') anon from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('pmarc_catalogo','pmarc_disponibilidade','pmarc_pedido','pmarc_tipo_proc') order by 1`);
  const m = Object.fromEntries(f.map((x) => [x.proname, x.anon]));
  return { ok: m.pmarc_catalogo && m.pmarc_disponibilidade && m.pmarc_pedido && m.pmarc_tipo_proc === false, detalhe: JSON.stringify(m) };
});

// ---- unidades: dependem do exame escolhido e respeitam o catálogo ligado/desligado (parte 6) ----
const chaves = (r) => (r.unidades || []).map((u) => u.chave).sort().join(',');
await caso('unidade depende do exame: 9101 tem agenda na CSI e na Desenvoar; 9102 só na CSI; sem exame, todas as ligadas', async () => {
  const a = await chamar('pmarc_unidades', [9101]), b = await chamar('pmarc_unidades', [9102]), c = await chamar('pmarc_unidades', [null]), d = await chamar('pmarc_unidades', [9103]);
  return { ok: chaves(a) === 'CSI,DESENVOAR' && chaves(b) === 'CSI' && chaves(c) === 'CSI,DESENVOAR,RM/TC' && chaves(d) === '' && a.unidades[0].rotulo === 'Desenvoar', detalhe: JSON.stringify({ a: chaves(a), b: chaves(b), c: chaves(c), d: chaves(d) }) };
});
await db.exec(`update public.unidade_config set ativo = false where chave = 'csi'`);
await caso('catálogo CSI desligado: some do seletor; a disponibilidade só traz as unidades ligadas; pedir a CSI à força não devolve horário', async () => {
  const a = await chamar('pmarc_unidades', [9101]), b = await chamar('pmarc_unidades', [9102]), c = await chamar('pmarc_unidades', [null]);
  const sem = todos(await chamar('pmarc_disponibilidade', [9101, '{}'])), csi = await chamar('pmarc_disponibilidade', [9101, '{"unidade":"CSI"}']), des = todos(await chamar('pmarc_disponibilidade', [9101, '{"unidade":"DESENVOAR"}']));
  return { ok: chaves(a) === 'DESENVOAR' && chaves(b) === '' && chaves(c) === 'DESENVOAR,RM/TC' && sem.length > 0 && sem.every((x) => x.unidade === 'DESENVOAR') && csi.ok === true && csi.total === 0 && des.length > 0,
    detalhe: JSON.stringify({ a: chaves(a), b: chaves(b), c: chaves(c), sem: sem.length, csiTotal: csi.total, des: des.length }) };
});
await caso('catálogo CSI desligado: a consulta que só tem agenda na CSI sai da lista; o exame fica, sem "Ver a disponibilidade" na CSI', async () => {
  const l = await chamar('pmarc_catalogo', [null, null]); const m = Object.fromEntries(l.itens.map((i) => [i.id, i.agenda]));
  return { ok: !(9102 in m) && m[9101] === true && m[9103] === false, detalhe: JSON.stringify(m) };
});
await db.exec(`update public.unidade_config set ativo = true where chave = 'csi'`);
await caso('catálogo CSI ligado de novo: tudo volta', async () => {
  const a = await chamar('pmarc_unidades', [9101]), sem = todos(await chamar('pmarc_disponibilidade', [9101, '{}']));
  return { ok: chaves(a) === 'CSI,DESENVOAR' && sem.some((x) => x.unidade === 'CSI'), detalhe: chaves(a) };
});
await caso('permissão: pmarc_unidades aberta ao anon e desligada junto com a Previsão', async () => {
  const f = (await q(`select has_function_privilege('anon', p.oid, 'execute') anon from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'pmarc_unidades'`))[0];
  await ligar('nao'); const off = await chamar('pmarc_unidades', [9101]); await ligar('sim');
  return { ok: f.anon === true && off.motivo === 'desligado', detalhe: JSON.stringify({ anon: f.anon, off: off.motivo }) };
});

const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} casos passaram`);
process.exit(falhasN ? 1 : 0);
