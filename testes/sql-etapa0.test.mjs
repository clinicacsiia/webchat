// FLUXOGRAMA: entrada (supabase/etapa0-eventos-e-teste.sql num Postgres embutido, com conversas, mensagens e contatos inventados) -> validação (a marca de teste e o primeiro atendimento não mudam por pedido direto à API; só a TI marca; gatilho com defeito não atrapalha o atendimento) -> lógica (linha do tempo; primeiro atendimento humano; conta de teste assume, responde ou encerra; contato de teste; regra aplicada ao passado só lista até mandar aplicar) -> saída (PASS/FAIL por caso)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (Etapa 0)
import { readFileSync } from 'node:fs';
import { criarBanco, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
const TI = '11111111-1111-1111-1111-111111111111', ATEND = '22222222-2222-2222-2222-222222222222', ATEND2 = '33333333-3333-3333-3333-333333333333';
await db.exec(`
  do $$ begin if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if; end $$;
  create table public.contatos (id uuid primary key default gen_random_uuid(), nome text);
  alter table public.conversas add column contato_id uuid, add column status text not null default 'aguardando', add column agente_id uuid, add column encerrada_por uuid,
    add column motivo_encerramento text, add column encerramento_origem text, add column criado_em timestamptz not null default now(), add column unidade_inicial text;
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid references public.conversas(id) on delete cascade, autor text, agente_id uuid, texto text, criado_em timestamptz not null default now());
  create table public.conversa_encerramento (id bigint generated always as identity primary key, conversa_id uuid, encerrada_em timestamptz, motivo text, origem text, por uuid);
  insert into public.agentes (id, papel) values ('${TI}', 'admin'), ('${ATEND}', 'atendente'), ('${ATEND2}', 'atendente');
`);
const jwt = (uid) => db.query(`select set_config('request.jwt.claims', $1, false)`, [uid ? JSON.stringify({ sub: uid }) : '{}']);
const conv = async (extra = {}) => (await db.query(`insert into public.conversas (contato_id, status) values ($1, $2) returning id`, [extra.contato ?? null, extra.status ?? 'aguardando'])).rows[0].id;
const cv = async (id) => (await db.query(`select status, agente_id, teste, teste_motivo, teste_manual, primeiro_humano_em p from public.conversas where id = $1`, [id])).rows[0];
const eventos = async (id, tipo) => (await db.query(`select tipo, de_agente, para_agente, por, motivo, detalhe from public.conversa_evento where conversa_id = $1 ${tipo ? 'and tipo = $2' : ''} order by id`, tipo ? [id, tipo] : [id])).rows;
const erro = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---- dados "do passado", ANTES do arquivo ----
const velha = await conv({ status: 'encerrada' });
await db.query(`insert into public.mensagens (conversa_id, autor, texto, criado_em) values ($1, 'sistema', 'Ana entrou na conversa.', now() - interval '3 days'), ($1, 'agente', 'oi', now() - interval '2 days 23 hours')`, [velha]);
await db.query(`update public.mensagens set agente_id = '${ATEND}' where conversa_id = $1 and autor = 'agente'`, [velha]);
await db.query(`insert into public.conversa_encerramento (conversa_id, encerrada_em, motivo, origem, por) values ($1, now() - interval '2 days', 'agendado', 'equipe', '${ATEND}')`, [velha]);
const semHumano = await conv({ status: 'aguardando' });

const sql = readFileSync(`${REPO}/supabase/etapa0-eventos-e-teste.sql`, 'utf8');
await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });

await caso('passado: eventos "criada" e "encerrada" são reconstruídos, sem duplicar na segunda aplicação', async () => {
  const e = await eventos(velha);
  const tipos = e.map((x) => x.tipo).join(',');
  return { ok: tipos.includes('criada') && tipos.includes('encerrada') && e.filter((x) => x.tipo === 'criada').length === 1 && e.filter((x) => x.tipo === 'encerrada').length === 1 && e.find((x) => x.tipo === 'encerrada').motivo === 'agendado', detalhe: tipos };
});
await caso('passado: primeiro atendimento humano = a primeira entre "entrou na conversa" e a primeira resposta; conversa sem pessoa fica sem', async () => {
  const a = await cv(velha), b = await cv(semHumano);
  const dias = (Date.now() - a.p.getTime()) / 86400000;
  return { ok: dias > 2.9 && dias < 3.1 && b.p === null, detalhe: `dias atrás=${dias.toFixed(2)} sem pessoa=${b.p}` };
});

await db.query(`update public.config set valor = $1 where chave = 'teste_agentes'`, [TI]);
await db.query(`update public.config set valor = $1 where chave = 'teste_marcadores'`, [TI]);

await caso('criar a conversa grava "criada" e não marca teste; primeiro atendimento ainda vazio', async () => {
  await jwt(null);
  const c = await conv(); const x = await cv(c);
  return { ok: (await eventos(c, 'criada')).length === 1 && x.teste === false && x.p === null };
});
await caso('assumir grava "assumida" (com quem) e o primeiro atendimento; transferir grava "transferida" e NÃO muda o primeiro atendimento', async () => {
  await jwt(ATEND);
  const c = await conv();
  await db.query(`update public.conversas set status = 'em_atendimento', agente_id = $2 where id = $1`, [c, ATEND]);
  const p1 = (await cv(c)).p;
  await new Promise((r) => setTimeout(r, 30));
  await db.query(`update public.conversas set agente_id = $2 where id = $1`, [c, ATEND2]);
  const x = await cv(c), a = (await eventos(c, 'assumida'))[0], t = (await eventos(c, 'transferida'))[0];
  return { ok: p1 && x.p.getTime() === p1.getTime() && a.para_agente === ATEND && a.por === ATEND && t.de_agente === ATEND && t.para_agente === ATEND2 && (await eventos(c, 'primeiro_humano')).length === 1, detalhe: `${a.para_agente?.slice(0, 2)} ${t.de_agente?.slice(0, 2)}>${t.para_agente?.slice(0, 2)}` };
});
await caso('encerrar grava "encerrada" com o motivo; por inatividade vira "autoencerrada"; reabrir grava "reaberta"', async () => {
  await jwt(ATEND);
  const c = await conv(); const d = await conv();
  await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'desistiu', encerramento_origem = 'equipe', encerrada_por = $2 where id = $1`, [c, ATEND]);
  await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'nao_respondido', encerramento_origem = 'inatividade' where id = $1`, [d]);
  await db.query(`update public.conversas set status = 'aguardando' where id = $1`, [c]);
  const e1 = await eventos(c), e2 = await eventos(d, 'autoencerrada');
  return { ok: e1.some((x) => x.tipo === 'encerrada' && x.motivo === 'desistiu' && x.por === ATEND) && e1.some((x) => x.tipo === 'reaberta') && e2.length === 1 && e2[0].detalhe.origem === 'inatividade' };
});

await caso('conta de teste que ASSUME marca a conversa como teste, e a marca fica mesmo depois da transferência', async () => {
  await jwt(TI);
  const c = await conv();
  await db.query(`update public.conversas set status = 'em_atendimento', agente_id = $2 where id = $1`, [c, TI]);
  const a = await cv(c);
  await db.query(`update public.conversas set agente_id = $2 where id = $1`, [c, ATEND]);
  const b = await cv(c);
  return { ok: a.teste === true && /conta de teste/.test(a.teste_motivo) && b.teste === true, detalhe: a.teste_motivo };
});
await caso('conta de teste que ENCERRA marca a conversa', async () => {
  await jwt(TI);
  const c = await conv({ status: 'em_atendimento' });
  await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'outro', encerramento_origem = 'equipe', encerrada_por = $2 where id = $1`, [c, TI]);
  return { ok: (await cv(c)).teste === true };
});
await caso('conta de teste que RESPONDE (mesmo sem ser a dona) marca a conversa; resposta de atendente normal não marca', async () => {
  await jwt(TI);
  const c = await conv({ status: 'em_atendimento' }), d = await conv({ status: 'em_atendimento' });
  await db.query(`update public.conversas set agente_id = $2 where id = $1`, [c, ATEND]);
  await db.query(`insert into public.mensagens (conversa_id, autor, agente_id, texto) values ($1, 'agente', $2, 'oi')`, [c, TI]);
  await db.query(`insert into public.mensagens (conversa_id, autor, agente_id, texto) values ($1, 'agente', $2, 'oi')`, [d, ATEND]);
  return { ok: (await cv(c)).teste === true && (await cv(d)).teste === false && (await eventos(c, 'teste_marcado')).length === 1 };
});
await caso('mensagem do paciente e do assistente automático não marcam', async () => {
  const c = await conv();
  await db.query(`insert into public.mensagens (conversa_id, autor, texto) values ($1, 'cliente', 'oi'), ($1, 'agente', 'oi do robô')`, [c]);
  return { ok: (await cv(c)).teste === false };
});
await caso('contato de teste: a conversa já nasce como teste; contato comum não', async () => {
  await jwt(TI);
  const ct = (await db.query(`insert into public.contatos (nome) values ('x') returning id`)).rows[0].id;
  const ct2 = (await db.query(`insert into public.contatos (nome) values ('y') returning id`)).rows[0].id;
  const r = (await db.query(`select public.contato_marcar_teste($1, true, 'teste da TI', false) r`, [ct])).rows[0].r;
  const a = await conv({ contato: ct }), b = await conv({ contato: ct2 });
  return { ok: r.ok && (await cv(a)).teste === true && (await cv(a)).teste_motivo === 'contato de teste' && (await cv(b)).teste === false };
});

await caso('pedido direto à API NÃO muda a marca de teste nem o primeiro atendimento', async () => {
  await jwt(ATEND);
  const c = await conv({ status: 'em_atendimento' });
  await db.query(`update public.conversas set agente_id = $2 where id = $1`, [c, ATEND]);
  const antes = await cv(c);
  await db.query(`update public.conversas set teste = true, teste_motivo = 'x', teste_manual = true, primeiro_humano_em = '2000-01-01' where id = $1`, [c]);
  const depois = await cv(c);
  const t = await conv();
  const x = await cv(t);
  await db.query(`update public.conversas set teste = false where id = $1`, [(await db.query(`select id from public.conversas where teste order by criado_em limit 1`)).rows[0].id]);
  return { ok: depois.teste === false && depois.teste_motivo === null && depois.teste_manual === false && depois.p.getTime() === antes.p.getTime() && x.teste === false, detalhe: JSON.stringify(depois) };
});

await caso('só a TI marca e desmarca (atendente comum recebe 42501); desmarcar impede a regra automática de marcar de novo; tudo fica na linha do tempo', async () => {
  await jwt(ATEND);
  const c = await conv({ status: 'em_atendimento' });
  const e = await erro(() => db.query(`select public.conversa_marcar_teste($1, true, 'x')`, [c]));
  await jwt(TI);
  await db.query(`select public.conversa_marcar_teste($1, true, 'treinamento')`, [c]);
  const marcada = await cv(c);
  await db.query(`select public.conversa_marcar_teste($1, false, 'era paciente real')`, [c]);
  const desmarcada = await cv(c);
  await db.query(`update public.conversas set agente_id = $2 where id = $1`, [c, TI]);            // a TI assume depois: não marca de novo
  await db.query(`insert into public.mensagens (conversa_id, autor, agente_id, texto) values ($1, 'agente', $2, 'oi')`, [c, TI]);
  const depois = await cv(c);
  const ev = (await eventos(c)).map((x) => x.tipo).filter((t) => t.startsWith('teste')).join(',');
  return { ok: e && e.code === '42501' && marcada.teste === true && desmarcada.teste === false && desmarcada.teste_manual === true && depois.teste === false && ev === 'teste_marcado,teste_desmarcado', detalhe: ev };
});

await caso('regra no PASSADO: só lista até mandar aplicar; ignora conversa desmarcada de propósito; aplicar marca e é repetível', async () => {
  await jwt(null);
  const p1 = await conv({ status: 'encerrada' }), p2 = await conv({ status: 'encerrada' });
  await db.query(`update public.config set valor = '' where chave = 'teste_agentes'`);        // regra desligada: nada é marcado na hora
  await db.query(`update public.conversas set agente_id = $2 where id = $1`, [p1, TI]);
  await db.query(`insert into public.mensagens (conversa_id, autor, agente_id, texto) values ($1, 'agente', $2, 'oi')`, [p2, TI]);
  const antes = [(await cv(p1)).teste, (await cv(p2)).teste];
  await db.query(`update public.config set valor = $1 where chave = 'teste_agentes'`, [TI]);
  const lista = (await db.query(`select conversa_id, motivo, aplicada from public.teste_regra_passado_interno(false)`)).rows;
  const naoMarcouAinda = (await cv(p1)).teste === false;
  const aplicado = (await db.query(`select conversa_id from public.teste_regra_passado_interno(true)`)).rows;
  const depois = [(await cv(p1)).teste, (await cv(p2)).teste];
  const denovo = (await db.query(`select conversa_id from public.teste_regra_passado_interno(false)`)).rows;
  return { ok: !antes[0] && !antes[1] && lista.some((x) => x.conversa_id === p1 && x.aplicada === false) && lista.some((x) => x.conversa_id === p2) && naoMarcouAinda && aplicado.length === lista.length && depois[0] && depois[1] && !denovo.some((x) => [p1, p2].includes(x.conversa_id)),
    detalhe: `listadas=${lista.length} motivos=${[...new Set(lista.map((x) => x.motivo))].join(' | ')}` };
});
await caso('regra no passado pelo caminho público exige a TI', async () => {
  await jwt(ATEND);
  const e = await erro(() => db.query(`select * from public.teste_regra_passado(false)`));
  await jwt(TI);
  const ok = (await db.query(`select count(*)::int n from public.teste_regra_passado(false)`)).rows[0].n >= 0;
  return { ok: e && e.code === '42501' && ok };
});

await caso('gatilho com defeito NÃO atrapalha o atendimento (a tabela de eventos some e a conversa continua mudando)', async () => {
  await jwt(ATEND);
  const c = await conv();
  await db.exec(`alter table public.conversa_evento rename to conversa_evento_x`);
  let falhou = null;
  try { await db.query(`update public.conversas set status = 'em_atendimento', agente_id = $2 where id = $1`, [c, ATEND]); } catch (e) { falhou = e; }
  await db.exec(`alter table public.conversa_evento_x rename to conversa_evento`);
  const x = await cv(c);
  return { ok: !falhou && x.status === 'em_atendimento' && x.p !== null, detalhe: falhou && falhou.message };
});

await caso('privilégios: a equipe só LÊ os eventos; escrever direto é recusado; as funções internas não são públicas', async () => {
  const ev = (await db.query(`select has_table_privilege('authenticated', 'public.conversa_evento', 'insert') i, has_table_privilege('authenticated', 'public.conversa_evento', 'update') u, has_table_privilege('authenticated', 'public.conversa_evento', 'delete') d, has_table_privilege('anon', 'public.conversa_evento', 'select') a`)).rows[0];
  const fn = async (f, papel) => (await db.query(`select has_function_privilege($1, '${f}', 'execute') p`, [papel])).rows[0].p;
  return { ok: !ev.i && !ev.u && !ev.d && !ev.a && !(await fn('public.conversa_marcar_teste_interno(uuid,text)', 'authenticated')) && !(await fn('public.teste_regra_passado_interno(boolean)', 'authenticated'))
    && !(await fn('public.conversa_marcar_teste(uuid,boolean,text)', 'anon')) && (await fn('public.conversa_marcar_teste(uuid,boolean,text)', 'authenticated')) };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} passaram`);
process.exit(falhas ? 1 : 0);
