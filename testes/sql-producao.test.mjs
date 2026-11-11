// FLUXOGRAMA: entrada (o retrato da produção em supabase/producao/ montado num Postgres embutido + os arquivos da auditoria de 11/11/2026) -> validação (primeiro reproduz cada defeito com o código REAL da produção; depois aplica a correção e confere que o defeito some e o resto continua igual) -> saída (PASS/FAIL por verificação; código de saída 1 se algo falhar)
// Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial
// As funções de antes da correção ficam em testes/antes-da-auditoria-1111/ (o retrato já traz as corrigidas).
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };
const lerSql = (arq) => readFileSync(`${REPO}/supabase/${arq}`, 'utf8');
// As definições que estavam na produção ANTES da auditoria (o retrato atual já tem as corrigidas): servem para reproduzir cada defeito.
const antes = (nome) => readFileSync(`${REPO}/testes/antes-da-auditoria-1111/${nome}.sql`, 'utf8');

const { db, falhas, indice } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);

await caso('o retrato da produção monta inteiro no banco de teste (mesmas contagens do índice)', async () => {
  const n = await um(`select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public')::int as f,
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r')::int as t`);
  return { ok: falhas.length === 0 && n.f === indice.funcoes.length && n.t === indice.tabelas.length, detalhe: `${n.f} funções, ${n.t} tabelas, ${falhas.length} falhas` };
});

// ---------------------------------------------------------------- dados inventados
const ADMIN = '00000000-0000-4000-8000-0000000000a1', ATEND = '00000000-0000-4000-8000-0000000000a2', PACIENTE = '00000000-0000-4000-8000-0000000000b1';
await db.exec(`
  insert into auth.users (id, email) values ('${ADMIN}', 'admin@exemplo.invalid'), ('${ATEND}', 'atendente@exemplo.invalid'), ('${PACIENTE}', 'paciente@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADMIN}', 'Admin Teste', 'admin@exemplo.invalid', 'admin', true), ('${ATEND}', 'Atendente Teste', 'atendente@exemplo.invalid', 'atendente', true);
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('encerramento_valida_agendado', 'sim'), ('motor', 'fluxo')
    on conflict (chave) do update set valor = excluded.valor;
  insert into public.jornada_coluna (id, nome, ordem, etapa, origem, sla_min) values
    ('contato', 'Contato', 1, 'antes', 'manual', 60), ('orcamento', 'Orçamento', 2, 'antes', 'manual', 120), ('autorizacao', 'Autorização', 3, 'antes', 'manual', null),
    ('agendado', 'Agendado', 4, 'agendamento', 'manual', null), ('a_confirmar', 'A confirmar', 10, 'agendamento', 'klingo', null), ('confirmado', 'Confirmado', 11, 'agendamento', 'klingo', null),
    ('em_atendimento', 'Em atendimento', 12, 'depois', 'klingo', null), ('finalizado', 'Finalizado', 20, 'depois', 'klingo', null), ('concluido', 'Concluído', 21, 'pos', 'manual', null),
    ('faltou', 'Faltou', 30, 'excecao', 'klingo', null), ('cancelado', 'Cancelado', 31, 'excecao', 'klingo', null), ('remarcado', 'Remarcado', 32, 'excecao', 'klingo', null), ('perdido', 'Perdido', 33, 'excecao', 'manual', null);
  insert into public.jornada_sync_estado (id, klingo_em) values (true, now()) on conflict (id) do update set klingo_em = now(), klingo_erro = null;
`);
let seq = 0;
const conversa = async ({ nome = 'Maria Souza Teste', tel = null, status = 'aguardando' } = {}) => {
  seq++;
  const fone = tel || '7198' + String(1000000 + seq);
  const ct = (await um(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, [nome, fone])).id;
  const id = (await um(`insert into public.conversas (contato_id, nome_informado, status, ia_ativa) values ($1, $2, $3, $4) returning id`, [ct, nome, status, status === 'aguardando'])).id;
  await db.query(`insert into public.conversa_segredo (conversa_id) values ($1) on conflict do nothing`, [id]);
  return id;
};
const pedido = async (conv, exames = ['RESSONANCIA DO JOELHO']) => {
  await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, procedimento, status, etapa) values ($1, 'exame', $2, 'rascunho', 'pedido')
                  on conflict (conversa_id) do update set procedimento = excluded.procedimento`, [conv, exames[0]]);
  for (const e of exames) await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento) values ($1, 'RM', 'JOELHO', 'Joelho', 'D', 10, $2)`, [conv, e]);
};
const avisos = async () => (await um(`select count(*)::int n from realtime.messages where event = 'jornada_mudou'`)).n;
const hash = async (tel) => (await um(`select encode(sha256(convert_to(right(regexp_replace($1, '\\D', '', 'g'), 8) || 'segredo-de-teste', 'UTF8')), 'hex') h`, [tel])).h;

// ---------------------------------------------------------------- 1. avalanche de avisos "jornada_mudou"
const convs = [];
for (let i = 0; i < 6; i++) { const c = await conversa({ nome: `Paciente Aviso ${i}` }); await pedido(c); convs.push(c); }

await caso('DEFEITO REPRODUZIDO (código da produção até 11/11): a cópia das conversas avisa 1 vez POR CONVERSA mesmo sem nada mudar', async () => {
  await db.exec(antes('jornada_avisar_exame_ins')); await db.exec(antes('jornada_conversas_sincronizar'));
  await db.query(`select public.jornada_conversas_sincronizar()`);   // primeira vez: cria os cartões
  const a = await avisos();
  await db.query(`select public.jornada_conversas_sincronizar()`);   // segunda vez: nada mudou
  const b = await avisos();
  return { ok: b - a >= convs.length, detalhe: `${b - a} avisos numa rodada sem mudança (${convs.length} conversas)` };
});

await caso('jornada-avisos-enxutos.sql aplica sem erro e pode ser aplicado de novo', async () => {
  await db.exec(lerSql('jornada-avisos-enxutos.sql')); await db.exec(lerSql('jornada-avisos-enxutos.sql'));
  return { ok: true };
});
await caso('CORRIGIDO: rodada sem mudança não manda aviso nenhum', async () => {
  const a = await avisos();
  await db.query(`select public.jornada_conversas_sincronizar()`); await db.query(`select public.jornada_conversas_sincronizar()`);
  const b = await avisos();
  return { ok: b === a, detalhe: `${b - a} avisos em duas rodadas` };
});
await caso('CORRIGIDO: conversa nova com pedido = 1 único aviso (cartão + exame criados)', async () => {
  const c = await conversa({ nome: 'Paciente Novo Aviso' }); await pedido(c, ['TOMOGRAFIA DO CRANIO', 'ULTRASSOM ABDOME']);
  const a = await avisos();
  const r = (await um(`select public.jornada_conversas_sincronizar() r`)).r;
  const b = await avisos();
  const ex = (await um(`select count(*)::int n from public.jornada_exame e join public.jornada_card k on k.id = e.card_id where k.conversa_id = $1`, [c])).n;
  return { ok: b - a === 1 && r.cartoes_criados === 1 && r.exames_alterados === 2 && ex === 2, detalhe: `${b - a} aviso(s) ${JSON.stringify(r)}` };
});
await caso('CORRIGIDO: exame retirado do pedido e pedido que vira agendado avisam (1 aviso por rodada)', async () => {
  await db.query(`update public.pre_agendamento_itens set ativo = false where conversa_id = $1`, [convs[0]]);
  const a = await avisos();
  const r1 = (await um(`select public.jornada_conversas_sincronizar() r`)).r;
  const b = await avisos();
  await db.query(`update public.pre_agendamentos set status = 'agendado' where conversa_id = $1`, [convs[1]]);
  const r2 = (await um(`select public.jornada_conversas_sincronizar() r`)).r;
  const c = await avisos();
  const col = (await um(`select coluna from public.jornada_card where conversa_id = $1`, [convs[1]])).coluna;
  return { ok: b - a === 1 && r1.exames_alterados === 1 && c - b === 1 && r2.cartoes_movidos === 1 && col === 'agendado', detalhe: `${b - a} e ${c - b} aviso(s); coluna=${col}` };
});
await caso('CORRIGIDO: o aviso continua sem dado pessoal e no canal certo', async () => {
  const m = await um(`select topic, event, payload::text p, private from realtime.messages where event = 'jornada_mudou' order by id desc limit 1`);
  return { ok: m.topic === 'fila-chegada' && m.p === '{"evento": "jornada_mudou"}' && m.private === false, detalhe: JSON.stringify(m) };
});
await caso('gatilho: "insert ... on conflict do nothing" que não cria linha NÃO avisa; linha nova de verdade avisa 1 vez', async () => {
  const card = (await um(`select id from public.jornada_card where conversa_id = $1`, [convs[2]])).id;
  const marc = (await um(`select marcacao_id from public.jornada_exame where card_id = $1 limit 1`, [card])).marcacao_id;
  const a = await avisos();
  await db.query(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, status) values ($1, $2, 'X', 'pedido') on conflict (marcacao_id) do nothing`, [card, marc]);
  const b = await avisos();
  await db.query(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, status) values ($1, 'teste:novo', 'Y', 'pedido')`, [card]);
  const c = await avisos();
  return { ok: b === a && c === b + 1, detalhe: `sem linha nova: ${b - a}; com linha nova: ${c - b}` };
});
await caso('gatilho: mudar o status de um exame (equipe ou Klingo) continua avisando; mudar só outro campo, não', async () => {
  const a = await avisos();
  await db.query(`update public.jornada_exame set status = 'agendado' where marcacao_id = 'teste:novo'`);
  const b = await avisos();
  await db.query(`update public.jornada_exame set operadora = 'X' where marcacao_id = 'teste:novo'`);
  const c = await avisos();
  return { ok: b === a + 1 && c === b, detalhe: `status: ${b - a}; outro campo: ${c - b}` };
});
await caso('quem chama com o silêncio já ligado (leitura do Klingo) continua calado e o silêncio é devolvido como estava', async () => {
  const c = await conversa({ nome: 'Paciente Silencio' }); await pedido(c);
  const a = await avisos();
  const r = await um(`with s as (select set_config('jornada.sem_aviso', '1', true) x), f as (select public.jornada_conversas_sincronizar() r from s) select (select r from f) r, current_setting('jornada.sem_aviso', true) depois`);
  const b = await avisos();
  return { ok: b === a && r.r.cartoes_criados === 1, detalhe: `${b - a} avisos; criados=${r.r.cartoes_criados}` };
});
await caso('a rotina de 1 minuto (jornada_vigiar, código da produção) roda inteira sem erro e sem avalanche', async () => {
  const a = await avisos();
  const r = (await um(`select public.jornada_vigiar() r`)).r;
  const r2 = (await um(`select public.jornada_vigiar() r`)).r;
  const b = await avisos();
  const erros = [...(r.erros || []), ...(r2.erros || [])].filter((e) => !/^klingo:/.test(e));   // a chamada HTTP ao Klingo não existe no teste
  return { ok: erros.length === 0 && b - a <= 1 && !!r.chat, detalhe: `${b - a} aviso(s); erros=${JSON.stringify(erros)}` };
});

// ---------------------------------------------------------------- 2. encerrar como Agendado: consulta rápida com o MESMO resultado
await db.exec(antes('agendamento_valido_para_encerrar').replace('FUNCTION public.agendamento_valido_para_encerrar(', 'FUNCTION public.agendamento_valido_antigo('));
await caso('agendado-rapido.sql aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(lerSql('agendado-rapido.sql')); await db.exec(lerSql('agendado-rapido.sql')); return { ok: true }; });

const exameKlingo = async (prontuario, { status = 'agendado', dias = 2, arquivado = false } = {}) => {
  const card = (await um(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna, arquivado_em) values ($1, current_date + $2::int, 'CSI 1', 'a_confirmar', $3) returning id`,
    [prontuario, dias, arquivado ? new Date().toISOString() : null])).id;
  await db.query(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, status, agendado_para) values ($1, $2, 'ULTRASSOM', $3, now() + make_interval(days => $4))`, [card, 'm' + prontuario + ':' + card, status, dias]);
  return card;
};
const pacienteKlingo = async (prontuario, nome, tel) => db.query(`insert into public.jornada_paciente (prontuario, nome, fone_chave) values ($1, $2, $3) on conflict (prontuario) do nothing`, [prontuario, nome, await hash(tel)]);
const iguais = async (conv) => {
  const r = await um(`select public.agendamento_valido_antigo($1) a, public.agendamento_valido_para_encerrar($1) b`, [conv]);
  return { ok: JSON.stringify(r.a) === JSON.stringify(r.b), a: r.a, b: r.b };
};
const cenarios = {};
await caso('cenários: sem nada; prontuário confirmado; nome + telefone; família (mesmo telefone, outro nome); ambíguo; cancelado/passado/arquivado', async () => {
  cenarios.nada = await conversa({ nome: 'Sem Agendamento Teste', tel: '71981110001' });
  cenarios.vinculo = await conversa({ nome: 'Vinculada Teste', tel: '71981110002' });
  await exameKlingo('P-VINC'); await db.query(`insert into public.pessoa_klingo_vinculo (prontuario, conversa_id, por) values ('P-VINC', $1, $2)`, [cenarios.vinculo, ATEND]);
  cenarios.fone = await conversa({ nome: 'Fernanda Lima Teste', tel: '71981110003' });
  await pacienteKlingo('P-FONE', 'FERNANDA LIMA TESTE', '71981110003'); await exameKlingo('P-FONE', { status: 'confirmado' });
  cenarios.familia = await conversa({ nome: 'Joao Pai Teste', tel: '71981110004' });
  await pacienteKlingo('P-FILHO', 'PEDRO FILHO TESTE', '71981110004'); await exameKlingo('P-FILHO');
  cenarios.ambiguo = await conversa({ nome: 'Carla Dupla Teste', tel: '71981110005' });
  await pacienteKlingo('P-DUP1', 'CARLA DUPLA TESTE', '71981110005'); await pacienteKlingo('P-DUP2', 'CARLA DUPLA TESTE', '71981110005'); await exameKlingo('P-DUP1'); await exameKlingo('P-DUP2', { dias: 5 });
  cenarios.velho = await conversa({ nome: 'Exame Velho Teste', tel: '71981110006' });
  await pacienteKlingo('P-VELHO', 'EXAME VELHO TESTE', '71981110006'); await exameKlingo('P-VELHO', { status: 'cancelado' }); await exameKlingo('P-VELHO', { dias: -3 }); await exameKlingo('P-VELHO', { dias: 4, arquivado: true });
  const esperado = { nada: 'AGENDADO_SEM_AGENDAMENTO', vinculo: 'klingo', fone: 'klingo', familia: 'AGENDADO_SEM_AGENDAMENTO', ambiguo: 'AGENDADO_AMBIGUO', velho: 'AGENDADO_SEM_AGENDAMENTO' };
  const ruins = [];
  for (const [k, conv] of Object.entries(cenarios)) {
    const r = await iguais(conv); const veio = r.b.codigo || r.b.fonte;
    if (!r.ok || veio !== esperado[k]) ruins.push(`${k}: antigo=${JSON.stringify(r.a)} novo=${JSON.stringify(r.b)}`);
  }
  return { ok: ruins.length === 0, detalhe: ruins.join(' | ') || '6 cenários com resposta idêntica à da função antiga' };
});
await caso('pessoa com duas conversas unidas: o exame achado por uma vale para a outra (igual à função antiga)', async () => {
  const a = await conversa({ nome: 'Unida Um Teste', tel: '71981110007' }), b = await conversa({ nome: 'Unida Um Teste', tel: '71981110008' });
  const g = (await um(`select gen_random_uuid() g`)).g;
  await db.query(`delete from public.conversa_grupo where conversa_id = any ($1::uuid[])`, [[a, b]]);
  await db.query(`insert into public.conversa_grupo (conversa_id, grupo_id, sinais, origem) values ($1, $3, '{}', 'equipe'), ($2, $3, '{}', 'equipe')`, [a, b, g]);
  await pacienteKlingo('P-UNIDA', 'UNIDA UM TESTE', '71981110008'); await exameKlingo('P-UNIDA');
  const ra = await iguais(a), rb = await iguais(b);
  return { ok: ra.ok && rb.ok && ra.b.fonte === 'klingo' && rb.b.fonte === 'klingo', detalhe: `${JSON.stringify(ra.b)} ${JSON.stringify(rb.b)}` };
});
await caso('leitura do Klingo atrasada ou com erro: mesma resposta da função antiga (agenda indisponível)', async () => {
  await db.query(`update public.jornada_sync_estado set klingo_em = now() - interval '40 minutes'`);
  const r1 = await iguais(cenarios.nada);
  await db.query(`update public.jornada_sync_estado set klingo_em = now(), klingo_erro = 'falha'`);
  const r2 = await iguais(cenarios.nada);
  await db.query(`update public.jornada_sync_estado set klingo_em = now(), klingo_erro = null`);
  return { ok: r1.ok && r2.ok && r1.b.codigo === 'AGENDADO_AGENDA_INDISPONIVEL' && r2.b.codigo === 'AGENDADO_AGENDA_INDISPONIVEL', detalhe: `${r1.b.codigo} ${r2.b.codigo}` };
});
await caso('volume: com 3.000 exames futuros de outros pacientes a consulta nova responde em poucos milissegundos', async () => {
  await db.exec(`
    insert into public.jornada_paciente (prontuario, nome, fone_chave) select 'V' || g, 'PACIENTE VOLUME ' || g, md5(g::text) from generate_series(1, 3000) g;
    with c as (insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna) select 'V' || g, current_date + 3, 'CSI 1', 'a_confirmar' from generate_series(1, 3000) g returning id, paciente_chave)
    insert into public.jornada_exame (card_id, marcacao_id, procedimento, status, agendado_para) select id, 'mv' || id, 'EXAME', 'agendado', now() + interval '3 days' from c;
    analyze public.jornada_paciente; analyze public.jornada_card; analyze public.jornada_exame;`);
  const t0 = performance.now();
  for (const conv of Object.values(cenarios)) await db.query(`select public.agendamento_valido_para_encerrar($1)`, [conv]);
  const novo = performance.now() - t0;
  const t1 = performance.now();
  for (const conv of Object.values(cenarios)) await db.query(`select public.agendamento_valido_antigo($1)`, [conv]);
  const antigo = performance.now() - t1;
  let dif = 0; for (const conv of Object.values(cenarios)) if (!(await iguais(conv)).ok) dif++;
  return { ok: dif === 0 && novo < 400 && novo < antigo, detalhe: `nova ${Math.round(novo)} ms x antiga ${Math.round(antigo)} ms para 6 conversas; respostas diferentes: ${dif}` };
});
await caso('segurança: atendente logada (e paciente logado) NÃO chamam mais a função direto; o gatilho continua funcionando', async () => {
  await como(ATEND);
  let e1 = ''; try { await db.query(`select public.agendamento_valido_para_encerrar($1)`, [cenarios.fone]); } catch (e) { e1 = e.message; }
  await como(PACIENTE);
  let e2 = ''; try { await db.query(`select public.agendamento_valido_para_encerrar($1)`, [cenarios.fone]); } catch (e) { e2 = e.message; }
  await como(ATEND);
  await db.query(`update public.conversas set status = 'em_atendimento', agente_id = $2 where id = $1`, [cenarios.fone, ATEND]);
  await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'agendado' where id = $1`, [cenarios.fone]);
  await como('');
  const k = await um(`select situacao, fonte from public.conversa_agendado_conferencia where conversa_id = $1`, [cenarios.fone]);
  const cv = await um(`select status from public.conversas where id = $1`, [cenarios.fone]);
  return { ok: /permission denied/.test(e1) && /permission denied/.test(e2) && cv.status === 'encerrada' && k && k.situacao === 'confirmado' && k.fonte === 'klingo', detalhe: `${e1.slice(0, 40)} | conferência=${JSON.stringify(k)}` };
});
await caso('a rotina agendado_vigiar (código da produção) usa a função nova sem erro', async () => {
  const c = await conversa({ nome: 'Vigia Teste', tel: '71981110009', status: 'em_atendimento' });
  await como(ATEND);
  await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'agendado' where id = $1`, [c]);
  await como('');
  const antes = await um(`select situacao, tentativas from public.conversa_agendado_conferencia where conversa_id = $1`, [c]);
  const r = (await um(`select public.agendado_vigiar() r`)).r;
  const depois = await um(`select situacao, tentativas from public.conversa_agendado_conferencia where conversa_id = $1`, [c]);
  return { ok: antes.situacao === 'verificando' && !r.erro && depois.tentativas === antes.tentativas + 1, detalhe: JSON.stringify(r) };
});

// ---------------------------------------------------------------- 3. mapa do corpo guardado pronto
await db.exec(`
  insert into public.catalogo_regiao (codigo, nome, padrao, tem_lado, grupo, ordem) values ('joelho', 'Joelho', 'JOELHO', true, 'perna', 1), ('cranio', 'Crânio', 'CRANIO', false, 'cabeca', 2), ('abdome', 'Abdome', 'ABDOME', false, 'tronco', 3);
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values
    (101, 'RESSONANCIA MAGNETICA DO JOELHO (UNILATERAL)', 'RESSONANCIA MAGNETICA', true, 9, ''), (102, 'TOMOGRAFIA DO CRANIO', 'TOMOGRAFIA COMPUTADORIZADA', true, 5, ''),
    (103, 'ULTRASSONOGRAFIA DE ABDOME TOTAL', 'ULTRASSONOGRAFIA', true, 7, ''), (104, 'RESSONANCIA MAGNETICA DO CRANIO', 'RESSONANCIA MAGNETICA', false, 1, '');
  insert into public.catalogo_agenda (procedimento_id, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select p.id, 'CSI', 'SALA 1', 'DRA EXEMPLO', 'RADIOLOGIA', 2, '08:00', '12:00', 20, current_date - 30, current_date + 300 from public.catalogo_procedimento p;
`);
const tokenDe = async (conv) => (await um(`select token from public.conversa_segredo where conversa_id = $1`, [conv])).token;
let corpoAntes = null;
await caso('chat_corpo (código da produção até 11/11, que calculava tudo a cada chamada) responde com os tipos de exame e as partes do corpo do catálogo de teste', async () => {
  await db.exec(antes('chat_corpo').replace('FUNCTION public.chat_corpo(', 'FUNCTION public.chat_corpo_antigo('));
  corpoAntes = (await um(`select public.chat_corpo_antigo($1, $2) r`, [convs[3], await tokenDe(convs[3])])).r;
  const rm = (corpoAntes.modalidades || []).find((m) => m.codigo === 'RM');
  return { ok: !!rm && rm.regioes.includes('joelho') && !rm.regioes.includes('cranio') && corpoAntes.regioes.length === 3, detalhe: JSON.stringify(rm) };
});
await caso('chat-corpo-cache.sql aplica sem erro, pode ser aplicado de novo e já deixa a cópia pronta e a rotina agendada', async () => {
  await db.exec(lerSql('chat-corpo-cache.sql')); await db.exec(lerSql('chat-corpo-cache.sql'));
  const c = await um(`select (select count(*)::int from public.chat_cache where chave = 'corpo') n, (select schedule from cron.job where jobname = 'chat-corpo-cache') quando`);
  return { ok: c.n === 1 && c.quando === '*/10 * * * *', detalhe: JSON.stringify(c) };
});
await caso('CORRIGIDO: a resposta é idêntica à de antes e agora vem da cópia', async () => {
  const tk = await tokenDe(convs[3]);
  const depois = (await um(`select public.chat_corpo($1, $2) r`, [convs[3], tk])).r;
  await db.query(`update public.chat_cache set valor = '{"marca":"veio da copia"}' where chave = 'corpo'`);
  const daCopia = (await um(`select public.chat_corpo($1, $2) r`, [convs[3], tk])).r;
  await db.query(`select public.chat_corpo_atualizar()`);
  return { ok: JSON.stringify(depois) === JSON.stringify(corpoAntes) && daCopia.marca === 'veio da copia', detalhe: '' };
});
await caso('cópia com mais de 1 hora (rotina parada) é ignorada: calcula na hora, como antes', async () => {
  await db.query(`update public.chat_cache set valor = '{"marca":"velha"}', calculado_em = now() - interval '2 hours' where chave = 'corpo'`);
  const r = (await um(`select public.chat_corpo($1, $2) r`, [convs[3], await tokenDe(convs[3])])).r;
  await db.query(`select public.chat_corpo_atualizar()`);
  return { ok: JSON.stringify(r) === JSON.stringify(corpoAntes), detalhe: '' };
});
await caso('catálogo mudou: a rotina refaz a cópia e o chat passa a ver o exame novo', async () => {
  await db.exec(`update public.catalogo_procedimento set ativo = true where id = 104;`);
  await db.query(`select public.chat_corpo_atualizar()`);
  const r = (await um(`select public.chat_corpo($1, $2) r`, [convs[3], await tokenDe(convs[3])])).r;
  return { ok: r.modalidades.find((m) => m.codigo === 'RM').regioes.includes('cranio'), detalhe: '' };
});
await caso('segurança: paciente (anon) chama chat_corpo com o token; token errado é recusado; a tabela da cópia não é lida pela API', async () => {
  const tk = await tokenDe(convs[3]);
  await anonimo();
  const ok1 = !!(await um(`select public.chat_corpo($1, $2) r`, [convs[3], tk])).r.modalidades;
  let e1 = ''; try { await db.query(`select public.chat_corpo($1, 'token-errado')`, [convs[3]]); } catch (e) { e1 = e.code || e.message; }
  let e2 = ''; try { await db.query(`select * from public.chat_cache`); } catch (e) { e2 = e.message; }
  let e3 = ''; try { await db.query(`select public.chat_corpo_atualizar()`); } catch (e) { e3 = e.message; }
  await como('');
  return { ok: ok1 && /28000|não encontrada/.test(e1) && /permission denied/.test(e2) && /permission denied/.test(e3), detalhe: `${e1} | ${e2.slice(0, 40)} | ${e3.slice(0, 40)}` };
});

// ---------------------------------------------------------------- 4. limpeza do histórico de execuções das rotinas
await caso('manutencao-limpeza.sql aplica sem erro, pode ser aplicado de novo e agenda a rotina diária', async () => {
  await db.exec(lerSql('manutencao-limpeza.sql')); await db.exec(lerSql('manutencao-limpeza.sql'));
  const j = await um(`select schedule, command from cron.job where jobname = 'manutencao-limpeza'`);
  return { ok: !!j && j.schedule === '17 7 * * *' && /manutencao_limpar/.test(j.command), detalhe: JSON.stringify(j) };
});
await caso('limpeza: apaga execuções com sucesso de mais de 3 dias, guarda as recentes e guarda as falhas por 14 dias', async () => {
  await db.exec(`
    insert into cron.job_run_details (jobid, status, start_time) select 1, 'succeeded', now() - interval '5 days' from generate_series(1, 50);
    insert into cron.job_run_details (jobid, status, start_time) select 1, 'succeeded', now() - interval '1 day' from generate_series(1, 7);
    insert into cron.job_run_details (jobid, status, start_time) select 1, 'failed', now() - interval '5 days' from generate_series(1, 3);
    insert into cron.job_run_details (jobid, status, start_time) select 1, 'failed', now() - interval '20 days' from generate_series(1, 2);`);
  const r = (await um(`select public.manutencao_limpar() r`)).r;
  const s = await um(`select count(*) filter (where status = 'succeeded')::int ok, count(*) filter (where status = 'failed')::int falha from cron.job_run_details`);
  return { ok: r.execucoes_apagadas === 50 && r.falhas_antigas_apagadas === 2 && s.ok === 7 && s.falha === 3, detalhe: JSON.stringify({ ...r, em: undefined, ...s }) };
});
await caso('limpeza: ninguém pela API (anon, atendente) consegue chamar', async () => {
  await anonimo(); let e1 = ''; try { await db.query(`select public.manutencao_limpar()`); } catch (e) { e1 = e.message; }
  await como(ATEND); let e2 = ''; try { await db.query(`select public.manutencao_limpar()`); } catch (e) { e2 = e.message; }
  await como('');
  return { ok: /permission denied/.test(e1) && /permission denied/.test(e2), detalhe: '' };
});

// ---------------------------------------------------------------- 5. conferências gerais do retrato
await caso('as funções escritas em SQL puro e as 5 visões conferem com as tabelas (nenhuma aponta para coluna que não existe)', async () => {
  const { readdirSync } = await import('node:fs'); const { separarSql } = await import('./banco-producao.mjs');
  await db.exec(`set check_function_bodies = on;`);
  let n = 0; const ruins = [];
  for (const arq of readdirSync(`${REPO}/supabase/producao/funcoes`).sort()) {
    for (const sql of separarSql(readFileSync(`${REPO}/supabase/producao/funcoes/${arq}`, 'utf8'))) {
      if (!/LANGUAGE sql/.test(sql.split('AS $function$')[0]) || /chat_corpo|agendamento_valido|jornada_avisar|jornada_conversas/.test(arq)) continue;
      n++; try { await db.exec(sql); } catch (e) { ruins.push(`${arq}: ${String(e.message).split('\n')[0]}`); }
    }
  }
  for (const v of indice.visoes) { try { await db.query(`select * from public.${v} limit 1`); } catch (e) { ruins.push(`visão ${v}: ${String(e.message).split('\n')[0]}`); } }
  return { ok: ruins.length === 0 && n > 80, detalhe: ruins.join(' | ') || `${n} funções SQL e ${indice.visoes.length} visões` };
});
await caso('seguranca-ajustes.sql aplica duas vezes e não sobra função de gatilho executável sem login', async () => {
  await db.exec(lerSql('seguranca-ajustes.sql')); await db.exec(lerSql('seguranca-ajustes.sql'));
  const r = await um(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prorettype = 'trigger'::regtype and has_function_privilege('anon', p.oid, 'execute')`);
  const p = await conversa({ nome: 'Depois da Seguranca' }); await pedido(p);   // os gatilhos continuam disparando
  return { ok: r.n === 0 && !!p, detalhe: `${r.n} gatilhos abertos` };
});

const passou = resultados.filter(Boolean).length;
console.log(`\n${passou} de ${resultados.length} verificações passaram.`);
process.exit(passou === resultados.length ? 0 : 1);
