// FLUXOGRAMA: entrada (supabase/agenda-ao-vivo.sql e as funções reais agenda_ocupacao_atualizar e chat_valida, num Postgres embutido) -> validação (token, interruptor, período, limite por conversa, teto de dias lidos ao mesmo tempo) -> lógica (uma leitura por dia: lê, espera, reaproveita; a gravação troca a ocupação do período e libera o cancelado; trava contra relatório vazio ou cortado) -> saída (PASS/FAIL por caso).
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (AGE-04, agenda ao vivo)
import { readFileSync } from 'node:fs';
import { criarBanco, funcao, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
await db.exec(`
  do $$ begin if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if; end $$;
  create table public.conversa_segredo (conversa_id uuid primary key, token text not null);
  create table public.catalogo_procedimento (id integer primary key, nome text, modalidade text, ativo boolean default true);
  create table public.agenda_regra_duracao (modalidade text primary key, minutos integer);
  create table public.catalogo_agenda (profissional text, unidade text, dia_num integer, hora_ini text, hora_fim text, local text);
  create table public.agenda_ocupacao (
    inicio timestamp not null, profissional text not null, unidade text not null,
    fonte text not null default 'marcada' check (fonte in ('marcada','bloqueada')),
    qtd integer not null default 1, procedimento text, reserva_min integer, local text,
    visto_em timestamptz not null default now(), primary key (inicio, profissional, unidade, fonte));
  create table public.agenda_ocupacao_meta (id integer primary key default 1, valido_desde timestamptz, atualizado_em timestamptz, linhas integer);
  insert into public.agenda_ocupacao_meta (id) values (1);
  ${funcao('fase2-pedido-e-agenda.sql', 'chat_valida')}
  ${funcao('fase2-pedido-e-agenda.sql', 'agenda_ocupacao_atualizar')}
`);
const sql = readFileSync(`${REPO}/supabase/agenda-ao-vivo.sql`, 'utf8');
await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });

const CONV = '11111111-1111-1111-1111-111111111111', TOKEN = 'token-certo';
await db.query(`insert into public.conversa_segredo values ($1, $2)`, [CONV, TOKEN]);
const hoje = (await db.query(`select (now() at time zone 'America/Bahia')::date d`)).rows[0].d;
const ymd = (d) => d.toISOString().slice(0, 10);
const soma = (n) => { const d = new Date(hoje); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const D0 = soma(3), D1 = soma(4), D2 = soma(5);
const chave = async (k, v) => db.query(`update public.config set valor = $2 where chave = $1`, [k, v]);
const pedir = async (dias) => (await db.query(`select dia_ref::text d, acao, lido, iniciado from public.agenda_ao_vivo_pedir($1::date[])`, [dias])).rows;
const gravar = async (de, ate, dias, iniciado, linhas, ok = true, erro = null) =>
  (await db.query(`select public.agenda_ao_vivo_gravar($1, $2, $3::date[], $4::timestamptz, $5::jsonb, $6, $7) r`, [de, ate, dias, iniciado, JSON.stringify(linhas), ok, erro])).rows[0].r;
const ocupados = async (de, ate) => (await db.query(`select to_char(inicio, 'YYYY-MM-DD HH24:MI') i, profissional p from public.agenda_ocupacao where inicio >= $1::date and inicio < ($2::date + 1) order by 1, 2`, [de, ate])).rows;
const antigo = (dia, hora, prof) => db.query(`insert into public.agenda_ocupacao (inicio, profissional, unidade, visto_em) values ($1::timestamp, $2, 'CSI', now() - interval '5 minutes')`, [`${dia} ${hora}`, prof]);
const limpar = () => db.exec(`delete from public.agenda_ocupacao; delete from public.agenda_ao_vivo; delete from public.agenda_ao_vivo_pedido`);
const erro = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

await caso('validar: token errado é recusado (28000) e período inválido também (22023)', async () => {
  const a = await erro(() => db.query(`select public.chat_ao_vivo_validar($1, 'errado', $2::date, $3::date)`, [CONV, D0, D1]));
  const b = await erro(() => db.query(`select public.chat_ao_vivo_validar($1, $4, $2::date, $3::date)`, [CONV, D0, soma(40), TOKEN]));
  const c = await erro(() => db.query(`select public.chat_ao_vivo_validar($1, $4, $2::date, $3::date)`, [CONV, soma(-5), D1, TOKEN]));
  return { ok: a && a.code === '28000' && b && b.code === '22023' && c && c.code === '22023', detalhe: `${a && a.code} ${b && b.code} ${c && c.code}` };
});
await caso('validar: com token certo e período de até 14 dias devolve ok', async () => {
  const r = (await db.query(`select public.chat_ao_vivo_validar($1, $2, $3::date, $4::date) r`, [CONV, TOKEN, D0, soma(16)])).rows[0].r;
  return { ok: r.ok === true };
});
await caso('validar: interruptor desligado responde "desligado" sem contar pedido', async () => {
  await chave('agenda_ao_vivo', 'nao');
  const antes = (await db.query(`select count(*)::int n from public.agenda_ao_vivo_pedido`)).rows[0].n;
  const r = (await db.query(`select public.chat_ao_vivo_validar($1, $2, $3::date, $4::date) r`, [CONV, TOKEN, D0, D1])).rows[0].r;
  const depois = (await db.query(`select count(*)::int n from public.agenda_ao_vivo_pedido`)).rows[0].n;
  await chave('agenda_ao_vivo', 'sim');
  return { ok: r.ok === false && r.motivo === 'desligado' && antes === depois };
});
await caso('validar: depois de 40 pedidos em 10 minutos responde "limite"', async () => {
  await db.exec(`delete from public.agenda_ao_vivo_pedido`);
  let ultimo = null;
  for (let i = 0; i < 41; i++) ultimo = (await db.query(`select public.chat_ao_vivo_validar($1, $2, $3::date, $4::date) r`, [CONV, TOKEN, D0, D1])).rows[0].r;
  return { ok: ultimo.ok === false && ultimo.motivo === 'limite' };
});

await caso('pedir: o primeiro "lê"; o segundo "espera" (leitura única por dia)', async () => {
  await limpar();
  const a = await pedir([D0, D1]);
  const b = await pedir([D0, D1]);
  return { ok: a.every((x) => x.acao === 'ler' && x.iniciado) && b.every((x) => x.acao === 'lendo'), detalhe: `${a.map((x) => x.acao)} ${b.map((x) => x.acao)}` };
});
await caso('pedir: depois de gravar com sucesso, dentro da validade é "fresco"; com validade 0 lê de novo', async () => {
  await limpar();
  const a = await pedir([D0]);
  await gravar(D0, D0, [D0], a[0].iniciado, [], true);
  const b = await pedir([D0]);
  await chave('agenda_ao_vivo_validade_s', '0');
  const c = await pedir([D0]);
  await chave('agenda_ao_vivo_validade_s', '15');
  return { ok: b[0].acao === 'fresco' && b[0].lido && c[0].acao === 'ler', detalhe: `${b[0].acao} ${c[0].acao}` };
});
await caso('pedir: leitura "em andamento" mais velha que a trava é dada como perdida e outra chamada assume', async () => {
  await limpar();
  await pedir([D0]);
  await db.query(`update public.agenda_ao_vivo set lendo_desde = now() - interval '2 minutes' where dia = $1::date`, [D0]);
  const b = await pedir([D0]);
  return { ok: b[0].acao === 'ler' };
});
await caso('pedir: teto global de dias lidos ao mesmo tempo ("ocupado")', async () => {
  await limpar(); await chave('agenda_ao_vivo_max_dias', '2');
  const a = await pedir([D0, D1, D2]);
  await chave('agenda_ao_vivo_max_dias', '14');
  return { ok: a[0].acao === 'ler' && a[1].acao === 'ler' && a[2].acao === 'ocupado', detalhe: a.map((x) => x.acao).join(',') };
});
await caso('pedir: lista vazia ou grande demais é recusada', async () => {
  const a = await erro(() => pedir([]));
  const b = await erro(() => pedir(Array.from({ length: 16 }, (_, i) => soma(i))));
  return { ok: a && a.code === '22023' && b && b.code === '22023' };
});

await caso('gravar: grava o que o Klingo mostrou e LIBERA o horário cancelado (sumiu da leitura)', async () => {
  await limpar();
  for (const h of ['08:00', '09:00', '10:00', '11:00']) await antigo(D0, h, 'DRA ANA');
  await antigo(D2, '08:00', 'DRA ANA');                       // outro dia: não pode ser tocado
  const p = await pedir([D0, D1]);
  const r = await gravar(D0, D1, [D0, D1], p[0].iniciado, [
    { inicio: `${D0} 08:00`, profissional: 'DRA ANA', unidade: 'CSI', procedimento: 'CONSULTA', qtd: 1 },
    { inicio: `${D0} 09:00`, profissional: 'DRA ANA', unidade: 'CSI', procedimento: 'CONSULTA', qtd: 1 },
    { inicio: `${D0} 11:00`, profissional: 'DRA ANA', unidade: 'CSI', procedimento: 'CONSULTA', qtd: 1 },
    { inicio: `${D1} 14:00`, profissional: 'DR PEDRO', unidade: 'CSI', procedimento: 'CONSULTA', qtd: 1 },   // marcação nova
  ]);
  const o = await ocupados(D0, D2);
  const horas = o.map((x) => x.i.slice(5) + ' ' + x.p).join('|');
  return { ok: r.ok && r.liberadas === 1 && !horas.includes(`${D0.slice(5)} 10:00`) && horas.includes(`${D1.slice(5)} 14:00 DR PEDRO`) && horas.includes(`${D2.slice(5)} 08:00`), detalhe: JSON.stringify(r) };
});
await caso('gravar: relatório VAZIO não apaga nada (trava de segurança) e o dia fica marcado como lido', async () => {
  await limpar();
  for (const h of ['08:00', '09:00', '10:00', '11:00']) await antigo(D0, h, 'DRA ANA');
  const p = await pedir([D0]);
  const r = await gravar(D0, D0, [D0], p[0].iniciado, []);
  const n = (await ocupados(D0, D0)).length;
  const lido = (await db.query(`select ok, erro from public.agenda_ao_vivo where dia = $1::date`, [D0])).rows[0];
  return { ok: r.suspeito === true && r.liberadas === 0 && n === 4 && lido.ok === true && /suspeito/.test(lido.erro || ''), detalhe: JSON.stringify(r) };
});
await caso('gravar: relatório que "perdeu" mais da metade (cortado) não apaga nada', async () => {
  await limpar();
  for (const h of ['07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00']) await antigo(D0, h, 'DRA ANA');
  const p = await pedir([D0]);
  const r = await gravar(D0, D0, [D0], p[0].iniciado, [{ inicio: `${D0} 07:00`, profissional: 'DRA ANA', unidade: 'CSI', procedimento: 'CONSULTA', qtd: 1 }]);
  return { ok: r.suspeito === true && (await ocupados(D0, D0)).length === 8 };
});
await caso('gravar: poucas linhas sumidas (até 2) são liberadas mesmo com relatório curto', async () => {
  await limpar();
  await antigo(D0, '08:00', 'DRA ANA'); await antigo(D0, '09:00', 'DRA ANA');
  const p = await pedir([D0]);
  const r = await gravar(D0, D0, [D0], p[0].iniciado, [{ inicio: `${D0} 08:00`, profissional: 'DRA ANA', unidade: 'CSI', procedimento: 'CONSULTA', qtd: 1 }]);
  return { ok: r.liberadas === 1 && r.suspeito === false && (await ocupados(D0, D0)).length === 1 };
});
await caso('gravar: linha vista por uma leitura MAIS NOVA não é apagada por uma leitura mais antiga', async () => {
  await limpar();
  await antigo(D0, '08:00', 'DRA ANA'); await antigo(D0, '09:00', 'DRA ANA'); await antigo(D0, '10:00', 'DRA ANA');
  const p = await pedir([D0]);
  await db.query(`update public.agenda_ocupacao set visto_em = now() + interval '1 minute' where inicio = $1::timestamp`, [`${D0} 10:00`]);   // outra leitura, mais nova, viu esta
  const r = await gravar(D0, D0, [D0], p[0].iniciado, [{ inicio: `${D0} 08:00`, profissional: 'DRA ANA', unidade: 'CSI', procedimento: 'CONSULTA', qtd: 1 }, { inicio: `${D0} 09:00`, profissional: 'DRA ANA', unidade: 'CSI', procedimento: 'CONSULTA', qtd: 1 }]);
  const horas = (await ocupados(D0, D0)).map((x) => x.i.slice(11));
  return { ok: horas.includes('10:00') && horas.length === 3 && r.liberadas === 0, detalhe: horas.join(',') };
});
await caso('gravar: linhas VELHAS (já ignoradas pela leitura geral) não disparam a trava e são limpas; as vigentes não vistas são liberadas', async () => {
  await limpar();
  await db.query(`update public.agenda_ocupacao_meta set valido_desde = now() - interval '2 minutes' where id = 1`);
  for (const h of ['06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00']) await db.query(`insert into public.agenda_ocupacao (inicio, profissional, unidade, visto_em) values ($1::timestamp, 'DRA ANA', 'CSI', now() - interval '3 hours')`, [`${D0} ${h}`]);  // velhas
  for (const h of ['10:00', '11:00']) await db.query(`insert into public.agenda_ocupacao (inicio, profissional, unidade, visto_em) values ($1::timestamp, 'DRA ANA', 'CSI', now() - interval '1 minute')`, [`${D0} ${h}`]);       // vigentes
  const p = await pedir([D0]);
  const r = await gravar(D0, D0, [D0], p[0].iniciado, [{ inicio: `${D0} 10:00`, profissional: 'DRA ANA', unidade: 'CSI', procedimento: 'CONSULTA', qtd: 1 }]);
  const horas = (await ocupados(D0, D0)).map((x) => x.i.slice(11));
  await db.query(`update public.agenda_ocupacao_meta set valido_desde = null where id = 1`);
  return { ok: r.suspeito === false && r.velhas_limpas === 7 && r.liberadas === 1 && horas.join(',') === '10:00', detalhe: `${JSON.stringify(r)} ${horas}` };
});
await caso('gravar: falha da leitura libera a trava, guarda o erro e a próxima chamada lê de novo', async () => {
  await limpar();
  const p = await pedir([D0]);
  await gravar(D0, D0, [D0], p[0].iniciado, [], false, 'Klingo retornou HTTP 500');
  const e = (await db.query(`select ok, erro, lendo_desde from public.agenda_ao_vivo where dia = $1::date`, [D0])).rows[0];
  const b = await pedir([D0]);
  return { ok: e.ok === false && /500/.test(e.erro) && e.lendo_desde === null && b[0].acao === 'ler' };
});
await caso('privilégios: só service_role executa; anon e authenticated não', async () => {
  const fns = ['chat_ao_vivo_validar(uuid,text,date,date)', 'agenda_ao_vivo_pedir(date[])', 'agenda_ao_vivo_gravar(date,date,date[],timestamptz,jsonb,boolean,text)'];
  let ok = true;
  for (const f of fns) {
    for (const papel of ['anon', 'authenticated']) ok = ok && !(await db.query(`select has_function_privilege($1, 'public.${f}', 'execute') p`, [papel])).rows[0].p;
    ok = ok && (await db.query(`select has_function_privilege('service_role', 'public.${f}', 'execute') p`)).rows[0].p;
  }
  const tabela = (await db.query(`select has_table_privilege('anon', 'public.agenda_ao_vivo', 'select') a, has_table_privilege('authenticated', 'public.agenda_ao_vivo_pedido', 'select') b`)).rows[0];
  return { ok: ok && !tabela.a && !tabela.b };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} passaram`);
process.exit(falhas ? 1 : 0);
