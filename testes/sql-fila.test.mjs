// FLUXOGRAMA: entrada (fila-biometria.sql aplicado sobre stubs do Supabase e helpers reais do repositório) -> validação (SET ROLE + claims + cabeçalhos por cenário) -> lógica (token, RLS, RPCs da recepção, do n8n e do paciente, 3 tentativas, imutabilidade, broadcast) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
import { readFileSync } from 'node:fs';
import { criarBanco, REPO } from './stubs-supabase.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const SEG_JWT = 'segredo-jwt-de-teste-com-mais-de-32-caracteres-aaaa';
const SEG_N8N = 'segredo-n8n-de-teste-bbbbbbbbbbbbbbbbbbbbbbbb';
const db = await criarBanco({ segJwt: SEG_JWT, segN8n: SEG_N8N });
const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push({ nome, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const afirmar = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe ?? ''); } catch (e) { registrar(nome, false, `exceção: ${e.message}`); } };
const erroDe = async (fn) => { try { await fn(); return null; } catch (e) { return e.message ?? String(e); } };

async function como(role, { claims = {}, headers = {} } = {}, fn) {
  await db.exec(`set role ${role}`);
  await db.query(`select set_config('request.jwt.claims', $1, false), set_config('request.headers', $2, false)`, [JSON.stringify(claims), JSON.stringify(headers)]);
  try { return await fn(); } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '', false), set_config('request.headers', '', false)`);
  }
}
const N8N = { headers: { 'x-fila-segredo': SEG_N8N } };
const rpc = (nome, ...args) => db.query(`select public.${nome}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args).then((x) => x.rows[0].r);

// ---------- aplica o módulo (duas vezes: idempotência) ----------
const modulo = readFileSync(`${REPO}/supabase/fila-biometria.sql`, 'utf8');
await db.exec(modulo);
registrar('módulo aplica sobre o esquema base', true);
const segunda = await erroDe(() => db.exec(modulo));
registrar('módulo é idempotente (segunda aplicação sem erro)', segunda === null, segunda ?? '');

const STAFF = '11111111-1111-4111-8111-111111111111';
const SEMPAPEL = '22222222-2222-4222-8222-222222222222';
await db.exec(`insert into public.agentes (id, papel, ativo) values ('${STAFF}', 'atendente', true), ('${SEMPAPEL}', 'marketing', true)`);
const staff = { claims: { sub: STAFF, role: 'authenticated' } };

// ---------- recepção ----------
await afirmar('anon não entra na fila', async () => {
  const e = await como('anon', {}, () => erroDe(() => rpc('fila_entrar', 'Maria da Silva', 'maria@exemplo.com', null)));
  return { ok: e !== null && /permission denied/i.test(e), detalhe: e };
});
await afirmar('usuário sem papel de atendimento não entra na fila', async () => {
  const e = await como('authenticated', { claims: { sub: SEMPAPEL } }, () => erroDe(() => rpc('fila_entrar', 'Maria da Silva', 'maria@exemplo.com', null)));
  return { ok: e !== null && /Sem permissão/.test(e), detalhe: e };
});
await afirmar('e-mail inválido e nome curto são recusados', async () => {
  const e1 = await como('authenticated', staff, () => erroDe(() => rpc('fila_entrar', 'Maria da Silva', 'sem-arroba', null)));
  const e2 = await como('authenticated', staff, () => erroDe(() => rpc('fila_entrar', 'Jo', 'jo@exemplo.com', null)));
  return { ok: /E-mail inválido/.test(e1 ?? '') && /nome completo/.test(e2 ?? ''), detalhe: `${e1} | ${e2}` };
});

await afirmar('sem fila_webhook_url: entrar na fila informa link_agendado=false e reenviar falha com mensagem clara', async () => {
  const r = await como('authenticated', staff, () => rpc('fila_entrar', 'Teste Sem Webhook', 'sem.webhook@exemplo.com', null));
  const e = await como('authenticated', staff, () => erroDe(() => rpc('fila_reenviar_link', r.atendimento_id)));
  const n = (await db.query(`select count(*)::int as n from net.chamadas`)).rows[0].n;
  await db.query(`update public.atendimentos set status = 'assinatura_pendente', documento_texto = 'x', documento_hash = repeat('a',64) where id = $1`, [r.atendimento_id]).catch(() => {});
  await db.query(`delete from public.atendimentos where id = $1`, [r.atendimento_id]);
  await db.query(`delete from public.pacientes where id = $1`, [r.paciente_id]);
  return { ok: r.link_agendado === false && /ainda não está configurado/.test(e ?? '') && n === 0, detalhe: `link_agendado=${r.link_agendado} chamadas=${n}` };
});
await db.exec(`insert into public.config (chave, valor) values ('fila_webhook_url', 'https://n8n.exemplo/webhook/fila-emitir-link')`);
let A1, A2, P1;
await afirmar('recepção coloca paciente na fila e o webhook do n8n recebe o payload do enunciado', async () => {
  const r = await como('authenticated', staff, () => rpc('fila_entrar', 'Maria da Silva', ' Maria@Exemplo.com ', '(71) 98871-0544'));
  A1 = r.atendimento_id; P1 = r.paciente_id;
  if (r.link_agendado !== true) throw new Error('link_agendado deveria ser true com a URL configurada');
  const c = (await db.query(`select url, body from net.chamadas order by 1 limit 1`)).rows[0];
  const chaves = Object.keys(c.body).sort().join(',');
  return { ok: Boolean(A1) && chaves === 'atendimento_uuid,email_informado,nome,paciente_id'
    && c.body.email_informado === 'maria@exemplo.com' && c.body.atendimento_uuid === A1 && c.url.endsWith('fila-emitir-link'), detalhe: chaves };
});
await afirmar('paciente criado com telefone normalizado e e-mail em minúsculas (email_cadastro gerado)', async () => {
  const r = (await db.query(`select telefones, email, email_cadastro, nome_norm from public.pacientes where id = $1`, [P1])).rows[0];
  return { ok: r.telefones[0] === '7188710544' && r.email === 'maria@exemplo.com' && r.email_cadastro === 'maria@exemplo.com', detalhe: JSON.stringify(r) };
});
await afirmar('mesma pessoa não entra duas vezes na fila aberta', async () => {
  const e = await como('authenticated', staff, () => erroDe(() => rpc('fila_entrar', 'Maria da Silva', 'maria@exemplo.com', null)));
  return { ok: /já está na fila/.test(e ?? ''), detalhe: e };
});
await afirmar('segundo paciente entra e fica atrás do primeiro', async () => {
  A2 = (await como('authenticated', staff, () => rpc('fila_entrar', 'João Pereira Souza', 'joao@exemplo.com', null))).atendimento_id;
  return { ok: Boolean(A2) };
});

// ---------- token: assinado no banco, verificado no banco ----------
let T1;
await afirmar('fila_emitir_token recusa segredo errado ou ausente no cabeçalho', async () => {
  const errado = await como('anon', { headers: { 'x-fila-segredo': 'errado' } }, () => erroDe(() => rpc('fila_emitir_token', A1)));
  const ausente = await como('anon', {}, () => erroDe(() => rpc('fila_emitir_token', A1)));
  return { ok: /Não autorizado/.test(errado ?? '') && /Não autorizado/.test(ausente ?? ''), detalhe: `${errado} | ${ausente}` };
});
await afirmar('fila_emitir_token (segredo certo) devolve JWT com o payload do enunciado e conta o envio', async () => {
  const r = await como('anon', N8N, () => rpc('fila_emitir_token', A1));
  T1 = r.token;
  const [, p] = T1.split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const n = (await db.query(`select links_enviados from public.atendimentos where id = $1`, [A1])).rows[0].links_enviados;
  return { ok: r.ok && claims.atendimento_id === A1 && claims.email_informado === 'maria@exemplo.com'
    && claims.exp - claims.iat === 14400 && r.nome === 'Maria da Silva' && n === 1, detalhe: `exp-iat=${claims.exp - claims.iat}` };
});
await afirmar('token assinado no SQL é aceito pelo PyJWT (HS256 padrão)', async () => {
  let saida;
  try {
    saida = execFileSync('python3', ['-c', `
import jwt, sys
c = jwt.decode(sys.argv[1], sys.argv[2], algorithms=['HS256'], audience='fila', options={'require': ['exp','aud']})
print(c['atendimento_id'], c['email_informado'])
`, T1, SEG_JWT], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (e) {
    if (/No module named 'jwt'|ENOENT/.test(String(e.stderr ?? e.message))) return { ok: true, detalhe: 'PULADO: instale PyJWT (pip install pyjwt) para conferir' };
    throw e;
  }
  return { ok: saida === `${A1} maria@exemplo.com`, detalhe: saida };
});
await afirmar('fila_estado mostra posição 0 e o total, sem dado de outros', async () => {
  const r = await como('anon', {}, () => rpc('fila_estado', T1));
  return { ok: r.ok && r.status === 'aguardando' && r.a_frente === 0 && r.aguardando === 2 && !('email' in r) && r.documento === null, detalhe: JSON.stringify(r) };
});
const T2 = (await como('anon', N8N, () => rpc('fila_emitir_token', A2))).token;
await afirmar('segundo da fila tem 1 à frente', async () => {
  const r = await como('anon', {}, () => rpc('fila_estado', T2));
  return { ok: r.a_frente === 1, detalhe: JSON.stringify(r) };
});
await afirmar('token adulterado, truncado, com alg none ou lixo é recusado', async () => {
  const [h, p, s] = T1.split('.');
  const pAlt = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), atendimento_id: A2 })).toString('base64url');
  const hNone = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url');
  const casos = [`${h}.${pAlt}.${s}`, `${h}.${p}.${s.slice(0, -2)}xx`, `${hNone}.${p}.`, `${h}.${p}`, 'lixo', ''];
  const todos = [];
  for (const c of casos) todos.push((await como('anon', {}, () => rpc('fila_estado', c))).erro === 'token_invalido');
  return { ok: todos.every(Boolean), detalhe: todos.join(',') };
});
await afirmar('token expirado e token de outra audiência são recusados', async () => {
  const agora = Math.floor(Date.now() / 1000);
  const exp = (await db.query(`select public.fila_jwt_assinar(jsonb_build_object('aud','fila','atendimento_id',$1::text,'email_informado','a@b.com','exp',$2::bigint)) as t`, [A1, agora - 10])).rows[0].t;
  const aud = (await db.query(`select public.fila_jwt_assinar(jsonb_build_object('aud','outra','atendimento_id',$1::text,'email_informado','a@b.com','exp',$2::bigint)) as t`, [A1, agora + 999])).rows[0].t;
  const r1 = await como('anon', {}, () => rpc('fila_estado', exp));
  const r2 = await como('anon', {}, () => rpc('fila_estado', aud));
  return { ok: r1.erro === 'token_invalido' && r2.erro === 'token_invalido' };
});
await afirmar('sem o segredo no Vault, ninguém passa (falha fechada)', async () => {
  await db.exec(`update vault.secrets_tbl set name = 'fila_jwt_secret_off' where name = 'fila_jwt_secret'`);
  const r = await como('anon', {}, () => rpc('fila_estado', T1));
  await db.exec(`update vault.secrets_tbl set name = 'fila_jwt_secret' where name = 'fila_jwt_secret_off'`);
  const ok2 = (await como('anon', {}, () => rpc('fila_estado', T1))).ok;
  return { ok: r.erro === 'token_invalido' && ok2 === true };
});
await afirmar('anon não lê o Vault nem as funções internas', async () => {
  const e1 = await como('anon', {}, () => erroDe(() => db.query(`select * from vault.decrypted_secrets`)));
  const e2 = await como('anon', {}, () => erroDe(() => db.query(`select public.fila_segredo_vault('fila_segredo')`)));
  const e3 = await como('anon', {}, () => erroDe(() => db.query(`select public.fila_jwt_assinar('{}'::jsonb)`)));
  return { ok: [e1, e2, e3].every((e) => e && /permission denied/i.test(e)), detalhe: [e1, e2, e3].map((e) => (e ?? 'ok').slice(0, 40)).join(' | ') };
});

// ---------- RLS por token no cabeçalho (x-fila-token) ----------
await afirmar('REST direto: anon com o token no cabeçalho vê só a própria linha', async () => {
  const r = await como('anon', { headers: { 'x-fila-token': T1 } }, () => db.query(`select id from public.atendimentos`));
  return { ok: r.rows.length === 1 && r.rows[0].id === A1, detalhe: `linhas=${r.rows.length}` };
});
await afirmar('REST direto: sem cabeçalho, cabeçalho inválido ou de outro paciente não vê a fila', async () => {
  const a = await como('anon', {}, () => db.query(`select id from public.atendimentos`));
  const b = await como('anon', { headers: { 'x-fila-token': 'lixo' } }, () => db.query(`select id from public.atendimentos`));
  const c = await como('anon', { headers: { 'x-fila-token': T2 } }, () => db.query(`select id from public.atendimentos`));
  return { ok: a.rows.length === 0 && b.rows.length === 0 && c.rows.length === 1 && c.rows[0].id === A2 };
});
await afirmar('REST direto: anon não lê email_informado nem paciente_id', async () => {
  const e = await como('anon', { headers: { 'x-fila-token': T1 } }, () => erroDe(() => db.query(`select email_informado from public.atendimentos`)));
  const e2 = await como('anon', { headers: { 'x-fila-token': T1 } }, () => erroDe(() => db.query(`select paciente_id from public.atendimentos`)));
  return { ok: /permission denied/i.test(e ?? '') && /permission denied/i.test(e2 ?? '') };
});
await afirmar('anon não escreve em atendimentos nem lê registro e tentativas', async () => {
  const e = await como('anon', { headers: { 'x-fila-token': T1 } }, () => erroDe(() => db.query(`update public.atendimentos set status = 'concluido'`)));
  const r = await como('anon', {}, () => erroDe(() => db.query(`select id from public.registro_assinaturas`)));
  return { ok: /permission denied/i.test(e ?? '') && /permission denied/i.test(r ?? '') };
});

// ---------- máquina de estados ----------
const TEXTO = 'Autorizo o tratamento dos meus dados conforme o termo de consentimento.';
const HASH = createHash('sha256').update(TEXTO, 'utf8').digest('hex');
await afirmar('recepção envia o documento: hash calculado no banco bate com o SHA-256 do front', async () => {
  await como('authenticated', staff, () => rpc('fila_chamar_assinatura', A1, TEXTO));
  const r = (await db.query(`select status, documento_hash from public.atendimentos where id = $1`, [A1])).rows[0];
  return { ok: r.status === 'assinatura_pendente' && r.documento_hash === HASH };
});
await afirmar('paciente em assinatura recebe o texto do documento por fila_estado', async () => {
  const r = await como('anon', {}, () => rpc('fila_estado', T1));
  return { ok: r.status === 'assinatura_pendente' && r.documento === TEXTO && r.a_frente === null && r.tentativas_restantes === 3 };
});
await afirmar('transições fora da máquina de estados falham (assinatura_pendente -> concluido)', async () => {
  const e = await erroDe(() => db.query(`update public.atendimentos set status = 'concluido' where id = $1`, [A1]));
  return { ok: /Transição de status não permitida/.test(e ?? ''), detalhe: e };
});
await afirmar('segundo atendimento: aguardando -> concluido direto também falha', async () => {
  const e = await erroDe(() => db.query(`update public.atendimentos set status = 'concluido' where id = $1`, [A2]));
  return { ok: /Transição de status não permitida/.test(e ?? '') };
});

// ---------- n8n: contexto e registro ----------
const PERFIL0 = {};
const pontos = Array.from({ length: 30 }, (_, i) => ({ x: i / 30, y: 0.5, timestamp: i * 16, pressao: 0.5, traco: 0 }));
const perfilN = (n) => ({ versao: 1, n, features: { velocidade_media: { media: 0.001, variancia: 0 } } });
const reg = (token, resultado, over = {}) => rpc('assinatura_registrar', token, over.hash ?? HASH, resultado, over.pontos ?? pontos, '10.0.0.1', 'UA-teste');
const como_n8n = (fn) => como('anon', N8N, fn);

await afirmar('assinatura_contexto recusa segredo errado e devolve erros sem lançar', async () => {
  const e = await como('anon', { headers: { 'x-fila-segredo': 'errado' } }, () => erroDe(() => rpc('assinatura_contexto', T1, HASH)));
  const t = await como_n8n(() => rpc('assinatura_contexto', 'lixo', HASH));
  const d = await como_n8n(() => rpc('assinatura_contexto', T1, 'f'.repeat(64)));
  const f = await como_n8n(() => rpc('assinatura_contexto', T2, HASH));
  return { ok: /Não autorizado/.test(e ?? '') && t.erro === 'token_invalido' && d.erro === 'documento_diferente' && f.erro === 'fora_de_assinatura', detalhe: `${t.erro}/${d.erro}/${f.erro}` };
});
await afirmar('assinatura_contexto (tudo certo) devolve perfil e falhas', async () => {
  const r = await como_n8n(() => rpc('assinatura_contexto', T1, HASH));
  return { ok: r.ok && r.tentativas_falhas === 0 && JSON.stringify(r.perfil) === '{}' };
});
await afirmar('registrar recusa resultados incoerentes (a decisão do Python é auditada pelo banco)', async () => {
  const base = { consentimento: true, perfil_n_base: 0, caracteristicas: {} };
  const casos = {
    semConsent: { ...base, consentimento: false, aprovado: true, tipo: 'enrolamento', score: null, perfil_novo: perfilN(1) },
    enrolComScore: { ...base, aprovado: true, tipo: 'enrolamento', score: 0.9, perfil_novo: perfilN(1) },
    perfilNovoErrado: { ...base, aprovado: true, tipo: 'enrolamento', score: null, perfil_novo: perfilN(5) },
    comparacaoSemPerfil: { ...base, aprovado: true, tipo: 'comparacao', score: 0.9, perfil_novo: perfilN(1) },
    tipoLixo: { ...base, aprovado: true, tipo: 'x', score: null, perfil_novo: perfilN(1) },
  };
  const saidas = {};
  for (const [k, v] of Object.entries(casos)) saidas[k] = (await como_n8n(() => reg(T1, v))).erro;
  const pontosCurtos = (await como_n8n(() => reg(T1, { ...base, aprovado: true, tipo: 'enrolamento', score: null, perfil_novo: perfilN(1) }, { pontos: pontos.slice(0, 5) }))).erro;
  const estado = (await db.query(`select status, tentativas_falhas from public.atendimentos where id = $1`, [A1])).rows[0];
  return { ok: Object.values(saidas).every((e) => e === 'resultado_invalido') && pontosCurtos === 'resultado_invalido' && estado.status === 'assinatura_pendente' && estado.tentativas_falhas === 0, detalhe: JSON.stringify(saidas) };
});
await afirmar('perfil_n_base desatualizado vira conflito e não conta tentativa', async () => {
  const r = await como_n8n(() => reg(T1, { consentimento: true, perfil_n_base: 3, aprovado: true, tipo: 'enrolamento', score: null, perfil_novo: perfilN(1), caracteristicas: {} }));
  const f = (await db.query(`select tentativas_falhas from public.atendimentos where id = $1`, [A1])).rows[0].tentativas_falhas;
  return { ok: r.erro === 'conflito' && f === 0 };
});
await afirmar('registrar com segredo errado ou ausente lança', async () => {
  const e1 = await como('anon', { headers: { 'x-fila-segredo': 'x' } }, () => erroDe(() => reg(T1, {})));
  const e2 = await como('anon', {}, () => erroDe(() => reg(T1, {})));
  return { ok: /Não autorizado/.test(e1 ?? '') && /Não autorizado/.test(e2 ?? '') };
});
await afirmar('enrolamento aprovado: perfil gravado, registro com o e-mail do TOKEN, status em_atendimento', async () => {
  const r = await como_n8n(() => reg(T1, { consentimento: true, perfil_n_base: 0, aprovado: true, tipo: 'enrolamento', score: null, perfil_novo: perfilN(1), caracteristicas: { duracao_ms: 464 } }));
  const x = (await db.query(`select a.status, p.perfil_biometrico_historico->>'n' as n, r.email_confirmado_transacao, r.tipo_validacao, r.score_similaridade, r.ip_origem, r.user_agent, jsonb_array_length(r.vetor_traco_bruto) as pts
                              from public.atendimentos a join public.pacientes p on p.id = a.paciente_id join public.registro_assinaturas r on r.atendimento_id = a.id where a.id = $1`, [A1])).rows[0];
  return { ok: r.ok && r.aprovado && x.status === 'em_atendimento' && x.n === '1' && x.email_confirmado_transacao === 'maria@exemplo.com'
    && x.tipo_validacao === 'enrolamento' && x.score_similaridade === null && x.ip_origem === '10.0.0.1' && x.user_agent === 'UA-teste' && x.pts === 30, detalhe: JSON.stringify(x) };
});
await afirmar('depois de assinar, nova tentativa com o mesmo token é recusada (fora_de_assinatura)', async () => {
  const r = await como_n8n(() => reg(T1, { consentimento: true, perfil_n_base: 1, aprovado: true, tipo: 'comparacao', score: 0.9, perfil_novo: perfilN(2), caracteristicas: {} }));
  return { ok: r.erro === 'fora_de_assinatura' };
});
await afirmar('registro_assinaturas é imutável (UPDATE, DELETE e TRUNCATE)', async () => {
  const e1 = await erroDe(() => db.exec(`update public.registro_assinaturas set score_similaridade = 0.5`));
  const e2 = await erroDe(() => db.exec(`delete from public.registro_assinaturas`));
  const e3 = await erroDe(() => db.exec(`truncate public.registro_assinaturas`));
  return { ok: [e1, e2, e3].every((e) => /imutável/.test(e ?? '')) };
});

// ---------- 3 tentativas: o banco conta e bloqueia ----------
await afirmar('três reprovações bloqueiam o atendimento; a quarta chamada é recusada', async () => {
  await como('authenticated', staff, () => rpc('fila_chamar_assinatura', A2, TEXTO));
  // A2 precisa de perfil com n>=1 para comparação: dá um perfil ao paciente dele
  const pid = (await db.query(`select paciente_id from public.atendimentos where id = $1`, [A2])).rows[0].paciente_id;
  await db.query(`update public.pacientes set perfil_biometrico_historico = $1 where id = $2`, [JSON.stringify(perfilN(2)), pid]);
  const falha = (n) => ({ consentimento: true, perfil_n_base: 2, aprovado: false, tipo: 'comparacao', score: 0.1234, caracteristicas: {} });
  const r1 = await como_n8n(() => reg(T2, falha(1)));
  const r2 = await como_n8n(() => reg(T2, falha(2)));
  const r3 = await como_n8n(() => reg(T2, falha(3)));
  const r4 = await como_n8n(() => reg(T2, falha(4)));
  const est = await como('anon', {}, () => rpc('fila_estado', T2));
  const tent = (await db.query(`select count(*)::int as n from public.assinatura_tentativas where atendimento_id = $1`, [A2])).rows[0].n;
  return { ok: r1.tentativas_restantes === 2 && !r1.bloqueado && r2.tentativas_restantes === 1 && r3.tentativas_restantes === 0 && r3.bloqueado === true
    && r4.erro === 'bloqueado' && est.bloqueado === true && est.documento === null && tent === 3, detalhe: JSON.stringify([r1, r2, r3, r4.erro]) };
});
await afirmar('banco rejeita "reprovada" com score >= 0,30 e "aprovada" com score < 0,30', async () => {
  await como('authenticated', staff, () => rpc('fila_cancelar_assinatura', A2));
  await como('authenticated', staff, () => rpc('fila_chamar_assinatura', A2, TEXTO));
  const a = await como_n8n(() => reg(T2, { consentimento: true, perfil_n_base: 2, aprovado: false, tipo: 'comparacao', score: 0.5, caracteristicas: {} }));
  const b = await como_n8n(() => reg(T2, { consentimento: true, perfil_n_base: 2, aprovado: true, tipo: 'comparacao', score: 0.29, perfil_novo: perfilN(3), caracteristicas: {} }));
  const c = await como_n8n(() => reg(T2, { consentimento: true, perfil_n_base: 2, aprovado: true, tipo: 'comparacao', score: 0.3, perfil_novo: perfilN(3), caracteristicas: {} }));
  return { ok: a.erro === 'resultado_invalido' && b.erro === 'resultado_invalido' && c.aprovado === true, detalhe: `${a.erro}/${b.erro}/${c.aprovado}` };
});
await afirmar('cancelar o envio desfaz o bloqueio e mantém a posição na fila', async () => {
  // A1 já foi atendido; testa com um terceiro paciente
  const A3 = (await como('authenticated', staff, () => rpc('fila_entrar', 'Carla Mendes Lima', 'carla@exemplo.com', null))).atendimento_id;
  const pos = async () => {
    const tok = (await como('anon', N8N, () => rpc('fila_emitir_token', A3))).token;
    return (await como('anon', {}, () => rpc('fila_estado', tok))).a_frente;
  };
  const antes = await pos();
  await como('authenticated', staff, () => rpc('fila_chamar_assinatura', A3, TEXTO));
  await como('authenticated', staff, () => rpc('fila_cancelar_assinatura', A3));
  const depois = await pos();
  return { ok: antes === depois && antes !== null, detalhe: `${antes}/${depois}` };
});

// ---------- lista da recepção e limites ----------
await afirmar('fila_listar traz nome e e-mail só para a equipe', async () => {
  const lista = await como('authenticated', staff, () => rpc('fila_listar'));
  const e = await como('anon', {}, () => erroDe(() => rpc('fila_listar')));
  return { ok: Array.isArray(lista) && lista.length >= 3 && lista[0].nome && /permission denied/i.test(e ?? ''), detalhe: `itens=${lista.length}` };
});
await afirmar('limite de 10 envios de link por atendimento', async () => {
  const A4 = (await como('authenticated', staff, () => rpc('fila_entrar', 'Pedro Alves Costa', 'pedro@exemplo.com', null))).atendimento_id;
  let ultimo;
  for (let i = 0; i < 11; i++) ultimo = await como('anon', N8N, () => rpc('fila_emitir_token', A4));
  return { ok: ultimo.erro === 'limite_de_envios' };
});
await afirmar('atendimento concluído não recebe novo link', async () => {
  await como('authenticated', staff, () => rpc('fila_concluir', A1));
  const r = await como('anon', N8N, () => rpc('fila_emitir_token', A1));
  return { ok: r.erro === 'fora_da_fila' };
});
await afirmar('quem concluiu pode voltar à fila numa nova visita', async () => {
  const r = await como('authenticated', staff, () => rpc('fila_entrar', 'Maria da Silva', 'maria@exemplo.com', null));
  return { ok: Boolean(r.atendimento_id) && r.paciente_id === P1, detalhe: 'mesmo paciente reaproveitado' };
});

// ---------- privilégios de coluna da biometria e broadcast ----------
await afirmar('equipe não lê nem altera perfil_biometrico_historico; lê o resto de pacientes', async () => {
  const e1 = await como('authenticated', staff, () => erroDe(() => db.query(`select perfil_biometrico_historico from public.pacientes`)));
  const e2 = await como('authenticated', staff, () => erroDe(() => db.query(`update public.pacientes set perfil_biometrico_historico = '{}'`)));
  const ok = await como('authenticated', staff, () => db.query(`select nome, email_cadastro from public.pacientes limit 1`));
  return { ok: /permission denied/i.test(e1 ?? '') && /permission denied/i.test(e2 ?? '') && ok.rows.length === 1 };
});
await afirmar('broadcast: fila:global e atendimento:<id> levam só status, nunca nome ou e-mail', async () => {
  const msgs = (await db.query(`select topic, event, payload::text as p from realtime.messages`)).rows;
  const globais = msgs.filter((m) => m.topic === 'fila:global').length;
  const porAtend = msgs.filter((m) => m.topic.startsWith('atendimento:') && m.event === 'status').length;
  const vaza = msgs.some((m) => /@|Maria|João/.test(m.p));
  return { ok: globais > 0 && porAtend > 0 && !vaza, detalhe: `globais=${globais} status=${porAtend} vaza=${vaza}` };
});
await afirmar('policy de realtime.messages: anon recebe fila:global e atendimento:*, mas não outro tópico', async () => {
  const ler = async (topico) => como('anon', {}, async () => {
    await db.query(`select set_config('realtime.topic', $1, false)`, [topico]);
    return (await db.query(`select id from realtime.messages where topic = realtime.topic()`)).rows.length;
  });
  const a = await ler('fila:global');
  const b = await ler(`atendimento:${A1}`);
  const c = await ler('qualquer:outro');
  return { ok: a > 0 && b > 0 && c === 0, detalhe: `${a}/${b}/${c}` };
});
await afirmar('funções do n8n e do paciente: anon executa; funções da recepção e internas não', async () => {
  const q = async (assinatura) => (await db.query(`select has_function_privilege('anon', '${assinatura}', 'execute') as p`)).rows[0].p;
  const permitidas = [await q('public.fila_estado(text)'), await q('public.fila_emitir_token(uuid)'), await q('public.assinatura_contexto(text,text)')];
  const negadas = [await q('public.fila_entrar(text,text,text)'), await q('public.fila_listar()'), await q('public.fila_jwt_assinar(jsonb)'), await q('public.fila_segredo_vault(text)'), await q('public.fila_avisar_n8n(uuid)'), await q('public.fila_n8n_autorizado()'), await q('public.fila_segredo_do_cabecalho()')];
  return { ok: permitidas.every(Boolean) && negadas.every((x) => x === false), detalhe: `${permitidas}|${negadas}` };
});

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações passaram`);
await db.close();
process.exit(falhas.length ? 1 : 0);
