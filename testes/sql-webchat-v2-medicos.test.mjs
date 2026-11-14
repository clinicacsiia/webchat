// FLUXOGRAMA: entrada (clone da produção + partes 1, 2 e 4; GRADE inventada com horários em todos os dias; ofertas da API inventadas; médicos e exames da conversa fixados no clone)
//   -> processamento (medicos_disponiveis_interno em cada estado da API) -> persistência (só no clone) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Prova que o "próximo horário de cada médico" vem SÓ das ofertas da API e que a grade não é fonte (item 4.1 da continuação).
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo, como } = ajudantes(db);
let sqlErro = null;
for (const f of ['webchat-v2-parte1-modos', 'webchat-v2-parte2-calendario-api', 'webchat-v2-parte4-medicos-api']) {
  try { await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8')); } catch (e) { sqlErro = `${f}: ${String(e.message).split('\n')[0]}`; }
}
registrar('o retrato monta e as partes 1, 2 e 4 aplicam sem erro', falhas.length === 0 && !sqlErro, sqlErro ?? '');

const dia = (n) => new Date(Date.now() + n * 864e5).toLocaleString('sv-SE', { timeZone: 'America/Bahia' }).slice(0, 10);
const cfg = (k, v) => db.query(`insert into public.config (chave, valor) values ($1,$2) on conflict (chave) do update set valor = excluded.valor`, [k, v]);
const TESTE = '71900000001';
await db.exec(`insert into public.config (chave, valor) values ('ia_segredo','x'),('motor','fluxo'),('nome_empresa','Clínica de Teste'),('boas_vindas','Olá!') on conflict (chave) do update set valor = excluded.valor;`);
await cfg('klingo_auto', 'sim'); await cfg('klingo_api_horarios', 'teste'); await cfg('klingo_api_telefones_teste', TESTE); await cfg('klingo_api_percentual', '100');
// Exame e médicos da conversa fixados (o foco aqui é a fonte do horário, não o catálogo)
await db.exec(`
  create or replace function public.fluxo_medicos(p_conversa uuid) returns text[] language sql stable as $$ select array['DRA ANA LIMA SOUZA','DR BRUNO COSTA REIS','DRA CARLA DIAS MOTA'] $$;
  create or replace function public.fluxo_procs(p_conversa uuid) returns int[] language sql stable as $$ select array[301] $$;
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values (301, 'CONSULTA', 'CONSULTAS', true, 20, '') on conflict do nothing;
  -- A GRADE tem horário todos os dias (08:00-12:00): se ela vazar para o próximo horário do médico, o teste vê.
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select 301, 'CONSULTA', 'CSI', 'CONSULTORIO 1', 'DRA ANA LIMA SOUZA', 'CARDIOLOGIA', d, '08:00', '12:00', 30, current_date - 30, current_date + 300 from generate_series(0, 6) d;
`);
let nTel = 0; const telefones = [TESTE];
const nova = async (tel = '7198' + String(5000000 + ++nTel)) => { telefones.push(tel); await cfg('klingo_api_telefones_teste', telefones.join(',')); await anonimo(); const r = (await q(`select public.chat_iniciar(p_nome => $1, p_telefone => $2, p_email => $3, p_aceite => true, p_paciente_tipo => 'proprio') r`, ['Maria Teste da Silva', tel, 'm@exemplo.invalid']))[0].r; await como(''); return r.conversa_id; };
const ofertar = async (c, itens, sombra = false) => {
  const l = itens.map(([d, h, prof]) => ({ chave: `${d}|63|308|2|${h}|${prof}`, data: d, hora: h, profissional: prof, unidade: 'CSI' }));
  await db.query(`select public.klingo_oferta_gravar_v2($1, 301, 1, $2::jsonb, $3, true)`, [c, JSON.stringify(l), sombra]);
};
const consulta = (c, resultado, modo = 'teste') => db.query(`select public.klingo_consulta_registrar($1, $2, 'consulta', 301, 1, $3, 200, 5, 5, 0, 2, 900, null)`, [c, modo, resultado]);
const medicos = async (c) => (await q(`select public.medicos_disponiveis_interno($1) r`, [c]))[0].r;

const grade = await um(`select count(*)::int n from public.agenda_horarios(array[301], current_date, current_date + 20, null, null, null, '[]'::jsonb)`);

await caso('com ofertas da API: cada médico mostra o PRÓXIMO horário da API dele (não o da grade); quem não tem oferta fica com proximo=null', async () => {
  const c = await nova();
  await ofertar(c, [[dia(6), '14:00', 'DRA ANA LIMA SOUZA'], [dia(4), '09:30', 'DRA ANA LIMA SOUZA'], [dia(9), '08:00', 'DR BRUNO COSTA REIS']]);
  await consulta(c, 'ok_com_horarios');
  const r = await medicos(c), por = Object.fromEntries(r.map((x) => [x.nome, x]));
  return { ok: r.length === 3 && por['DRA ANA LIMA SOUZA'].proximo === `${dia(4)} 09:30` && por['DRA ANA LIMA SOUZA'].livres === 2 && por['DR BRUNO COSTA REIS'].proximo === `${dia(9)} 08:00` && por['DRA CARLA DIAS MOTA'].proximo === null && r.every((x) => x.fonte === 'api_klingo'),
           detalhe: `grade teria ${grade.n} dias; ana=${por['DRA ANA LIMA SOUZA']?.proximo}` };
});

await caso('a grade NUNCA vira próximo horário: com a API sem horários, todos ficam sem proximo (mesmo a grade tendo horário todo dia)', async () => {
  const c = await nova(); await consulta(c, 'api_sem_horarios');
  const r = await medicos(c);
  return { ok: r.length === 3 && r.every((x) => x.proximo === null && x.livres === 0), detalhe: `grade=${grade.n}` };
});

await caso('API fora do ar / limite / estrutura inválida: a lista volta VAZIA (a tela não escreve "sem horário" sem saber)', async () => {
  const res = [];
  for (const r of ['erro_api', 'limite', 'estrutura_invalida', 'erro_gravacao']) { const c = await nova(); await ofertar(c, [[dia(2), '08:00', 'DRA ANA LIMA SOUZA']]); await consulta(c, r); res.push((await medicos(c)).length); }
  return { ok: res.every((x) => x === 0), detalhe: res.join(',') };
});

await caso('sem consulta nenhuma à API: lista vazia (nada estimado)', async () => {
  const c = await nova(); return { ok: (await medicos(c)).length === 0 };
});

await caso('modo sombra / API desligada para essa conversa: lista vazia e ofertas medidas (sombra) não aparecem', async () => {
  const c = await nova(); await ofertar(c, [[dia(2), '08:00', 'DRA ANA LIMA SOUZA']], true); await consulta(c, 'ok_com_horarios', 'sombra');
  const sombra = (await medicos(c)).length;
  await cfg('klingo_api_horarios', 'nao'); const c2 = await nova(); await ofertar(c2, [[dia(2), '08:00', 'DRA ANA LIMA SOUZA']]); await consulta(c2, 'ok_com_horarios');
  const desl = (await medicos(c2)).length; await cfg('klingo_api_horarios', 'teste');
  return { ok: sombra === 0 && desl === 0, detalhe: `sombra=${sombra} desligada=${desl}` };
});

await caso('oferta vencida ou no passado não conta como próximo horário', async () => {
  const c = await nova();
  await ofertar(c, [[dia(3), '08:00', 'DRA ANA LIMA SOUZA']]); await consulta(c, 'ok_com_horarios');
  await db.query(`update public.klingo_oferta set expira_em = now() - interval '1 minute' where conversa_id = $1`, [c]);
  const r = await medicos(c);
  return { ok: r.every((x) => x.proximo === null) };
});

await caso('a consulta do motor de vagas (modo monitor) não vira "estado" do paciente', async () => {
  const c = await nova(); await ofertar(c, [[dia(3), '08:00', 'DRA ANA LIMA SOUZA']]); await consulta(c, 'ok_com_horarios', 'monitor');
  return { ok: (await medicos(c)).length === 0 };
});

// ---------------------------------------------------------------------------------------------- I13: oferta antiga da grade
const aceitar = async (c, slot, valor = 'sim') => {
  await db.query(`insert into public.pre_agendamentos (conversa_id, status, etapa) values ($1, 'rascunho', 'data_hora') on conflict (conversa_id) do nothing`, [c]);
  await db.query(`select public.fluxo_set($1, $2::jsonb)`, [c, JSON.stringify({ oferta_pendente: { n: 1, slots: [slot], texto: 'x', origem: 'pedido' } })]);
  const r = (await q(`select public.fluxo_aplicar($1, 'horario_oferta', $2::jsonb) r`, [c, JSON.stringify(valor)]))[0].r;
  const pa = await um(`select escolha_horario from public.pre_agendamentos where conversa_id = $1`, [c]);
  return { r, escolha: pa.escolha_horario };
};
await caso('I13: oferta antiga da GRADE aceita pelo paciente NÃO vira escolha se a API não tem aquele horário (mesmo a grade tendo)', async () => {
  const c = await nova(); await consulta(c, 'api_sem_horarios');
  const x = await aceitar(c, { data: dia(3), hora: '08:00', unidade: 'CSI', profissional: 'DRA ANA LIMA SOUZA', min: 30 });
  return { ok: x.escolha == null && x.r.aviso !== 'Combinado! Troquei o horário do seu pedido.', detalhe: JSON.stringify(x.r).slice(0, 120) };
});
await caso('I13: se a API ainda oferece aquele horário, a escolha é gravada COM a chave da oferta (o pipeline de marcação a exige)', async () => {
  const c = await nova(); await ofertar(c, [[dia(3), '08:00', 'DRA ANA LIMA SOUZA']]); await consulta(c, 'ok_com_horarios');
  const x = await aceitar(c, { data: dia(3), hora: '08:00', unidade: 'CSI', profissional: 'DRA ANA LIMA SOUZA', min: 30 });
  const e = x.escolha?.[0];
  return { ok: e && e.origem === 'klingo_api' && !!e.klingo_chave && x.r.ok === true, detalhe: JSON.stringify(x.escolha).slice(0, 160) };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
