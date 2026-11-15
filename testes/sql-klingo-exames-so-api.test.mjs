// FLUXOGRAMA: entrada (o retrato da produção + supabase/klingo-exames-so-api.sql num Postgres embutido; exames, lista da API e resultado da varredura inventados) -> validação (klingo_exame_oferecido, klingo_exames_sondar, klingo_exames_cobertura e o chat: chat_exames_buscar e chat_exames)
//   -> lógica (interruptor desligado mostra tudo; ligado só mostra o que a API lista e confirmou com horário; "sem horário" some e VOLTA quando a varredura achar horário; varredura parada não esconde para sempre; lista da API vazia não esconde tudo; fila da varredura: novos primeiro, depois o mais antigo, no ritmo configurado)
//   -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (caso da RM ENDOVAGINAL sem horário aparecendo para a paciente). Dados inventados.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo, como } = ajudantes(db);
registrar('o retrato da produção monta inteiro', falhas.length === 0);
await db.exec(readFileSync(`${REPO}/supabase/klingo-exames-so-api.sql`, 'utf8'));

const UNIDADE = 'CLÍNICA DE SAÚDE E IMAGEM - CSI';
await db.exec(`
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo'), ('nome_empresa', 'Clínica de Teste'), ('boas_vindas', 'Olá!')
    on conflict (chave) do update set valor = excluded.valor;
  insert into public.config (chave, valor) values ('klingo_so_liberados', 'sim') on conflict (chave) do update set valor = 'sim';
  insert into public.catalogo_regiao (codigo, nome, padrao, tem_lado, grupo, ordem) values ('joelho', 'Joelho', 'JOELHO', true, 'perna', 1);
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values
    (201, 'RESSONANCIA MAGNETICA DO JOELHO (UNILATERAL)', 'RESSONANCIA MAGNETICA', true, 9, ''),
    (202, 'RM ENDOVAGINAL JOELHO', 'RESSONANCIA MAGNETICA', true, 1, ''),
    (203, 'ULTRASSONOGRAFIA DO JOELHO', 'ULTRASSONOGRAFIA', true, 7, ''),
    (204, 'RAIO X DO JOELHO', 'RAIO X', true, 3, ''),
    (205, 'TOMOGRAFIA DO JOELHO', 'TOMOGRAFIA', true, 2, '');
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select p.id, p.nome, '${UNIDADE}', 'SALA 1', 'DRA EXEMPLO IMAGEM', 'RADIOLOGIA', 6, '08:00', '12:00', 30, current_date - 30, current_date + 300 from public.catalogo_procedimento p;
  refresh materialized view public.fluxo_exames;
`);
const ofer = async (id) => (await um(`select public.klingo_exame_oferecido($1) r`, [id])).r;
const cfg = (k, v) => db.query(`update public.config set valor = $2 where chave = $1`, [k, v]);
const api = (ids) => db.exec(`delete from public.klingo_exame_api; ${ids.length ? `insert into public.klingo_exame_api (id, descr) values ${ids.map((i) => `(${i}, 'exame ${i}')`).join(',')};` : ''}`);
const vis = (id, tem, minAtras) => db.query(`insert into public.klingo_proc_api (procedimento_id, com_horario_em, vazio_em) values ($1, ${tem ? `now() - make_interval(mins => $2)` : 'null'}, ${tem ? 'null' : `now() - make_interval(mins => $2)`})
  on conflict (procedimento_id) do update set com_horario_em = excluded.com_horario_em, vazio_em = excluded.vazio_em`, [id, minAtras]);

const nomesBusca = async () => {
  await anonimo();
  const r = (await um(`select public.chat_iniciar(p_nome => 'Maria Teste da Silva', p_telefone => '71985000001', p_email => 'maria@exemplo.invalid', p_aceite => true, p_paciente_tipo => 'proprio') r`)).r;
  const lista = (await um(`select public.chat_exames_buscar($1::uuid, $2, 'JOELHO', false) r`, [r.conversa_id, r.token])).r;
  const ids = lista.flatMap((x) => (x.exames || x.itens || [x])).map((x) => x.id).filter(Boolean);
  const modal = (await um(`select public.chat_exames($1::uuid, $2, 'RM', 'joelho') r`, [r.conversa_id, r.token])).r;
  await como('');
  return { buscar: ids.sort(), rm: (modal || []).map((x) => x.id).sort() };
};

await caso('interruptor desligado (padrão): todos os exames aparecem, como hoje', async () => {
  await cfg('klingo_exames_so_api', 'nao'); await api([201]);
  const r = await Promise.all([201, 202, 203].map(ofer));
  return { ok: r.every(Boolean), detalhe: JSON.stringify(r) };
});

await cfg('klingo_exames_so_api', 'sim');
await api([201, 202, 203, 204]);   // 205 não existe na API
await vis(201, true, 30); await vis(202, false, 20); await vis(203, true, 200); /* 204 nunca conferido */
await caso('ligado: exame com horário confirmado aparece', async () => ({ ok: (await ofer(201)) === true }));
await caso('ligado: exame que a API confirmou SEM horário (a RM ENDOVAGINAL) some', async () => ({ ok: (await ofer(202)) === false }));
await caso('ligado: exame que a API não lista some (205), mesmo sem checagem', async () => ({ ok: (await ofer(205)) === false }));
await caso('ligado: exame novo que a API lista mas ainda não foi conferido não aparece até a varredura confirmar', async () => ({ ok: (await ofer(204)) === false }));
await caso('conferência antiga (200 min) com horário continua aparecendo: não depende de a varredura estar em dia', async () => ({ ok: (await ofer(203)) === true }));

await caso('o chat (busca por texto e lista por modalidade) esconde o exame sem horário e o que a API não lista', async () => {
  const r = await nomesBusca();
  return { ok: r.buscar.includes(201) && r.buscar.includes(203) && !r.buscar.includes(202) && !r.buscar.includes(204) && !r.buscar.includes(205) && r.rm.includes(201) && !r.rm.includes(202), detalhe: JSON.stringify(r) };
});

await caso('volta sozinho: a varredura acha horário no exame que estava sem (alguém abriu agenda no Klingo) e ele reaparece no chat', async () => {
  await db.query(`select public.klingo_sondagem_registrar(202, true, current_date + 3)`);
  const r = await nomesBusca();
  const l = await um(`select primeiro_dia is not null as p, vazio_em is not null as v from public.klingo_proc_api where procedimento_id = 202`);
  return { ok: (await ofer(202)) === true && r.buscar.includes(202) && r.rm.includes(202) && l.p && l.v, detalhe: JSON.stringify(r) };
});
await caso('e some de novo quando o horário acaba (a varredura não acha mais)', async () => {
  await db.query(`select public.klingo_sondagem_registrar(202, false, null)`);
  const r = await nomesBusca();
  return { ok: (await ofer(202)) === false && !r.buscar.includes(202) };
});
await caso('o gravar antigo (2 parâmetros) continua funcionando e vale o mesmo', async () => {
  await db.query(`select public.klingo_sondagem_gravar(204, true)`);
  return { ok: (await ofer(204)) === true };
});

await caso('varredura parada: "sem horário" com mais de 6 h volta a aparecer (melhor mostrar do que perder o exame para sempre)', async () => {
  await vis(202, false, 7 * 60);
  const velho = await ofer(202);
  await vis(202, false, 30);
  return { ok: velho === true && (await ofer(202)) === false };
});
await caso('lista da API vazia (falha de sincronização): nada é escondido', async () => {
  await api([]);
  const r = await Promise.all([201, 202, 205].map(ofer));
  await api([201, 202, 203, 204]);
  return { ok: r.every(Boolean), detalhe: JSON.stringify(r) };
});

// ---------------------------------------------------------------- fila da varredura
await db.exec(`delete from public.klingo_proc_api`);
await api([201, 202, 203, 204]);
await caso('fila: só exames do chat que a API lista (205 está no chat mas fora da API: não gasta cota)', async () => {
  const ids = (await q(`select * from public.klingo_exames_sondar(40)`)).map((r) => r.klingo_exames_sondar);
  return { ok: ids.length === 4 && !ids.includes(205), detalhe: ids.join() };
});
await caso('fila: o nunca conferido vai primeiro (por demanda); depois o conferido há mais tempo; quem foi conferido há pouco espera', async () => {
  await vis(203, true, 300); await vis(204, true, 150); await vis(201, true, 10);   // 202 nunca conferido
  const ids = (await q(`select * from public.klingo_exames_sondar(40)`)).map((r) => r.klingo_exames_sondar);
  return { ok: ids.join() === '202,203,204', detalhe: ids.join() };
});
await caso('fila: "sem horário" é perguntado de novo em 60 min (volta logo), "com horário" só depois de 120 min', async () => {
  await vis(203, false, 70); await vis(204, true, 70); await vis(202, false, 50);
  const ids = (await q(`select * from public.klingo_exames_sondar(40)`)).map((r) => r.klingo_exames_sondar);
  return { ok: ids.join() === '203', detalhe: ids.join() };
});
await caso('fila: os intervalos vêm da configuração', async () => {
  await cfg('klingo_exames_vazio_min', '30');
  const ids = (await q(`select * from public.klingo_exames_sondar(40)`)).map((r) => r.klingo_exames_sondar).sort();
  await cfg('klingo_exames_vazio_min', '60');
  return { ok: ids.join() === '202,203', detalhe: ids.join() };
});
await caso('fila: o limite por rodada é respeitado (no máximo 40)', async () => (await db.exec(`delete from public.klingo_proc_api`), { ok: (await q(`select * from public.klingo_exames_sondar(2)`)).length === 2 && (await q(`select * from public.klingo_exames_sondar(500)`)).length <= 40 }));

await caso('cobertura: conta o que falta conferir antes de ligar o interruptor', async () => {
  await api([201, 202, 203, 204, 205]);
  await db.exec(`delete from public.klingo_proc_api`); await vis(201, true, 10); await vis(202, false, 10);
  const c = (await um(`select public.klingo_exames_cobertura() r`)).r;
  return { ok: c.exames_no_chat === 5 && c.na_api === 5 && c.conferidos === 2 && c.com_horario === 1 && c.sem_horario === 1 && c.faltam_conferir === 3 && c.fora_da_api === 0, detalhe: JSON.stringify(c) };
});

await caso('permissões: quem não é o sistema não executa nenhuma função nova', async () => {
  await anonimo();
  let negou = 0;
  for (const f of ['klingo_exame_oferecido(201)', 'klingo_exames_cobertura()', 'klingo_sondagem_registrar(201, true, null)']) {
    try { await db.query(`select public.${f}`); } catch { negou++; }
  }
  await como('');
  return { ok: negou === 3, detalhe: `${negou} de 3 recusadas` };
});


// ---------------------------------------------------------------- parte 6: a equipe é avisada sozinha
await caso('sem horário na API: a conversa ganha a etiqueta "Sem horário no Klingo"; quando aparece horário a etiqueta sai', async () => {
  await anonimo();
  const r = (await um(`select public.chat_iniciar(p_nome => 'Joana Teste da Silva', p_telefone => '71985000002', p_email => 'joana@exemplo.invalid', p_aceite => true, p_paciente_tipo => 'proprio') r`)).r;
  await como('');
  const alerta = async () => (await um(`select alerta_agenda a from public.conversas where id = $1::uuid`, [r.conversa_id])).a;
  await db.query(`select public.klingo_horarios_motivo($1::uuid, 'api_sem_horario', 'api_sem_horarios')`, [r.conversa_id]);
  const com = await alerta();
  await db.query(`select public.klingo_horarios_motivo($1::uuid, null, null)`, [r.conversa_id]);
  return { ok: com === 'Sem horário no Klingo' && (await alerta()) === null, detalhe: String(com) };
});
await caso('a etiqueta não atropela outro alerta da conferência nem é apagada por quem não a pôs; falha de consulta não vira etiqueta', async () => {
  await anonimo();
  const r = (await um(`select public.chat_iniciar(p_nome => 'Rita Teste da Silva', p_telefone => '71985000003', p_email => 'rita@exemplo.invalid', p_aceite => true, p_paciente_tipo => 'proprio') r`)).r;
  await como('');
  const alerta = async () => (await um(`select alerta_agenda a from public.conversas where id = $1::uuid`, [r.conversa_id])).a;
  await db.query(`update public.conversas set alerta_agenda = 'Conferência: horário mudou' where id = $1::uuid`, [r.conversa_id]);
  await db.query(`select public.klingo_horarios_motivo($1::uuid, 'api_sem_horario', null)`, [r.conversa_id]);
  const a1 = await alerta();
  await db.query(`select public.klingo_horarios_motivo($1::uuid, null, null)`, [r.conversa_id]);
  const a2 = await alerta();
  await db.query(`update public.conversas set alerta_agenda = null where id = $1::uuid`, [r.conversa_id]);
  await db.query(`select public.klingo_horarios_motivo($1::uuid, 'erro_api', 'timeout')`, [r.conversa_id]);
  return { ok: a1 === 'Conferência: horário mudou' && a2 === 'Conferência: horário mudou' && (await alerta()) === null, detalhe: `${a1} | ${a2}` };
});

const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
