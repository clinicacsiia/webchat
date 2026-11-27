// FLUXOGRAMA: entrada (clone da produção + supabase/retorno-30-dias-parte1..4.sql; conversas de mentira de consulta; atendimentos inventados em consulta_feita)
//   -> validação (regra desligada, exame, remarcação e especialidade diferente = nada muda; 30 dias ou mais = nada muda)
//   -> lógica (retorno_recente_ok: mesma especialidade pelo cadastro do médico na agenda + atendimento com MENOS de 30 dias, pelo CPF + nascimento ou prontuário)
//   -> saída (fluxo_proximo devolve 'retorno_recente'; fluxo_perguntar avisa que o atendimento tem menos de 30 dias e passa para a atendente sem marcar; klingo_pode_marcar tem a segunda trava) | PASS/FAIL
// Versão 1.0 — 17/11/2026 / Mudança: primeira versão (consulta na mesma especialidade com menos de 30 dias vai para a atendente).
// Versão 1.1 — 27/11/2026 / Mudança: parte 5 (marcação recente do Klingo que não consta como atendida também vai para a atendente; casos reais de 18/11 e 27/11).
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

const nomes = ['regra', 'fluxo-proximo', 'fluxo-perguntar', 'pode-marcar', 'marcacao-recente'];
const partes = nomes.map((n, i) => readFileSync(`${REPO}/supabase/retorno-30-dias-parte${i + 1}-${n}.sql`, 'utf8'));
await caso('as 4 partes aplicam duas vezes sem erro (idempotente)', async () => { for (const s of [...partes, ...partes]) await db.exec(s); return { ok: true }; });

const NEURO1 = 'NEURO UM EXEMPLO', NEURO2 = 'NEURO DOIS EXEMPLO', CARDIO = 'CARDIO EXEMPLO', RADIO = 'RADIOLOGISTA FORA DA AGENDA', UNID = 'DESENVOAR';
await db.exec(`
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo'), ('nome_empresa', 'Clínica de Teste'), ('boas_vindas', 'Olá!') on conflict (chave) do update set valor = excluded.valor;
  insert into public.unidade_config (chave, catalogo, rotulo, descricao, fluxo, instrucao, ordem) values ('desenvoar', '${UNID}', 'Desenvoar', 'x', 'pediatria', 'x', 1) on conflict do nothing;
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values (301, 'CONSULTA NEUROPEDIATRIA', 'CONSULTAS', true, 9, ''), (302, 'CONSULTA CARDIOLOGIA', 'CONSULTAS', true, 9, '');
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select 301, 'CONSULTA NEUROPEDIATRIA', '${UNID}', 'CONSULTORIO', p, 'NEUROLOGIA', 2, '08:00', '12:00', 30, current_date - 30, current_date + 300 from unnest(array['${NEURO1}', '${NEURO2}']) p;
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    values (302, 'CONSULTA CARDIOLOGIA', '${UNID}', 'CONSULTORIO', '${CARDIO}', 'CARDIOLOGIA', 3, '08:00', '12:00', 30, current_date - 30, current_date + 300);
`);

const dia = (atras) => { const d = new Date(Date.now() - 3 * 3600e3 - atras * 86400e3); return d.toISOString().slice(0, 10); };   // hoje de Brasília menos N dias

let n = 0;
async function nova(proc = 301, nome = 'CONSULTA NEUROPEDIATRIA') {
  n++; await anonimo();
  const r = (await q(`select public.chat_iniciar(p_nome => 'Maria Teste', p_telefone => $1, p_email => 'maria@exemplo.invalid', p_aceite => true, p_paciente_tipo => 'proprio') r`, [`7198${String(6000000 + n)}`]))[0].r;
  await como('');
  const c = r.conversa_id;
  await db.query(`update public.conversas set unidade_inicial = 'desenvoar' where id = $1`, [c]);
  await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, procedimento, etapa, paciente, status) values ($1, 'consulta', $3, 'plano', $2::jsonb, 'rascunho')
    on conflict (conversa_id) do update set tipo = 'consulta', paciente = excluded.paciente`, [c, JSON.stringify({ cpf: '111.444.777-35', dt_nasc: `25/03/${1950 + n}` }), nome]);
  await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, lado, procedimento_id, procedimento, quantidade) values ($1, 'CONSULTA', 'N', $2, $3, 1)`, [c, proc, nome]);
  return c;
}
const ok = async (c) => (await um(`select public.retorno_recente_ok($1) as v`, [c])).v;
const medico = (c, m) => db.query(`update public.conversas set medico_preferido = $2 where id = $1`, [c, m]);
const nasc = async (c) => (await um(`select public.klingo_dados_conversa($1) as v`, [c])).v.nascimento;
const atendido = async (c, quem, atras) => um(`select public.consulta_atendida_lote($1::jsonb) as v`, [JSON.stringify([{ c: '11144477735', n: await nasc(c), p: '', q: quem, d: dia(atras) }])]);
const vinculo = (c, pront) => db.query(`insert into public.paciente_klingo_vinculo (conversa_id, situacao, prontuario, chave) values ($1, 'confere', $2, 'x') on conflict (conversa_id) do update set situacao = 'confere', prontuario = excluded.prontuario`, [c, pront]);

await caso('as chaves nascem: regra ligada e limite de 30 dias', async () => {
  const r = await q(`select chave, valor from public.config where chave like 'retorno\\_dias\\_%' order by 1`);
  return { ok: r.length === 2 && r.find((x) => x.chave === 'retorno_dias_modo').valor === 'sim' && r.find((x) => x.chave === 'retorno_dias_limite').valor === '30', detalhe: JSON.stringify(r) };
});

const c1 = await nova(); await medico(c1, NEURO1);
await caso('sem nenhum atendimento: não bloqueia', async () => { const r = await ok(c1); return { ok: r.bloqueia === false && r.motivo === 'sem_atendimento_recente', detalhe: JSON.stringify(r) }; });
await atendido(c1, 'Neuro Dois Exemplo', 10);
await caso('atendido há 10 dias por OUTRO médico da mesma especialidade: bloqueia e diz a especialidade', async () => {
  const r = await ok(c1); return { ok: r.bloqueia === true && r.motivo === 'retorno_recente' && r.especialidade === 'Neurologia' && r.dias_desde === 10, detalhe: JSON.stringify(r) };
});
await caso('o mesmo atendimento vale com "tanto faz" (sem médico escolhido)', async () => {
  const c = await nova(); await atendido(c, NEURO2, 5); const r = await ok(c); return { ok: r.bloqueia === true, detalhe: JSON.stringify(r) };
});
await caso('29 dias atrás ainda é menos de 30: bloqueia', async () => { const c = await nova(); await atendido(c, NEURO1, 29); return { ok: (await ok(c)).bloqueia === true }; });
await caso('30 dias atrás já não é menos de 30: não bloqueia', async () => { const c = await nova(); await atendido(c, NEURO1, 30); return { ok: (await ok(c)).bloqueia === false }; });
await caso('45 dias atrás: não bloqueia', async () => { const c = await nova(); await atendido(c, NEURO1, 45); return { ok: (await ok(c)).bloqueia === false }; });
await caso('atendimento hoje também conta', async () => { const c = await nova(); await atendido(c, NEURO1, 0); return { ok: (await ok(c)).bloqueia === true }; });
await caso('atendido há 5 dias em OUTRA especialidade (cardiologia) e pedindo neurologia: não bloqueia', async () => {
  const c = await nova(); await atendido(c, CARDIO, 5); const r = await ok(c); return { ok: r.bloqueia === false, detalhe: JSON.stringify(r) };
});
await caso('o contrário: pedindo cardiologia, quem foi à neurologia há 5 dias não bloqueia; quem foi à cardiologia, sim', async () => {
  const a = await nova(302, 'CONSULTA CARDIOLOGIA'); await atendido(a, NEURO1, 5);
  const b = await nova(302, 'CONSULTA CARDIOLOGIA'); await atendido(b, CARDIO, 5);
  return { ok: (await ok(a)).bloqueia === false && (await ok(b)).bloqueia === true };
});
await caso('profissional que não está na agenda de consultas (exame) não conta', async () => {
  const c = await nova(); await atendido(c, RADIO, 3); return { ok: (await ok(c)).bloqueia === false };
});
await caso('outro paciente (outra data de nascimento) não herda o atendimento', async () => {
  const c = await nova(); await db.query(`update public.pre_agendamentos set paciente = paciente || '{"dt_nasc": "01/01/2001"}'::jsonb where conversa_id = $1`, [c]);
  return { ok: (await ok(c)).bloqueia === false };
});
await caso('pelo prontuário do vínculo (sem CPF guardado no atendimento) também reconhece', async () => {
  const c = await nova(); await vinculo(c, 'P900');
  await db.query(`insert into public.consulta_feita (marcacao_id, prontuario, profissional, atendido_em) values ('t-900', 'P900', $1, $2)`, [NEURO1, dia(7)]);
  const r = await ok(c); return { ok: r.bloqueia === true && r.dias_desde === 7, detalhe: JSON.stringify(r) };
});
await caso('exame nunca é bloqueado', async () => {
  const c = await nova(); await atendido(c, NEURO1, 3); await db.query(`update public.pre_agendamentos set tipo = 'exame' where conversa_id = $1`, [c]);
  return { ok: (await ok(c)).bloqueia === false };
});
await caso('remarcar uma consulta já marcada não é bloqueado', async () => {
  const c = await nova(); await atendido(c, NEURO1, 3);
  await db.query(`update public.conversa_fluxo set dados = dados || '{"remarcando": {"voucher": "x"}}'::jsonb where conversa_id = $1`, [c]);
  const r = await ok(c); return { ok: r.bloqueia === false && r.motivo === 'remarcando', detalhe: JSON.stringify(r) };
});
await caso('limite configurável: com 15 dias, atendimento de 20 dias não bloqueia e o de 10 sim', async () => {
  await db.query(`update public.config set valor = '15' where chave = 'retorno_dias_limite'`);
  const a = await nova(); await atendido(a, NEURO1, 20); const b = await nova(); await atendido(b, NEURO1, 10);
  const r = [(await ok(a)).bloqueia, (await ok(b)).bloqueia];
  await db.query(`update public.config set valor = '30' where chave = 'retorno_dias_limite'`);
  return { ok: r[0] === false && r[1] === true, detalhe: JSON.stringify(r) };
});
await caso('regra desligada: nunca bloqueia (volta ao jeito de antes na hora)', async () => {
  await db.query(`update public.config set valor = 'nao' where chave = 'retorno_dias_modo'`);
  const r = await ok(c1); await db.query(`update public.config set valor = 'sim' where chave = 'retorno_dias_modo'`);
  return { ok: r.bloqueia === false && r.motivo === 'desligado' };
});

// ---- fluxo ----
const preparar = (c) => db.query(`update public.conversa_fluxo set dados = dados || '{"identidade_feita": true, "atalho_feito": true, "motivo": "consulta", "medico_feito": true}'::jsonb where conversa_id = $1`, [c]);
const c6 = await nova(); await medico(c6, NEURO1); await atendido(c6, NEURO2, 12); await preparar(c6);
await caso('fluxo_proximo manda para o passo retorno_recente', async () => { const r = (await um(`select public.fluxo_proximo($1) as v`, [c6])).v; return { ok: r === 'retorno_recente', detalhe: r }; });
await caso('fluxo_perguntar avisa "menos de 30 dias", passa para a atendente e não marca nada', async () => {
  await db.query(`select public.fluxo_perguntar($1, 'retorno_recente', null)`, [c6]);
  const cv = (await q(`select ia_ativa, triagem_resumo from public.conversas where id = $1`, [c6]))[0];
  const f = (await q(`select passo from public.conversa_fluxo where conversa_id = $1`, [c6]))[0];
  const m = await q(`select texto from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [c6]);
  const pa = (await q(`select status from public.pre_agendamentos where conversa_id = $1`, [c6]))[0];
  const t = m[0]?.texto || '';
  return { ok: cv.ia_ativa === false && f.passo === 'humano' && /menos de 30 dias/.test(t) && /Neurologia/.test(t) && /atendente/.test(t) && /RETORNO EM MENOS DE 30 DIAS/.test(cv.triagem_resumo) && pa.status !== 'agendado', detalhe: t };
});
await caso('o aviso não mostra nome de médico nem data para o paciente', async () => {
  const m = await q(`select texto from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [c6]);
  return { ok: !/EXEMPLO|\d{2}\/\d{2}\/\d{4}/i.test(m[0].texto), detalhe: m[0].texto };
});
await caso('sem atendimento recente, fluxo_proximo segue o caminho de sempre', async () => {
  const c = await nova(); await medico(c, NEURO1); await preparar(c);
  const r = (await um(`select public.fluxo_proximo($1) as v`, [c])).v; return { ok: r !== 'retorno_recente', detalhe: r };
});
await caso('klingo_pode_marcar carrega a segunda trava e recusa com o motivo retorno_recente', async () => {
  const def = (await um(`select pg_get_functiondef('public.klingo_pode_marcar'::regproc) like '%retorno_recente_ok%' as v`)).v;
  return { ok: def };
});
// ---- parte 5: marcação recente do Klingo (vínculo) que não consta como atendida ----
const hist = (c, pront, atras, proc = 'CONSULTA') => db.query(
  `insert into public.paciente_klingo_vinculo (conversa_id, situacao, prontuario, chave, historico) values ($1, 'confere', $2, 'x', $3::jsonb)
   on conflict (conversa_id) do update set situacao = 'confere', prontuario = excluded.prontuario, historico = excluded.historico`,
  [c, pront, JSON.stringify({ total: 3, ultima_data: atras === null ? null : dia(atras), ultimo_procedimento: proc })]);
await caso('P5: última marcação de consulta há 2 dias, sem atendimento feito: bloqueia com motivo marcacao_recente', async () => {
  const c = await nova(); await medico(c, NEURO1); await hist(c, 'P501', 2); const r = await ok(c);
  return { ok: r.bloqueia === true && r.motivo === 'marcacao_recente' && r.dias_desde === 2 && r.especialidade === 'Neurologia' && r.limite === 30, detalhe: JSON.stringify(r) };
});
await caso('P5: 29 dias atrás bloqueia; 30 dias atrás (exatos) não bloqueia', async () => {
  const a = await nova(); await hist(a, 'P502', 29); const b = await nova(); await hist(b, 'P503', 30);
  return { ok: (await ok(a)).bloqueia === true && (await ok(b)).bloqueia === false };
});
await caso('P5: última marcação que não é consulta (exame) não bloqueia', async () => {
  const c = await nova(); await hist(c, 'P504', 2, 'RM JOELHO'); return { ok: (await ok(c)).bloqueia === false };
});
await caso('P5: sem histórico, histórico vazio ou data no futuro não bloqueia', async () => {
  const a = await nova(); await vinculo(a, 'P505'); const b = await nova(); await hist(b, 'P506', null); const c = await nova(); await hist(c, 'P507', -3);
  return { ok: (await ok(a)).bloqueia === false && (await ok(b)).bloqueia === false && (await ok(c)).bloqueia === false };
});
await caso('P5: se aquele dia consta como atendido em OUTRA especialidade (cardiologia), não bloqueia quem pede neurologia', async () => {
  const c = await nova(); await hist(c, 'P508', 4);
  await db.query(`insert into public.consulta_feita (marcacao_id, prontuario, profissional, atendido_em) values ('t-508', 'P508', $1, $2)`, [CARDIO, dia(4)]);
  const r = await ok(c); return { ok: r.bloqueia === false, detalhe: JSON.stringify(r) };
});
await caso('P5: se aquele dia consta como atendido na MESMA especialidade, vale a regra antiga (retorno_recente)', async () => {
  const c = await nova(); await hist(c, 'P509', 4);
  await db.query(`insert into public.consulta_feita (marcacao_id, prontuario, profissional, atendido_em) values ('t-509', 'P509', $1, $2)`, [NEURO2, dia(4)]);
  const r = await ok(c); return { ok: r.bloqueia === true && r.motivo === 'retorno_recente', detalhe: JSON.stringify(r) };
});
await caso('P5: exame, remarcação e regra desligada continuam não bloqueando', async () => {
  const e = await nova(); await hist(e, 'P510', 2); await db.query(`update public.pre_agendamentos set tipo = 'exame' where conversa_id = $1`, [e]);
  const rm = await nova(); await hist(rm, 'P511', 2); await db.query(`update public.conversa_fluxo set dados = dados || '{"remarcando": {"voucher": "x"}}'::jsonb where conversa_id = $1`, [rm]);
  const of = await nova(); await hist(of, 'P512', 2);
  await db.query(`update public.config set valor = 'nao' where chave = 'retorno_dias_modo'`); const rOff = (await ok(of)).bloqueia;
  await db.query(`update public.config set valor = 'sim' where chave = 'retorno_dias_modo'`);
  return { ok: (await ok(e)).bloqueia === false && (await ok(rm)).bloqueia === false && rOff === false };
});
await caso('P5: vínculo que não confere (divergente) não é usado', async () => {
  const c = await nova(); await hist(c, 'P513', 2); await db.query(`update public.paciente_klingo_vinculo set situacao = 'divergente' where conversa_id = $1`, [c]);
  return { ok: (await ok(c)).bloqueia === false };
});
const c7 = await nova(); await medico(c7, NEURO1); await hist(c7, 'P514', 2); await preparar(c7);
await caso('P5: fluxo_proximo manda para o passo retorno_recente', async () => { const r = (await um(`select public.fluxo_proximo($1) as v`, [c7])).v; return { ok: r === 'retorno_recente', detalhe: r }; });
await caso('P5: o aviso fala de consulta MARCADA (não de atendida), passa para a atendente, sem nome de médico nem data, e não marca nada', async () => {
  await db.query(`select public.fluxo_perguntar($1, 'retorno_recente', null)`, [c7]);
  const cv = (await q(`select ia_ativa, triagem_resumo from public.conversas where id = $1`, [c7]))[0];
  const f = (await q(`select passo from public.conversa_fluxo where conversa_id = $1`, [c7]))[0];
  const m = await q(`select texto from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [c7]);
  const pa = (await q(`select status from public.pre_agendamentos where conversa_id = $1`, [c7]))[0];
  const t = m[0]?.texto || '';
  return { ok: cv.ia_ativa === false && f.passo === 'humano' && /consulta marcada/.test(t) && /menos de 30 dias/.test(t) && !/foi atendid/.test(t) && /atendente/.test(t) && !/EXEMPLO|\d{2}\/\d{2}\/\d{4}/i.test(t)
    && /RETORNO EM MENOS DE 30 DIAS/.test(cv.triagem_resumo) && /ainda não consta como atendida/.test(cv.triagem_resumo) && /\d{2}\/\d{2}\/\d{4}/.test(cv.triagem_resumo) && pa.status !== 'agendado', detalhe: t + ' || ' + cv.triagem_resumo };
});
await caso('P5: klingo_pode_marcar recusa com o motivo retorno_recente (segunda trava)', async () => {
  const c = await nova(); await medico(c, NEURO1); await hist(c, 'P515', 2);
  const r = (await um(`select public.klingo_pode_marcar($1) as v`, [c])).v; return { ok: r.ok === false && r.motivo === 'retorno_recente', detalhe: JSON.stringify(r) };
});
await caso('P5: o texto do caso antigo (atendido) continua igual', async () => {
  const c = await nova(); await medico(c, NEURO1); await atendido(c, NEURO2, 9); await preparar(c);
  await db.query(`select public.fluxo_perguntar($1, 'retorno_recente', null)`, [c]);
  const m = await q(`select texto from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [c]);
  return { ok: /foi atendido\(a\) em consulta de Neurologia/.test(m[0].texto), detalhe: m[0].texto };
});
await caso('as funções novas só existem para o sistema', async () => {
  const r = await q(`select has_function_privilege('anon', 'public.retorno_recente_ok(uuid)', 'execute') a, has_function_privilege('authenticated', 'public.retorno_recente_ok(uuid)', 'execute') b, has_function_privilege('anon', 'public.fluxo_retorno_equipe(uuid)', 'execute') c, has_function_privilege('service_role', 'public.retorno_recente_ok(uuid)', 'execute') d`);
  return { ok: !r[0].a && !r[0].b && !r[0].c && r[0].d };
});
const falhou = resultados.filter((x) => !x).length;
console.log(falhou ? `\n${falhou} FALHA(S)` : `\nTodos os ${resultados.length} testes passaram.`);
await db.close?.();
process.exit(falhou ? 1 : 0);
