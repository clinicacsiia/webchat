// FLUXOGRAMA: entrada (o retrato da produção + as migrações do acesso rápido + acesso-rapido-pin-servidor.sql; cadastros e conversas INVENTADOS) -> validação (cada chamada como "anon", com o cabeçalho x-acesso que o chat manda; sem cabeçalho; com PIN vencido; como service_role; como função app_*) -> lógica (a trava app_pin_exigir recusa com "pin_obrigatorio" só quando as três chaves estão ligadas e a chamada vem da internet sem aparelho com PIN válido) -> saída (casos PASS/FAIL)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (PIN obrigatório também no servidor).
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo } = ajudantes(db);
for (const f of ['acesso-rapido-paciente', 'acesso-rapido-chat', 'acesso-rapido-pendencias', 'acesso-rapido-pin-obrigatorio']) await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8'));
const sql = readFileSync(`${REPO}/supabase/acesso-rapido-pin-servidor.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('acesso-rapido-pin-servidor.sql aplica duas vezes sem erro (idempotente) e a trava nasce DESLIGADA', async () => {
  await db.exec(sql); await db.exec(sql);
  return { ok: (await um(`select valor from public.config where chave = 'app_pin_servidor'`)).valor === 'nao' };
});
await caso('a trava entrou UMA vez em cada uma das 5 funções (aplicar duas vezes não duplica)', async () => {
  const r = (await q(`select p.proname, (length(pg_get_functiondef(p.oid)) - length(replace(pg_get_functiondef(p.oid), 'app_pin_exigir()', ''))) / length('app_pin_exigir()') as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('chat_iniciar','chat_nova_conversa','chat_irmao_iniciar','chat_enviar','chat_responder') order by 1`));
  return { ok: r.length === 5 && r.every((x) => Number(x.n) === 1), detalhe: r.map((x) => `${x.proname}=${x.n}`).join(' ') };
});
const cfg = (chave, valor) => db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]);
await cfg('app_acesso_modo', 'sim'); await cfg('app_pin_obrigatorio', 'sim');

// Cadastro inventado (como a página /acesso/ faria): devolve o código do aparelho.
await anonimo();
const cad = (await q(`select public.app_cadastrar(p_telefone => '71991230001', p_nome => 'Ana Souza Teste', p_nascimento => '1988-04-12', p_pin => '1357', p_filhos => '[]'::jsonb, p_aparelho => 'teste') r`))[0].r;
await db.exec('reset role');
const TOK = cad && cad.token;
await caso('cadastro de teste criado', async () => ({ ok: !!TOK, detalhe: JSON.stringify(cad).slice(0, 80) }));

// Conversa criada "por dentro" (sem requisição HTTP), para testar chat_enviar e chat_responder.
const conversa = async () => {
  await db.query(`update public.conversas set criado_em = criado_em - interval '2 hours'`);
  const r = (await q(`select public.chat_iniciar(p_nome => 'Ana Souza Teste', p_telefone => '71991230001', p_email => 'ana@exemplo.invalid', p_aceite => true) r`))[0].r;
  return { c: r.conversa_id, t: r.token };
};
const conv = await conversa();

// Uma chamada "vinda da internet": cabeçalhos, caminho e papel como o PostgREST coloca.
async function chamar(sqlChamada, params = [], { cab = {}, caminho = '/rpc/chat_iniciar', papel = 'anon', semHttp = false } = {}) {
  if (!semHttp) {
    await db.query(`select set_config('request.headers', $1, false), set_config('request.path', $2, false), set_config('request.jwt.claims', $3, false)`, [JSON.stringify(cab), caminho, JSON.stringify({ role: papel })]);
  }
  await db.exec(papel === 'service_role' ? 'reset role; set role service_role' : 'reset role; set role anon');
  try { return { ok: true, r: (await q(sqlChamada, params))[0]?.r }; }
  catch (e) { return { ok: false, msg: String(e.message) }; }
  finally { await db.exec('reset role'); await db.query(`select set_config('request.headers', '', false), set_config('request.path', '', false), set_config('request.jwt.claims', '', false)`); }
}
const INICIAR = `select public.chat_iniciar(p_nome => 'Bia Costa Teste', p_telefone => '71991230009', p_email => 'bia@exemplo.invalid', p_aceite => true) r`;
const ENVIAR = (c) => [`select public.chat_enviar($1::uuid, $2, 'oi') r`, [c.c, c.t]];
const RESPONDER = (c) => [`select public.chat_responder($1::uuid, $2, 'nome', to_jsonb('Ana Souza Teste'::text), 'Ana Souza Teste') r`, [c.c, c.t]];
const NOVA = (c) => [`select public.chat_nova_conversa($1::uuid, $2, 'Ana Souza Teste', '71991230001', 'a@b.co', true, true, 'proprio-teste', null, null, 'proprio', null, null, null, null, null) r`, [c.c, c.t]];
const IRMAO = (c) => [`select public.chat_irmao_iniciar($1::uuid, $2) r`, [c.c, c.t]];
const recusou = (x) => x.ok === false && /pin_obrigatorio/.test(x.msg);
const novaLimpa = async () => db.query(`update public.conversas set criado_em = criado_em - interval '2 hours'`);

// ---- trava desligada (como nasce): nada muda
await caso('trava DESLIGADA: nenhuma das 5 chamadas é recusada pelo PIN, mesmo sem aparelho', async () => {
  const a = await chamar(INICIAR, [], { cab: {} }); await novaLimpa();
  const b = await chamar(...ENVIAR(conv), { caminho: '/rpc/chat_enviar' });
  const c = await chamar(...RESPONDER(conv), { caminho: '/rpc/chat_responder' });
  return { ok: !recusou(a) && !recusou(b) && !recusou(c), detalhe: [a.msg, b.msg, c.msg].filter(Boolean).join(' | ').slice(0, 140) };
});

await cfg('app_pin_servidor', 'sim');

// ---- trava ligada
await caso('LIGADA, sem aparelho: chat_iniciar, chat_enviar, chat_responder, chat_nova_conversa e chat_irmao_iniciar são recusados com "pin_obrigatorio"', async () => {
  const r = [await chamar(INICIAR), await chamar(...ENVIAR(conv), { caminho: '/rpc/chat_enviar' }), await chamar(...RESPONDER(conv), { caminho: '/rpc/chat_responder' }),
    await chamar(...NOVA(conv), { caminho: '/rpc/chat_nova_conversa' }), await chamar(...IRMAO(conv), { caminho: '/rpc/chat_irmao_iniciar' })];
  return { ok: r.every(recusou), detalhe: r.map((x) => (recusou(x) ? 'recusou' : x.ok ? 'PASSOU' : x.msg.slice(0, 40))).join(' | ') };
});
await caso('LIGADA, com o aparelho do cadastro e PIN dos últimos 30 minutos: as chamadas passam (e não são recusadas pelo PIN)', async () => {
  await novaLimpa();
  const cab = { 'x-acesso': TOK };
  const a = await chamar(INICIAR, [], { cab }); await novaLimpa();
  const b = await chamar(...ENVIAR(conv), { cab, caminho: '/rpc/chat_enviar' });
  const c = await chamar(...RESPONDER(conv), { cab, caminho: '/rpc/chat_responder' });
  return { ok: a.ok && !recusou(b) && !recusou(c), detalhe: [a.ok, b.ok, c.ok, b.msg, c.msg].filter((x) => x !== undefined).join(' | ').slice(0, 160) };
});
await caso('LIGADA, PIN vencido (passou dos 30 minutos): recusa; código de aparelho desconhecido ou vazio: recusa', async () => {
  await db.query(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
  const vencido = await chamar(INICIAR, [], { cab: { 'x-acesso': TOK } });
  const falso = await chamar(INICIAR, [], { cab: { 'x-acesso': 'codigo-que-nao-existe' } });
  const vazio = await chamar(INICIAR, [], { cab: { 'x-acesso': '   ' } });
  await db.query(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
  return { ok: recusou(vencido) && recusou(falso) && recusou(vazio), detalhe: [vencido, falso, vazio].map((x) => (recusou(x) ? 'recusou' : 'PASSOU')).join(' | ') };
});
await caso('cada chamada aceita renova os 30 minutos do PIN (quem está usando o chat não é derrubado)', async () => {
  await db.query(`update public.app_aparelho set desbloqueada_ate = now() + interval '2 minutes'`); await novaLimpa();
  await chamar(...ENVIAR(conv), { cab: { 'x-acesso': TOK }, caminho: '/rpc/chat_enviar' });
  const m = Number((await um(`select extract(epoch from (desbloqueada_ate - now())) / 60 as min from public.app_aparelho`)).min);
  return { ok: m > 25, detalhe: `${m.toFixed(1)} min` };
});
await caso('o cabeçalho do aparelho não vale de outra pessoa: sem o código certo nenhuma chamada passa (código com letra trocada)', async () => {
  const r = await chamar(INICIAR, [], { cab: { 'x-acesso': TOK.slice(0, -1) + (TOK.endsWith('a') ? 'b' : 'a') } });
  return { ok: recusou(r), detalhe: r.msg ? r.msg.slice(0, 50) : 'PASSOU' };
});
await caso('exceções que NÃO são recusadas: service_role, rotina do banco (sem requisição HTTP) e funções app_* (que já conferem o PIN)', async () => {
  await novaLimpa();
  const srv = await chamar(INICIAR, [], { papel: 'service_role' }); await novaLimpa();
  const interna = await chamar(INICIAR, [], { semHttp: true }); await novaLimpa();
  const viaApp = await chamar(INICIAR, [], { caminho: '/rpc/app_pedido_acao' });
  return { ok: !recusou(srv) && !recusou(interna) && !recusou(viaApp), detalhe: [srv.msg, interna.msg, viaApp.msg].filter(Boolean).join(' | ').slice(0, 140) };
});
await caso('desligar o PIN obrigatório, o acesso rápido ou a trava do servidor libera na hora', async () => {
  const resultado = [];
  for (const [chave, valor] of [['app_pin_obrigatorio', 'nao'], ['app_acesso_modo', 'nao'], ['app_pin_servidor', 'nao']]) {
    const volta = (await um(`select valor from public.config where chave = $1`, [chave])).valor;
    await cfg(chave, valor); await novaLimpa(); resultado.push(!recusou(await chamar(INICIAR))); await cfg(chave, volta);
  }
  return { ok: resultado.every(Boolean), detalhe: resultado.join(',') };
});
await caso('a função da trava não pode ser chamada pelo público (só por dentro do banco)', async () => {
  await anonimo(); let negou = false; try { await q(`select public.app_pin_exigir()`); } catch (e) { negou = /permission denied/.test(e.message); } finally { await db.exec('reset role'); }
  return { ok: negou };
});

console.log(`\n${resultados.filter(Boolean).length}/${resultados.length} casos passaram`);
process.exit(resultados.every(Boolean) ? 0 : 1);
