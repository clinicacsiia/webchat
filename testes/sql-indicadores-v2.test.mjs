// FLUXOGRAMA: entrada (supabase/indicadores-v2.sql com conversas inventadas num Postgres embutido) -> validação (virada de dia, fuso de Brasília, teste fora, unidade, período livre) -> lógica (pessoas únicas por dia, reentradas, sem atendimento humano, concluídas pela data real, congelamento que não deixa o dia fechado mudar) -> saída (PASS/FAIL por caso)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (Etapa A3)
import { readFileSync } from 'node:fs';
import { criarBanco, funcao, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
const ADMIN = '11111111-1111-1111-1111-111111111111', ATEND = '22222222-2222-2222-2222-222222222222';
const arq = (n, f) => funcao(n, f);
await db.exec(`
  do $$ begin if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if; end $$;
  create schema cron;
  create table cron.job (jobid serial primary key, jobname text, schedule text, command text);
  create function cron.schedule(n text, s text, c text) returns bigint language plpgsql as $$ begin insert into cron.job (jobname, schedule, command) values (n, s, c); return 1; end $$;
  create table public.contatos (id uuid primary key default gen_random_uuid(), nome text, telefone text);
  alter table public.conversas add column contato_id uuid, add column status text not null default 'aguardando', add column criado_em timestamptz not null default now(),
    add column primeiro_humano_em timestamptz, add column teste boolean not null default false, add column unidade_inicial text;
  create table public.conversa_grupo (conversa_id uuid primary key, grupo_id uuid);
  create table public.v_agendamento_aberto (conversa_id uuid, unidade text);
  create table public.jornada_card (id bigint generated always as identity primary key, conversa_id uuid, arquivado_em timestamptz, unidade text, paciente_chave text);
  create table public.jornada_exame (id bigint generated always as identity primary key, card_id bigint, marcacao_id text, status text, agendado_em timestamptz);
  create table public.jornada_paciente (prontuario text primary key, nome text, fone_chave text);
  create table public.pre_agendamentos (conversa_id uuid, klingo_marcacoes text[]);
  create table public.conversa_encerramento (id bigint generated always as identity primary key, conversa_id uuid, encerrada_em timestamptz, motivo text, origem text, por uuid);
  create table public.avaliacao_atendimento (id bigint generated always as identity primary key, conversa_id uuid, nota_atendimento integer, nota_site integer, canal text, criado_em timestamptz not null default now());
  create table public.conversa_evento (id bigint generated always as identity primary key, conversa_id uuid, tipo text, em timestamptz not null default now());
  create function public.pessoa_ficha(p uuid) returns jsonb language sql as $$ select jsonb_build_object('nome', 'Maria Exemplo') $$;
  ${arq('fila-unidade.sql', 'unidade_chave').replace(/create or replace function public\.unidade_chave\(p text\)/, 'create or replace function public.unidade_chave(p text)')}
  ${arq('indicadores-unidade.sql', 'painel_conversa_pessoa_un')}
  insert into public.agentes (id, papel) values ('${ADMIN}', 'admin'), ('${ATEND}', 'atendente');
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-teste');
`).catch(async () => {   // unidade_chave está escrita em minúsculas no arquivo (sem "create or replace function public."): define igual
  throw new Error('preparação falhou');
});
const sql = readFileSync(`${REPO}/supabase/indicadores-v2.sql`, 'utf8');
await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(sql); await db.exec(sql); return { ok: (await db.query(`select count(*)::int n from cron.job where jobname = 'indicadores-fechar-dia'`)).rows[0].n === 1 }; });

const jwt = (uid) => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid })]);
await jwt(ADMIN);
// Datas de teste em Brasília (UTC-3): usa "dias atrás" a partir de meio-dia para não depender da hora em que o teste roda.
const diaBR = (n) => { const d = new Date(Date.now() - 3 * 3600_000); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const ts = (n, hhmm) => `${diaBR(n)}T${hhmm}:00-03:00`;
const nova = async ({ criada, humano = null, status = 'aguardando', teste = false, unidade = null, grupo = null }) => {
  const id = (await db.query(`insert into public.conversas (status, criado_em, primeiro_humano_em, teste, unidade_inicial) values ($1, $2, $3, $4, $5) returning id`, [status, criada, humano, teste, unidade])).rows[0].id;
  if (grupo) await db.query(`insert into public.conversa_grupo values ($1, $2)`, [id, grupo]);
  return id;
};
const fecha = (c, quando, motivo = 'agendado', origem = 'equipe') => db.query(`insert into public.conversa_encerramento (conversa_id, encerrada_em, motivo, origem) values ($1, $2, $3, $4)`, [c, quando, motivo, origem]);
const evento = (c, tipo, quando) => db.query(`insert into public.conversa_evento (conversa_id, tipo, em) values ($1, $2, $3)`, [c, tipo, quando]);
const ind = async (de, ate, un = null, teste = false) => (await db.query(`select public.painel_indicadores_v2($1::date, $2::date, $3, $4) r`, [de, ate, un, teste])).rows[0].r;
const dia = (r, d) => r.por_dia.find((x) => x.dia === d);

// Cenário: ontem (n=1) e anteontem (n=2).
const G1 = '99999999-0000-0000-0000-000000000001';
// Maria: 3 conversas ontem (duas atendidas, uma nova depois do "sem retorno") = 1 pessoa, 2 reentradas
const m1 = await nova({ criada: ts(1, '08:00'), humano: ts(1, '08:10'), status: 'encerrada', grupo: G1 });
const m2 = await nova({ criada: ts(1, '09:30'), humano: ts(1, '09:40'), status: 'encerrada', grupo: G1 });
const m3 = await nova({ criada: ts(1, '15:00'), humano: ts(1, '15:20'), status: 'encerrada', grupo: G1 });
// João: 1 conversa ontem, atendida
const j1 = await nova({ criada: ts(1, '10:00'), humano: ts(1, '10:05'), status: 'encerrada' });
// Ana: criada ontem 23:50, atendida HOJE... (anteontem = n=2 para evitar mexer com o dia corrente): criada anteontem 23:50, atendida ontem 08:00
const a1 = await nova({ criada: ts(2, '23:50'), humano: ts(1, '08:00'), status: 'encerrada' });
// Pedro: conversa criada ontem e NINGUÉM atendeu (sem atendimento humano)
const p1 = await nova({ criada: ts(1, '11:00'), humano: null, status: 'encerrada' });
// Teste da TI: ontem, atendida
const t1 = await nova({ criada: ts(1, '12:00'), humano: ts(1, '12:01'), status: 'encerrada', teste: true });
// Fechamentos: M1 ontem 08:40; J1 ontem 10:30; A1 hoje... (n=0) para provar "data real do encerramento"; M2 ontem 09:50; M3 ontem 15:40 (reaberta antes? sim: reencerrada)
await fecha(m1, ts(1, '08:40')); await fecha(m2, ts(1, '09:50'), 'desistiu'); await fecha(m3, ts(1, '15:40'), 'nao_respondido', 'inatividade');
await fecha(j1, ts(1, '10:30')); await fecha(a1, ts(0, '00:20'), 'agendado'); await fecha(p1, ts(1, '11:30'), 'outro');
await fecha(m3, ts(0, '01:00'), 'agendado');                           // m3 fecha de novo hoje: reencerrada
await fecha(t1, ts(1, '12:30'));

await caso('principal: pessoas únicas por dia = quem teve o 1º atendimento humano naquele dia (3 conversas da mesma pessoa = 1 pessoa); teste fica fora', async () => {
  const r = await ind(diaBR(2), diaBR(1));
  const d1 = dia(r, diaBR(1)), d2 = dia(r, diaBR(2));
  return { ok: d1.pessoas === 3 && d2.pessoas === 0 && r.pessoas.unicas_no_periodo === 3, detalhe: `ontem=${d1.pessoas} anteontem=${d2.pessoas} unicas=${r.pessoas.unicas_no_periodo} (Maria, João, Ana)` };
});
await caso('Ana: criada às 23:50 de anteontem e atendida ontem → entra ONTEM (dia do 1º atendimento humano)', async () => {
  const r = await ind(diaBR(2), diaBR(2));
  return { ok: r.pessoas.unicas_no_periodo === 0 };
});
await caso('reentradas: Maria voltou 2 vezes no mesmo dia (3 contatos, 1 primeira entrada); João e Ana não', async () => {
  const r = await ind(diaBR(1), diaBR(1));
  return { ok: dia(r, diaBR(1)).reentradas === 2 && r.reentradas.total === 2 && r.reentradas.pessoas_que_voltaram === 1, detalhe: JSON.stringify(r.reentradas) };
});
await caso('reabertura no mesmo dia também é reentrada (evento "reaberta"), sem criar conversa nova', async () => {
  await evento(j1, 'reaberta', ts(1, '16:00'));
  const r = await ind(diaBR(1), diaBR(1));
  await db.query(`delete from public.conversa_evento where conversa_id = $1`, [j1]);
  return { ok: r.reentradas.total === 3 && r.reentradas.pessoas_que_voltaram === 2, detalhe: JSON.stringify(r.reentradas) };
});
await caso('sem atendimento humano: Pedro entra no indicador separado e não infla as pessoas atendidas', async () => {
  const r = await ind(diaBR(1), diaBR(1));
  return { ok: r.sem_atendimento_humano.total === 1 && dia(r, diaBR(1)).sem_humano === 1 && r.sem_atendimento_humano.ainda_sem_pessoa_agora === 1 };
});
await caso('Ana (criada anteontem 23:50, atendida ontem 08:00) NÃO é "sem atendimento humano" de anteontem se foi atendida só no dia seguinte? (foto do fim do dia: sim, aparece lá)', async () => {
  const r = await ind(diaBR(2), diaBR(2));
  return { ok: r.sem_atendimento_humano.total === 1, detalhe: 'anteontem: 1 conversa sem pessoa até o fim do dia (a Ana), mas depois atendida' };
});
await caso('concluídas pela data REAL do encerramento: a Ana, criada anteontem, conclui HOJE; Maria tem 1 reencerrada hoje; ontem tem 5 (sem o teste)', async () => {
  const r = await ind(diaBR(1), diaBR(0));
  const ontem = dia(r, diaBR(1)), hoje = dia(r, diaBR(0));
  return { ok: ontem.concluidas === 5 && hoje.concluidas === 2 && r.conclusoes.reencerradas === 1 && r.conclusoes.cruzaram_meia_noite >= 1 && r.conclusoes.total === 7, detalhe: `ontem=${ontem.concluidas} hoje=${hoje.concluidas} ${JSON.stringify(r.conclusoes)}` };
});
await caso('conclusões: por origem e por motivo separados (inatividade, equipe) e "mais de 24 h" conta só quem passou de um dia', async () => {
  const r = await ind(diaBR(1), diaBR(1));
  return { ok: r.conclusoes.por_origem.inatividade === 1 && r.conclusoes.por_origem.equipe === 4 && r.conclusoes.por_motivo.nao_respondido === 1 && r.conclusoes.mais_de_24h === 0, detalhe: JSON.stringify(r.conclusoes) };
});
await caso('"incluir testes" traz a conversa de teste; o contador de testes aparece sempre', async () => {
  const sem = await ind(diaBR(1), diaBR(1)), com = await ind(diaBR(1), diaBR(1), null, true);
  return { ok: com.pessoas.unicas_no_periodo === sem.pessoas.unicas_no_periodo + 1 && sem.testes.conversas_criadas_no_periodo === 1 && com.conclusoes.total === sem.conclusoes.total + 1 };
});
await caso('em andamento é a foto de agora (aguardando e em atendimento), sem testes e sem encerradas', async () => {
  await nova({ criada: new Date().toISOString(), status: 'aguardando' });
  await nova({ criada: new Date().toISOString(), status: 'em_atendimento', humano: new Date().toISOString() });
  await nova({ criada: new Date().toISOString(), status: 'em_atendimento', teste: true });
  const r = await ind(diaBR(0), diaBR(0));
  return { ok: r.agora.aguardando === 1 && r.agora.em_atendimento === 1, detalhe: JSON.stringify(r.agora) };
});
await caso('filtro de unidade: pessoa sem unidade aparece em todas; pessoa de outra unidade some', async () => {
  const cs = await nova({ criada: ts(1, '13:00'), humano: ts(1, '13:10'), status: 'encerrada', unidade: 'csi' });
  const dv = await nova({ criada: ts(1, '13:30'), humano: ts(1, '13:40'), status: 'encerrada', unidade: 'desenvoar' });
  const todas = await ind(diaBR(1), diaBR(1)), so_csi = await ind(diaBR(1), diaBR(1), 'csi'), so_dv = await ind(diaBR(1), diaBR(1), 'desenvoar');
  await db.query(`delete from public.conversas where id in ($1, $2)`, [cs, dv]);
  return { ok: todas.pessoas.unicas_no_periodo === 5 && so_csi.pessoas.unicas_no_periodo === 4 && so_dv.pessoas.unicas_no_periodo === 4, detalhe: `${todas.pessoas.unicas_no_periodo}/${so_csi.pessoas.unicas_no_periodo}/${so_dv.pessoas.unicas_no_periodo}` };
});
await caso('período livre: um dia só, vários dias somam certo (ontem 3 + hoje 1); período no futuro é cortado em hoje', async () => {
  const um = await ind(diaBR(1), diaBR(1)), varios = await ind(diaBR(5), diaBR(0)), futuro = await ind(diaBR(1), '2999-01-01');
  return { ok: um.por_dia.length === 1 && varios.por_dia.length === 6 && varios.pessoas.soma_dos_dias === 4 && futuro.periodo.ate === diaBR(0) && varios.conclusoes.total === 7, detalhe: `soma=${varios.pessoas.soma_dos_dias} (3 de ontem + 1 atendida hoje) conclusoes=${varios.conclusoes.total}` };
});

await caso('CONGELAMENTO: desligado por padrão (nenhum dia fecha); ligado, fecha os dias que já terminaram, em ordem, e HOJE nunca fecha', async () => {
  const antes = await db.query(`select public.ind_fechar_pendentes() n`);
  await db.query(`update public.config set valor = 'sim' where chave = 'indicadores_fechar'`);
  const fechou = (await db.query(`select public.ind_fechar_pendentes() n`)).rows[0].n;
  const dias = (await db.query(`select dia::text d from public.ind_fechamento order by dia`)).rows.map((x) => x.d);
  const segunda = (await db.query(`select public.ind_fechar_pendentes() n`)).rows[0].n;
  const hoje = await db.query(`select public.ind_fechar_dia($1::date) f`, [diaBR(0)]).then(() => null, (e) => e);
  return { ok: antes.rows[0].n === 0 && fechou >= 2 && dias.includes(diaBR(1)) && !dias.includes(diaBR(0)) && segunda === 0 && hoje && hoje.code === '22023', detalhe: `fechou=${fechou} dias=${dias.length}` };
});
await caso('dia fechado NÃO muda mais: mudar a conversa depois não altera o número do dia fechado (e o dia de hoje continua ao vivo)', async () => {
  const antes = await ind(diaBR(1), diaBR(1));
  await db.query(`update public.conversas set teste = true where id = $1`, [j1]);                // marcar como teste depois de fechado não reescreve ontem
  await fecha(j1, ts(1, '17:00'), 'outro');                                                       // um fechamento "atrasado" no dia fechado
  const depois = await ind(diaBR(1), diaBR(1));
  await db.query(`update public.conversas set teste = false where id = $1`, [j1]);
  return { ok: depois.pessoas.unicas_no_periodo === antes.pessoas.unicas_no_periodo && depois.conclusoes.total === antes.conclusoes.total && depois.periodo.fechado_ate === diaBR(1) && dia(depois, diaBR(1)).fechado === true,
    detalhe: `antes=${antes.pessoas.unicas_no_periodo}/${antes.conclusoes.total} depois=${depois.pessoas.unicas_no_periodo}/${depois.conclusoes.total}` };
});
await caso('as tabelas congeladas não aceitam alterar, apagar nem esvaziar', async () => {
  const f = async (q) => db.query(q).then(() => null, (e) => e);
  const e1 = await f(`update public.ind_pessoa_dia set entrou = false`), e2 = await f(`delete from public.ind_conclusao_dia`), e3 = await f(`truncate public.ind_semhumano_dia`), e4 = await f(`update public.ind_fechamento set resumo = '{}'`);
  return { ok: [e1, e2, e3, e4].every((e) => e && e.code === '42501') };
});
await caso('o resumo do fechamento guarda os números do dia (para comparar depois)', async () => {
  const r = (await db.query(`select resumo from public.ind_fechamento where dia = $1::date`, [diaBR(1)])).rows[0].resumo;
  return { ok: r.pessoas === 3 && r.reentradas === 2 && r.sem_humano === 1, detalhe: JSON.stringify(r) };
});
await caso('extras: conversas por hora de início (Brasília) e avaliações só para administrador, sem teste', async () => {
  await jwt(ADMIN);
  const c = await nova({ criada: ts(1, '08:15'), humano: ts(1, '08:20'), status: 'encerrada' });
  await db.query(`insert into public.avaliacao_atendimento (conversa_id, nota_atendimento, nota_site, canal, criado_em) values ($1, 10, 8, 'Instagram', $2), ($3, 2, 2, 'Google', $2)`, [c, ts(1, '09:00'), t1]);
  const r = (await db.query(`select public.painel_indicadores_extras_v2($1::date, $2::date, null, false) r`, [diaBR(1), diaBR(1)])).rows[0].r;
  const h8 = r.por_hora.find((x) => x.hora === 8);
  await jwt(ATEND);
  const a = (await db.query(`select public.painel_indicadores_extras_v2($1::date, $2::date, null, false) r`, [diaBR(1), diaBR(1)])).rows[0].r;
  await db.exec(`delete from public.avaliacao_atendimento`); await db.query(`delete from public.conversas where id = $1`, [c]);
  return { ok: h8 && h8.conversas >= 2 && r.avaliacoes.total === 1 && Number(r.avaliacoes.media_atendimento) === 10 && r.avaliacoes.por_canal.Instagram === 1 && a.avaliacoes === null && Array.isArray(a.por_hora), detalhe: JSON.stringify(r.avaliacoes) };
});
await caso('permissão: atendente vê; quem não é da equipe é recusado (42501); anônimo não executa', async () => {
  await jwt(ATEND);
  const ok = (await db.query(`select public.painel_indicadores_v2(null, null, null, false) r`)).rows[0].r.periodo.ate === diaBR(0);
  await db.query(`update public.agentes set ativo = false where id = $1`, [ATEND]);
  const e = await db.query(`select public.painel_indicadores_v2() r`).then(() => null, (x) => x);
  await db.query(`update public.agentes set ativo = true where id = $1`, [ATEND]);
  const anon = (await db.query(`select has_function_privilege('anon', 'public.painel_indicadores_v2(date,date,text,boolean)', 'execute') p`)).rows[0].p;
  const interna = (await db.query(`select has_function_privilege('authenticated', 'public.ind_calc_pessoas(date,date)', 'execute') p`)).rows[0].p;
  return { ok: ok && e && e.code === '42501' && !anon && !interna };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} passaram`);
process.exit(falhas ? 1 : 0);
