// FLUXOGRAMA: entrada (fila-chegada.sql aplicado duas vezes num Postgres embutido com stubs do Supabase) -> validação (papéis anon/paciente/equipe via JWT simulado) -> lógica (posição, avisos "chegou/perto/sua vez" uma vez cada, uma fila aberta por pessoa, isolamento entre pacientes) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
import { readFileSync } from 'node:fs';
import { criarBanco, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, d = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, 'exceção: ' + e.message.split('\n')[0]); } };

const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
await db.exec(`
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb);
  create table public.contas_paciente (id uuid primary key references auth.users(id) on delete cascade, email text, paciente_id uuid references public.pacientes(id));
  grant select, insert, update, delete on all tables in schema public to authenticated;
`);
const sql = readFileSync(`${REPO}/supabase/fila-chegada.sql`, 'utf8');
await db.exec(sql); await db.exec(sql);   // idempotente
const q = async (s, p = []) => (await db.query(s, p)).rows;
const como = async (uid, fn) => { await db.exec(`set request.jwt.claims = '${uid ? JSON.stringify({ sub: uid }) : ''}'; set role ${uid ? 'authenticated' : 'anon'}`); try { return await fn(); } finally { await db.exec('reset role; reset request.jwt.claims'); } };

const novo = async (email, nome) => {
  const id = (await q(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, JSON.stringify({ nome })]))[0].id;
  await q(`insert into public.contas_paciente (id, email) values ($1, $2)`, [id, email]);
  return id;
};
const [a, b, c, d] = [await novo('a@x.com', 'Ana'), await novo('b@x.com', 'Beto'), await novo('c@x.com', 'Carla'), await novo('d@x.com', 'Davi')];
const staff = (await q(`insert into auth.users (email) values ('eq@x.com') returning id`))[0].id;
await q(`insert into public.agentes (id, papel, ativo) values ($1, 'atendente', true)`, [staff]);
await q(`insert into public.config (chave, valor) values ('fila_push_url', 'https://exemplo/fila-avisar') on conflict (chave) do update set valor = excluded.valor`);
await q(`insert into vault.secrets_tbl (name, secret) values ('fila_aviso_segredo', 'seg')`);
const avisos = async (uid) => (await q(`select tipo from public.fila_aviso where conta_id = $1 order by id`, [uid])).map((r) => r.tipo);

await caso('anônimo não entra na fila', async () => {
  try { await como(null, () => q('select public.fila_cheguei()')); return { ok: false }; } catch (e) { return { ok: /permission|Entre/.test(e.message), detalhe: e.message }; }
});
await caso('Cheguei: 1º da fila, posição 1, aviso "chegada"', async () => {
  const r = (await como(a, () => q('select public.fila_cheguei() r')))[0].r;
  return { ok: r.situacao === 'aguardando' && r.posicao === 1 && r.a_frente === 0 && r.senha === 1 && (await avisos(a)).join() === 'chegada', detalhe: JSON.stringify(r) };
});
await caso('tocar Cheguei de novo não duplica nem repete aviso', async () => {
  await como(a, () => q('select public.fila_cheguei()'));
  return { ok: (await q(`select count(*)::int n from public.fila_chegada where conta_id = $1`, [a]))[0].n === 1 && (await avisos(a)).length === 1 };
});
await como(b, () => q('select public.fila_cheguei()'));
await como(c, () => q('select public.fila_cheguei()'));
await caso('3ª pessoa: posição 3, 2 à frente → avisa "perto" já na chegada', async () => {
  const r = (await como(c, () => q('select public.fila_minha_vez() r')))[0].r;
  return { ok: r.posicao === 3 && r.a_frente === 2 && (await avisos(c)).join() === 'chegada,perto', detalhe: JSON.stringify(r) };
});
await caso('4ª pessoa: 3 à frente, ainda sem "perto"', async () => {
  await como(d, () => q('select public.fila_cheguei()'));
  return { ok: (await avisos(d)).join() === 'chegada' };
});
await caso('chamar o 1º: Ana "sua vez"; Beto e Carla andam; Davi (2 à frente) ganha "perto"', async () => {
  await como(staff, () => q('select public.fila_chamar_proximo()'));
  const ra = (await como(a, () => q('select public.fila_minha_vez() r')))[0].r;
  const rd = (await como(d, () => q('select public.fila_minha_vez() r')))[0].r;
  return { ok: ra.situacao === 'chamado' && (await avisos(a)).join() === 'chegada,vez' && rd.posicao === 3 && (await avisos(d)).join() === 'chegada,perto', detalhe: JSON.stringify([ra, rd]) };
});
await caso('cada aviso sai uma vez só (nova chamada não repete "perto")', async () => {
  const ida = (await q(`select id from public.fila_chegada where conta_id = $1`, [a]))[0].id;
  await como(staff, () => q('select public.fila_mudar($1, $2)', [ida, 'atendido']));
  return { ok: (await q(`select count(*)::int n from public.fila_aviso where conta_id = $1 and tipo = 'perto'`, [d]))[0].n === 1 };
});
await caso('paciente atendido vê "atendido"', async () => {
  const r = (await como(a, () => q('select public.fila_minha_vez() r')))[0].r;
  return { ok: r.situacao === 'atendido', detalhe: JSON.stringify(r) };
});
await caso('paciente não lê a tabela da fila nem a de avisos', async () => {
  const lidas = await como(b, async () => { try { return (await q('select * from public.fila_chegada')).length; } catch { return 0; } });
  let av = 0; try { av = await como(b, async () => (await q('select * from public.fila_aviso')).length); } catch { av = 0; }
  return { ok: lidas === 0 && av === 0 };
});
await caso('paciente não chama nem conclui', async () => {
  try { await como(b, () => q('select public.fila_chamar_proximo()')); return { ok: false }; } catch (e) { return { ok: /equipe/.test(e.message), detalhe: e.message }; }
});
await caso('equipe lê a fila', async () => ({ ok: (await como(staff, () => q('select * from public.fila_chegada'))).length === 4 }));
await caso('recepção registra pessoa sem conta e não duplica quem já está', async () => {
  const id = (await como(staff, () => q(`select public.fila_registrar_chegada('Sr. José') id`)))[0].id;
  let dup = false; try { await como(staff, () => q('select public.fila_registrar_chegada(null, $1)', [b])); } catch (e) { dup = /já está/.test(e.message); }
  return { ok: !!id && dup };
});
await caso('chegada da fila gera chamada ao push (pg_net) com o segredo', async () => {
  const n = await q(`select headers from net.chamadas where url = 'https://exemplo/fila-avisar' limit 1`);
  return { ok: n.length > 0 && n[0].headers['x-fila-aviso-segredo'] === 'seg' };
});
await caso('aviso de tela: broadcast sem dado pessoal', async () => {
  const m = await q(`select payload::text p from realtime.messages where topic = 'fila-chegada'`);
  return { ok: m.length > 0 && m.every((x) => !/Ana|Beto|@/.test(x.p)) };
});
await caso('inscrição de push: só https, e remover só a própria', async () => {
  await como(b, () => q(`select public.fila_push_salvar('https://push.exemplo/abc', 'k', 'a')`));
  let ruim = false; try { await como(b, () => q(`select public.fila_push_salvar('http://x', 'k', 'a')`)); } catch { ruim = true; }
  await como(c, () => q(`select public.fila_push_remover('https://push.exemplo/abc')`));
  const sobrou = (await q('select count(*)::int n from public.push_inscricao'))[0].n === 1;
  return { ok: ruim && sobrou };
});
await caso('autochegada desligada: paciente não entra', async () => {
  await q(`update public.config set valor = 'nao' where chave = 'fila_autochegada'`);
  const e = await q(`select 1`);
  try { const z = await novo('z@x.com', 'Zeca'); await como(z, () => q('select public.fila_cheguei()')); return { ok: false }; } catch (er) { return { ok: /recepção/.test(er.message), detalhe: er.message }; }
});
const falhas = resultados.filter((x) => !x).length;
console.log(falhas ? `\n${falhas} FALHA(S)` : `\nTodos os ${resultados.length} casos passaram.`);
process.exit(falhas ? 1 : 0);
