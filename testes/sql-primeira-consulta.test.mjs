// FLUXOGRAMA: entrada (clone da produção + supabase/primeira-consulta-parte1..5.sql; conversas de mentira de consulta) -> validação (regra desligada = nada muda; médica fora da lista = marca como hoje)
//   -> lógica (consulta_feita_lote grava só atendidos com prontuário; primeira_consulta_ok bloqueia sem histórico com a médica, libera com histórico ou liberação da atendente)
//   -> saída (fluxo_proximo devolve 'primeira_consulta'; fluxo_perguntar avisa e passa para a atendente sem marcar; klingo_pode_marcar tem a segunda trava) | PASS/FAIL
// Versão 1.0 — 16/11/2026 / Mudança: primeira versão (primeira consulta com a médica só com atendente).
// Dados: todos inventados aqui. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste')`);
registrar('o retrato da produção monta inteiro', falhas.length === 0, `${falhas.length} falhas`);

const partes = [1, 2, 3, 4, 5, 6].map((i) => readFileSync(`${REPO}/supabase/primeira-consulta-parte${i}-${['base', 'regra', 'fluxo-proximo', 'fluxo-perguntar', 'pode-marcar', 'atendimentos'][i - 1]}.sql`, 'utf8'));
await caso('as 6 partes aplicam duas vezes sem erro (idempotente)', async () => { for (const s of [...partes, ...partes]) await db.exec(s); return { ok: true }; });

const MEDICA = 'MÉDICA EXEMPLO', OUTRA = 'OUTRO MEDICO EXEMPLO', UNID = 'DESENVOAR';
await db.exec(`
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo'), ('nome_empresa', 'Clínica de Teste'), ('boas_vindas', 'Olá!') on conflict (chave) do update set valor = excluded.valor;
  insert into public.unidade_config (chave, catalogo, rotulo, descricao, fluxo, instrucao, ordem) values ('desenvoar', '${UNID}', 'Desenvoar', 'x', 'pediatria', 'x', 1) on conflict do nothing;
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values (301, 'CONSULTA NEUROPEDIATRIA', 'CONSULTAS', true, 9, '');
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select 301, 'CONSULTA NEUROPEDIATRIA', '${UNID}', 'CONSULTORIO', p, 'NEUROLOGIA', 2, '08:00', '12:00', 30, current_date - 30, current_date + 300 from unnest(array['${MEDICA}', '${OUTRA}']) p;
`);

let n = 0;
async function nova() {
  n++; await anonimo();
  const r = (await q(`select public.chat_iniciar(p_nome => 'Maria Teste', p_telefone => $1, p_email => 'maria@exemplo.invalid', p_aceite => true, p_paciente_tipo => 'proprio') r`, [`7198${String(5000000 + n)}`]))[0].r;
  await como('');
  const c = r.conversa_id;
  await db.query(`update public.conversas set unidade_inicial = 'desenvoar' where id = $1`, [c]);
  await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, procedimento, etapa, paciente, status) values ($1, 'consulta', 'CONSULTA NEUROPEDIATRIA', 'plano', $2::jsonb, 'rascunho')
    on conflict (conversa_id) do update set tipo = 'consulta', paciente = excluded.paciente`, [c, JSON.stringify({ cpf: '111.444.777-35', dt_nasc: `25/03/${1950 + n}` })]);
  await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, lado, procedimento_id, procedimento, quantidade) values ($1, 'CONSULTA', 'N', 301, 'CONSULTA NEUROPEDIATRIA', 1)`, [c]);
  return c;
}
const ok = async (c) => (await um(`select public.primeira_consulta_ok($1) as v`, [c])).v;
const medico = (c, m) => db.query(`update public.conversas set medico_preferido = $2 where id = $1`, [c, m]);
const vinculo = (c, pront) => db.query(`insert into public.paciente_klingo_vinculo (conversa_id, situacao, prontuario, chave) values ($1, 'confere', $2, 'x') on conflict (conversa_id) do update set situacao = 'confere', prontuario = excluded.prontuario`, [c, pront]);
const lote = (linhas) => um(`select public.consulta_feita_lote($1::jsonb) as v`, [JSON.stringify(linhas)]);

await caso('as chaves nascem com a regra DESLIGADA e a lista da médica preenchida', async () => {
  const r = await q(`select chave, valor from public.config where chave like 'primeira\\_consulta\\_%' order by 1`);
  return { ok: r.length === 2 && r.find((x) => x.chave === 'primeira_consulta_modo').valor === 'nao', detalhe: JSON.stringify(r) };
});
const c1 = await nova(); await medico(c1, MEDICA);
await caso('regra desligada: nunca bloqueia', async () => ({ ok: (await ok(c1)).bloqueia === false && (await ok(c1)).motivo === 'desligado' }));
await db.query(`update public.config set valor = 'sim' where chave = 'primeira_consulta_modo'`);
await db.query(`update public.config set valor = '${MEDICA}' where chave = 'primeira_consulta_medicas'`);
await caso('ligada, sem nenhum atendimento com a médica: bloqueia (atendente)', async () => { const r = await ok(c1); return { ok: r.bloqueia === true, detalhe: JSON.stringify(r) }; });
await vinculo(c1, 'P100');
await caso('vínculo conferido mas sem atendimento com a médica: bloqueia', async () => { const r = await ok(c1); return { ok: r.bloqueia === true && r.motivo === 'sem_historico', detalhe: JSON.stringify(r) }; });
await caso('o lote grava só atendido com prontuário e profissional (n: e vazios ficam de fora)', async () => {
  const r = await lote([
    { m: '1', p: 'P100', q: OUTRA, x: 'CONSULTA', d: '2026-10-01 08:00:00' },
    { m: '2', p: 'n:abc', q: MEDICA, x: 'CONSULTA', d: '2026-10-01' },
    { m: '3', p: 'P100', q: '', x: 'CONSULTA', d: '2026-10-01' },
    { m: '4', p: 'P100', q: MEDICA, x: 'CONSULTA', d: 'lixo' }]);
  return { ok: r.v.gravadas === 1 && (await q('select 1 from public.consulta_feita')).length === 1, detalhe: JSON.stringify(r.v) };
});
await caso('atendido só por OUTRO médico: continua bloqueando', async () => ({ ok: (await ok(c1)).bloqueia === true }));
await lote([{ m: '5', p: 'P100', q: 'Médica Exemplo', x: 'CONSULTA NEUROPEDIATRIA', d: '2026-10-20 09:00:00' }]);
await caso('atendido pela médica (nome com outra grafia/acento): libera para marcar sozinho', async () => { const r = await ok(c1); return { ok: r.bloqueia === false && r.motivo === 'tem_historico', detalhe: JSON.stringify(r) }; });
await caso('reler o mesmo lote não duplica nem muda nada', async () => ({ ok: (await lote([{ m: '5', p: 'P100', q: 'Médica Exemplo', x: 'CONSULTA NEUROPEDIATRIA', d: '2026-10-20 09:00:00' }])).v.gravadas === 0 }));

const c2 = await nova(); await medico(c2, OUTRA); await vinculo(c2, 'P200');
await caso('paciente escolheu outro médico (não listado): marca como hoje', async () => { const r = await ok(c2); return { ok: r.bloqueia === false && r.motivo === 'medica_nao_controlada', detalhe: JSON.stringify(r) }; });
const c3 = await nova(); await vinculo(c3, 'P300');
await caso('"tanto faz" com a médica entre os médicos oferecidos: bloqueia sem histórico', async () => { const r = await ok(c3); return { ok: r.bloqueia === true && r.motivo === 'sem_historico', detalhe: JSON.stringify(r) }; });
await caso('a atendente liberou nesta conversa: segue', async () => {
  await db.query(`select public.fluxo_set($1, '{"primeira_liberada": true}'::jsonb)`, [c3]);
  const r = await ok(c3); return { ok: r.bloqueia === false && r.motivo === 'liberada', detalhe: JSON.stringify(r) };
});
const c4 = await nova(); await medico(c4, MEDICA); await vinculo(c4, 'P400');
await caso('liberação guardada pelo CPF + nascimento vale em outra conversa', async () => {
  const d = (await um(`select public.klingo_dados_conversa($1) as v`, [c4])).v;
  await db.query(`insert into public.primeira_consulta_liberada (chave) values (public.klingo_hash($1))`, [`${d.cpf}|${d.nascimento}`]);
  const r = await ok(c4); return { ok: r.bloqueia === false && r.motivo === 'liberada', detalhe: JSON.stringify(r) };
});
const c5 = await nova(); await medico(c5, MEDICA); await vinculo(c5, 'P500');
await db.query(`update public.pre_agendamentos set tipo = 'exame' where conversa_id = $1`, [c5]);
await caso('exame nunca é bloqueado', async () => ({ ok: (await ok(c5)).bloqueia === false }));

// ---- parte 6: histórico pelo CPF + nascimento (relatório #14637) ----
const lote2 = (linhas) => um(`select public.consulta_atendida_lote($1::jsonb) as v`, [JSON.stringify(linhas)]);
const c7 = await nova(); await medico(c7, MEDICA);
const d7 = (await um(`select public.klingo_dados_conversa($1) as v`, [c7])).v;
await caso('sem nenhum vínculo e sem atendimento: bloqueia', async () => ({ ok: (await ok(c7)).bloqueia === true }));
await caso('o lote do #14637 grava só CPF válido com nascimento, data e profissional; guarda hash, nunca o CPF', async () => {
  const r = await lote2([
    { c: '111.444.777-35', n: d7.nascimento, p: 'P777', q: OUTRA, d: '2026-11-03' },
    { c: '12345678900', n: d7.nascimento, p: '', q: MEDICA, d: '2026-11-03' },
    { c: '11144477735', n: 'lixo', p: '', q: MEDICA, d: '2026-11-03' },
    { c: '11144477735', n: d7.nascimento, p: '', q: '', d: '2026-11-03' }]);
  const guardado = JSON.stringify(await q(`select * from public.consulta_feita where chave is not null`));
  return { ok: r.v.gravadas === 1 && !/11144477735|111\.444/.test(guardado), detalhe: JSON.stringify(r.v) };
});
await caso('atendido só por OUTRO médico (pela chave): continua bloqueando', async () => ({ ok: (await ok(c7)).bloqueia === true }));
await lote2([{ c: '11144477735', n: d7.nascimento, p: '', q: 'Médica Exemplo', d: '2026-11-04' }]);
await caso('atendido pela médica: o chat reconhece pelo CPF + nascimento, sem precisar do vínculo com o Klingo', async () => { const r = await ok(c7); return { ok: r.bloqueia === false && r.motivo === 'tem_historico', detalhe: JSON.stringify(r) }; });
await caso('reler o mesmo atendimento não duplica', async () => ({ ok: (await lote2([{ c: '11144477735', n: d7.nascimento, p: '', q: 'Médica Exemplo', d: '2026-11-04' }])).v.gravadas === 0 }));
await caso('outro paciente (outra data de nascimento) não herda o histórico', async () => {
  const c = await nova(); await medico(c, MEDICA);
  await db.query(`update public.pre_agendamentos set paciente = paciente || '{"dt_nasc": "01/01/2001"}'::jsonb where conversa_id = $1`, [c]);
  return { ok: (await ok(c)).bloqueia === true };
});
await caso('consulta_atendida_disparar existe só para o sistema', async () => {
  const r = await q(`select has_function_privilege('anon', 'public.consulta_atendida_disparar(date,date)', 'execute') a, has_function_privilege('authenticated', 'public.consulta_atendida_lote(jsonb)', 'execute') b`);
  return { ok: r[0].a === false && r[0].b === false };
});

// fluxo: fluxo_proximo e fluxo_perguntar
const c6 = await nova(); await medico(c6, MEDICA); await vinculo(c6, 'P600');
await db.query(`update public.conversa_fluxo set dados = dados || '{"identidade_feita": true, "atalho_feito": true, "motivo": "consulta", "medico_feito": true}'::jsonb where conversa_id = $1`, [c6]);
await caso('fluxo_proximo manda para o passo primeira_consulta', async () => { const r = (await um(`select public.fluxo_proximo($1) as v`, [c6])).v; return { ok: r === 'primeira_consulta', detalhe: r }; });
await caso('fluxo_perguntar avisa o paciente, passa para a atendente e não marca nada', async () => {
  await db.query(`select public.fluxo_perguntar($1, 'primeira_consulta', null)`, [c6]);
  const cv = (await q(`select ia_ativa, triagem_resumo from public.conversas where id = $1`, [c6]))[0];
  const f = (await q(`select passo from public.conversa_fluxo where conversa_id = $1`, [c6]))[0];
  const m = await q(`select texto from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [c6]);
  const pa = (await q(`select status from public.pre_agendamentos where conversa_id = $1`, [c6]))[0];
  return { ok: cv.ia_ativa === false && f.passo === 'humano' && /atendente/.test(m[0]?.texto || '') && /PRIMEIRA CONSULTA/.test(cv.triagem_resumo) && pa.status !== 'agendado', detalhe: `passo=${f.passo}` };
});
await caso('com histórico, fluxo_proximo segue o caminho de sempre (não devolve primeira_consulta)', async () => {
  const c = await nova(); await medico(c, MEDICA); await vinculo(c, 'P100');
  await db.query(`update public.conversa_fluxo set dados = dados || '{"identidade_feita": true, "atalho_feito": true, "motivo": "consulta", "medico_feito": true}'::jsonb where conversa_id = $1`, [c]);
  const r = (await um(`select public.fluxo_proximo($1) as v`, [c])).v; return { ok: r !== 'primeira_consulta', detalhe: r };
});
await caso('klingo_pode_marcar carrega a segunda trava', async () => ({ ok: (await um(`select pg_get_functiondef('public.klingo_pode_marcar'::regproc) like '%primeira_consulta_ok%' as v`)).v }));
await caso('as tabelas novas não são lidas pelo público', async () => {
  await anonimo();
  let negou = 0;
  for (const t of ['consulta_feita', 'primeira_consulta_liberada']) { try { await db.query(`select * from public.${t}`); } catch { negou++; } }
  await como(''); return { ok: negou === 2 };
});
await caso('o botão da atendente existe só para quem está logado', async () => {
  const r = await q(`select has_function_privilege('anon', 'public.painel_primeira_liberar(uuid)', 'execute') a, has_function_privilege('authenticated', 'public.painel_primeira_liberar(uuid)', 'execute') b`);
  return { ok: r[0].a === false && r[0].b === true };
});
const falhou = resultados.filter((x) => !x).length;
console.log(falhou ? `\n${falhou} FALHA(S)` : `\nTodos os ${resultados.length} testes passaram.`);
await db.close?.();
process.exit(falhou ? 1 : 0);
