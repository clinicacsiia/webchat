// FLUXOGRAMA: entrada (contas-paciente + protecao-identidade + login-paciente + vincular-cadastro.sql num Postgres embutido com stubs mínimos do Auth) -> validação (aplica duas vezes; só conta de paciente logada chama; e-mail confirmado; limite de 5 tentativas por hora; só a equipe lista e decide) -> lógica (nome completo + nascimento obrigatórios; 4 acertos liga sozinho, 3 acertos liga e avisa o atendente, só nome + nascimento vai para o atendente decidir; o atendente vincula, atualiza ou recusa) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.1 — 31/10/2026 / Mudança: regra de 3 acertos e fila do atendente
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { REPO, funcao } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };
const arq = (n) => readFileSync(`${REPO}/supabase/${n}`, 'utf8');
const ARQUIVOS = ['contas-paciente.sql', 'protecao-identidade.sql', 'login-paciente.sql', 'vincular-cadastro.sql'];

async function banco() {
  const db = new PGlite();
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
    create schema extensions;
    create function extensions.unaccent(t text) returns text language sql immutable as $$
      select translate(t, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC') $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.jwt(), auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    create table public.agentes (id uuid primary key references auth.users(id) on delete cascade, nome text not null, email text,
      papel text not null default 'atendente' check (papel in ('admin','atendente','marketing')), ativo boolean not null default false, criado_em timestamptz not null default now());
    create table public.config (chave text primary key, valor text not null default '');
    create table public.contatos (id uuid primary key default gen_random_uuid(), nome text, telefone text, email text);
    create table public.conversas (id uuid primary key default gen_random_uuid(), contato_id uuid references public.contatos(id),
      nome_informado text, email_informado text, paciente_tipo text not null default 'proprio', paciente_nome text);
    create table public.pacientes (
      id uuid primary key default gen_random_uuid(), nome text not null, nome_norm text not null default '',
      telefones text[] not null default '{}', email text, dt_nasc date, cpf text, dados jsonb not null default '{}'::jsonb,
      validado boolean not null default false, revisar boolean not null default false, origem_conversa uuid references public.conversas(id) on delete set null,
      criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now(), ultima_visita_em timestamptz not null default now());
    create table public.pre_agendamentos (conversa_id uuid primary key references public.conversas(id) on delete cascade, paciente jsonb default '{}'::jsonb,
      paciente_id uuid references public.pacientes(id) on delete set null);
    ${funcao('00-base-snapshot.sql', 'papel_atual')}
    ${funcao('00-base-snapshot.sql', 'novo_usuario')}
    create trigger on_auth_user_created after insert on auth.users for each row execute function public.novo_usuario();
    ${['norm_nome', 'fone_chave', 'data_ou_nula', 'nome_confere'].map((n) => funcao('pacientes.sql', n)).join('\n')}
  `);
  return db;
}

const db = await banco();
const como = async (papel, uid, fn) => {
  await db.exec(`set request.jwt.claims = '${uid ? JSON.stringify({ sub: uid }) : ''}'; set role ${papel}`);
  try { return await fn(); } finally { await db.exec('reset role; reset request.jwt.claims'); }
};
const q = async (sql, p = []) => (await db.query(sql, p)).rows;

await caso('os quatro arquivos aplicam em ordem e podem ser aplicados de novo', async () => {
  for (let i = 0; i < 2; i++) for (const a of ARQUIVOS) await db.exec(arq(a));
  await db.exec(`update public.config set valor = 'nao' where chave = 'cadastro_equipe_sem_convite'`);
  return { ok: true, detalhe: '4 arquivos x 2 aplicações' };
});

const ADM = (await q(`insert into auth.users (email) values ('primeiro@clinica.test') returning id`))[0].id;   // primeiro usuário: administrador
await q(`update public.config set valor = 'sim' where chave = 'cadastro_equipe_sem_convite'`);
const EQUIPE = (await q(`insert into auth.users (email) values ('equipe@clinica.test') returning id`))[0].id;   // vira agente (inativo) pelo caminho de transição
await q(`update public.config set valor = 'nao' where chave = 'cadastro_equipe_sem_convite'`);

// cada caso começa sem cadastros de paciente (todos usam o mesmo nome e a mesma data; sem isso um atrapalharia o outro)
const casoL = (nome, fn) => caso(nome, async () => { await q('delete from public.pacientes'); return fn(); });
let n = 0;
const conta = async ({ email, nome = 'Maria da Silva', tel = '71988710544', nasc = '1980-03-25', confirmado = true } = {}) => {
  email = email ?? `maria${++n}@exemplo.com`;
  const meta = JSON.stringify({ nome, telefone: tel, ...(nasc ? { dt_nasc: nasc } : {}) });
  const id = (await q(`insert into auth.users (email, email_confirmed_at, raw_user_meta_data) values ($1, ${confirmado ? 'now()' : 'null'}, $2::jsonb) returning id`, [email, meta]))[0].id;
  return { id, email };
};
const paciente = async ({ nome = 'Maria da Silva', tels = ['7188710544'], email = null, nasc = '1980-03-25', revisar = false } = {}) =>
  (await q(`insert into public.pacientes (nome, telefones, email, dt_nasc, revisar) values ($1, $2, $3, $4, $5) returning id`, [nome, tels, email, nasc, revisar]))[0].id;
const vincular = (uid) => como('authenticated', uid, async () => (await q(`select public.conta_paciente_vincular() r`))[0].r.resultado);
const ligado = async (uid) => (await q(`select paciente_id from public.contas_paciente where id = $1`, [uid]))[0].paciente_id;
const nascNoLogin = async (uid) => (await q(`select raw_user_meta_data ->> 'dt_nasc' v from auth.users where id = $1`, [uid]))[0].v;
const aviso = async (uid) => (await q(`select tipo, status, batem, diferem from public.vinculo_solicitacoes where conta_id = $1`, [uid]))[0] ?? null;
const idAviso = async (uid) => (await q(`select id from public.vinculo_solicitacoes where conta_id = $1`, [uid]))[0].id;
// atendente ativo (EQUIPE vira agente inativo pelo caminho de transição; aqui é liberado)
await q(`update public.agentes set ativo = true, papel = 'atendente' where id = $1`, [EQUIPE]);
const PACIENTE_X = (await q(`insert into auth.users (email) values ('paciente.x@exemplo.com') returning id`))[0].id;
const listar = (uid) => como('authenticated', uid, async () => (await q(`select public.vinculo_listar() r`))[0].r);
const decidir = (uid, id, acao) => como('authenticated', uid, async () => (await q(`select public.vinculo_decidir($1, $2) r`, [id, acao]))[0].r);

// ---- 4 acertos: nome, nascimento, telefone, e-mail ----
await casoL('4 acertos: liga sozinho, sem aviso para o atendente; apaga a data digitada', async () => {
  const c = await conta(), p = await paciente({ email: c.email });
  const r = await vincular(c.id);
  return { ok: r === 'vinculado' && (await ligado(c.id)) === p && (await aviso(c.id)) === null && (await nascNoLogin(c.id)) === null, detalhe: r };
});
await casoL('aceita variações reais: telefone com 9º dígito e 55, nome mais curto, e-mail em outra caixa', async () => {
  const c = await conta({ email: 'Joana.Lima@Exemplo.com', nome: 'Joana Lima', tel: '5571988710544' }), p = await paciente({ nome: 'Joana Souza de Lima', email: 'joana.lima@exemplo.com', tels: ['7188710544'] });
  return { ok: (await vincular(c.id)) === 'vinculado' && (await ligado(c.id)) === p };
});
await casoL('depois de ligada, a conversa da conta é reconhecida como paciente conhecido (paciente_conferir)', async () => {
  const c = await conta(), p = await paciente({ email: c.email });
  await vincular(c.id);
  const cv = await como('authenticated', c.id, async () => {
    const ct = (await q(`insert into public.contatos (nome, telefone, email) values ('Maria', '71988710544', $1) returning id`, [c.email]))[0].id;
    return (await q(`insert into public.conversas (contato_id, paciente_tipo) values ($1, 'proprio') returning id`, [ct]))[0].id;
  });
  const r = (await q(`select public.paciente_conferir($1) r`, [cv]))[0].r;
  return { ok: r.situacao === 'completo' && r.conta === true && r.paciente_id === p, detalhe: JSON.stringify(r.batem) };
});

// ---- 3 acertos: liga sozinho e avisa o atendente ----
await casoL('3 acertos (e-mail diferente): liga sozinho e abre aviso "atualizar" dizendo que o e-mail difere', async () => {
  const c = await conta(), p = await paciente({ email: 'email.antigo@exemplo.com' });
  const r = await vincular(c.id), a = await aviso(c.id);
  return { ok: r === 'vinculado_conferir' && (await ligado(c.id)) === p && a.tipo === 'atualizar' && a.status === 'aberta' && a.diferem.join() === 'email' && a.batem.join() === 'nome,nascimento,telefone', detalhe: JSON.stringify(a) };
});
await casoL('3 acertos (telefone diferente): liga sozinho e o aviso diz que o telefone difere', async () => {
  const c = await conta({ tel: '71977776666' }), p = await paciente({ email: 'tel.diferente@exemplo.com' });
  await q(`update public.pacientes set email = $1 where id = $2`, [c.email, p]);
  const r = await vincular(c.id), a = await aviso(c.id);
  return { ok: r === 'vinculado_conferir' && (await ligado(c.id)) === p && a.diferem.join() === 'telefone' && a.batem.join() === 'nome,nascimento,email', detalhe: JSON.stringify(a) };
});
await casoL('3 acertos com cadastro SEM e-mail: liga (nome, nascimento, telefone) e avisa para preencher o e-mail', async () => {
  const c = await conta(), p = await paciente({ email: null });
  const r = await vincular(c.id), a = await aviso(c.id);
  return { ok: r === 'vinculado_conferir' && (await ligado(c.id)) === p && a.diferem.join() === 'email', detalhe: JSON.stringify(a) };
});

// ---- só nome + nascimento: o atendente decide ----
await casoL('só nome + nascimento (telefone e e-mail diferem): NÃO liga; abre pedido "verificar" para o atendente', async () => {
  const c = await conta({ tel: '71977776666' }), p = await paciente({ email: 'outro@exemplo.com' });
  const r = await vincular(c.id), a = await aviso(c.id);
  return { ok: r === 'em_analise' && (await ligado(c.id)) === null && a.tipo === 'verificar' && a.status === 'aberta' && a.diferem.join() === 'telefone,email', detalhe: JSON.stringify(a) };
});

// ---- obrigatórios: nome completo e nascimento ----
const naoLiga = async (nome, conta_, cad) => casoL(nome, async () => {
  const c = await conta(conta_); await paciente({ email: c.email, ...cad });
  const r = await vincular(c.id);
  return { ok: r === 'nao_encontrado' && (await ligado(c.id)) === null && (await aviso(c.id)) === null && (await nascNoLogin(c.id)) === null, detalhe: r };
});
await naoLiga('NÃO liga nem avisa: data de nascimento diferente (mesmo com telefone e e-mail iguais)', { nasc: '1980-03-26' }, {});
await naoLiga('NÃO liga nem avisa: nome diferente (mesmo com data, telefone e e-mail iguais)', { nome: 'Carla Pereira' }, {});
await naoLiga('NÃO liga nem avisa: nome incompleto (uma palavra só)', { nome: 'Maria' }, {});
await naoLiga('NÃO liga nem avisa: cadastro marcado para revisão', {}, { revisar: true });
await naoLiga('NÃO liga nem avisa: cadastro sem data de nascimento', {}, { nasc: null });
await casoL('NÃO liga nem avisa: telefone e e-mail iguais mas nome e nascimento não (ninguém passa só com contato)', async () => {
  const c = await conta({ nome: 'Pedro Alves', nasc: '1990-01-01' }); await paciente({ email: c.email });
  const r = await vincular(c.id);
  return { ok: r === 'nao_encontrado' && (await ligado(c.id)) === null && (await aviso(c.id)) === null, detalhe: r };
});
await casoL('NÃO liga nem avisa: cadastro já ligado a outra conta', async () => {
  const dono = await conta(), p = await paciente({ email: dono.email });
  await vincular(dono.id);
  const outro = await conta({ email: 'outro.' + dono.email });
  const r = await vincular(outro.id);
  return { ok: r === 'nao_encontrado' && (await ligado(outro.id)) === null && (await ligado(dono.id)) === p && (await aviso(outro.id)) === null, detalhe: r };
});
await casoL('NÃO liga: dois cadastros iguais (ambíguo)', async () => {
  const c = await conta(); await paciente({ email: c.email }); await paciente({ email: c.email });
  const r = await vincular(c.id);
  return { ok: r === 'nao_encontrado' && (await ligado(c.id)) === null && (await aviso(c.id)) === null, detalhe: r };
});
await casoL('a resposta traz só o resultado (nenhum dado do cadastro)', async () => {
  const c = await conta(); await paciente({ email: c.email });
  const r = await como('authenticated', c.id, async () => (await q(`select public.conta_paciente_vincular() r`))[0].r);
  return { ok: JSON.stringify(Object.keys(r)) === '["resultado"]', detalhe: JSON.stringify(r) };
});
await casoL('e-mail ainda não confirmado: não faz nada e guarda a data para quando confirmar', async () => {
  const c = await conta({ confirmado: false }), p = await paciente({ email: c.email });
  const r1 = await vincular(c.id), guardada = await nascNoLogin(c.id);
  await q(`update auth.users set email_confirmed_at = now() where id = $1`, [c.id]);
  const r2 = await vincular(c.id);
  return { ok: r1 === 'email_nao_confirmado' && guardada === '1980-03-25' && r2 === 'vinculado' && (await ligado(c.id)) === p, detalhe: `${r1} -> ${r2}` };
});
await casoL('sem data pendente: "nada_pendente"; já ligada: "ja_vinculado"', async () => {
  const c = await conta({ nasc: null }), a = await vincular(c.id);
  const d = await conta(), p = await paciente({ email: d.email }); await vincular(d.id);
  await q(`update auth.users set raw_user_meta_data = raw_user_meta_data || '{"dt_nasc":"1990-01-01"}'::jsonb where id = $1`, [d.id]);
  const b = await vincular(d.id);
  return { ok: a === 'nada_pendente' && b === 'ja_vinculado' && (await ligado(d.id)) === p, detalhe: `${a}, ${b}` };
});
await casoL('limite: depois de 5 tentativas na hora a 6ª é "bloqueado"; passada 1 hora volta a permitir', async () => {
  const c = await conta({ nasc: '1999-01-01' }); const p = await paciente({ email: c.email });
  const rs = [];
  for (let i = 0; i < 6; i++) {
    await q(`update auth.users set raw_user_meta_data = raw_user_meta_data || jsonb_build_object('dt_nasc', $2::text) where id = $1`, [c.id, `1970-03-${String(20 + i).padStart(2, '0')}`]);
    rs.push(await vincular(c.id));
  }
  await q(`update public.contas_paciente set vinculo_ultima_em = now() - interval '2 hours' where id = $1`, [c.id]);
  await q(`update auth.users set raw_user_meta_data = raw_user_meta_data || '{"dt_nasc":"1980-03-25"}'::jsonb where id = $1`, [c.id]);
  const depois = await vincular(c.id);
  return { ok: rs.slice(0, 5).every((x) => x === 'nao_encontrado') && rs[5] === 'bloqueado' && depois === 'vinculado' && (await ligado(c.id)) === p, detalhe: rs.join(',') + ' -> ' + depois };
});

// ---- fila do atendente ----
await casoL('só a equipe lista e decide; paciente e anônimo são recusados e a tabela é fechada', async () => {
  const falhas = [];
  for (const [papel, uid] of [['authenticated', PACIENTE_X], ['anon', null]]) await como(papel, uid, async () => {
    try { await q(`select public.vinculo_listar()`); falhas.push('listar ' + papel); } catch { /* esperado */ }
    try { await q(`select public.vinculo_decidir(1, 'recusar')`); falhas.push('decidir ' + papel); } catch { /* esperado */ }
  });
  await como('authenticated', PACIENTE_X, async () => { try { await q(`select * from public.vinculo_solicitacoes`); falhas.push('tabela aberta'); } catch { /* esperado */ } });
  return { ok: falhas.length === 0, detalhe: falhas.join(', ') || '5 recusas' };
});
await casoL('vinculo_listar traz o aviso com conta e cadastro lado a lado', async () => {
  const c = await conta({ tel: '71977776666' }); await paciente({ email: 'antigo@exemplo.com' });
  await vincular(c.id);
  const lista = await listar(EQUIPE), x = lista.find((i) => i.conta.email === c.email);
  return { ok: !!x && x.tipo === 'verificar' && x.cadastro.email === 'antigo@exemplo.com' && x.conta.telefone === '71977776666' && x.diferem.includes('telefone'), detalhe: x ? x.tipo : 'não achou' };
});
await casoL('pedido "verificar": atendente VINCULA (liga a conta, sem mexer no cadastro) e fica registrado quem decidiu', async () => {
  const c = await conta({ tel: '71977776666' }), p = await paciente({ email: 'antigo2@exemplo.com' });
  await vincular(c.id);
  const id = await idAviso(c.id);
  const r = await decidir(EQUIPE, id, 'vincular'), a = await aviso(c.id);
  const reg = (await q(`select decidido_por from public.vinculo_solicitacoes where id = $1`, [id]))[0];
  const cad = (await q(`select email, telefones from public.pacientes where id = $1`, [p]))[0];
  return { ok: r.status === 'vinculada' && (await ligado(c.id)) === p && a.status === 'vinculada' && reg.decidido_por === EQUIPE && cad.email === 'antigo2@exemplo.com' && cad.telefones.length === 1, detalhe: JSON.stringify(a) };
});
await casoL('pedido "verificar": atendente VINCULA E ATUALIZA (e-mail novo e telefone novo entram no cadastro)', async () => {
  const c = await conta({ tel: '71977776666' }), p = await paciente({ email: 'antigo3@exemplo.com' });
  await vincular(c.id);
  await decidir(EQUIPE, await idAviso(c.id), 'vincular_atualizar');
  const cad = (await q(`select email, telefones from public.pacientes where id = $1`, [p]))[0];
  return { ok: (await ligado(c.id)) === p && cad.email === c.email && cad.telefones.includes('7188710544') && cad.telefones.includes('7177776666'), detalhe: JSON.stringify(cad) };
});
await casoL('pedido "verificar": atendente RECUSA e a conta continua sem cadastro', async () => {
  const c = await conta({ tel: '71977776666' }); await paciente({ email: 'antigo4@exemplo.com' });
  await vincular(c.id);
  const r = await decidir(EQUIPE, await idAviso(c.id), 'recusar');
  return { ok: r.status === 'recusada' && (await ligado(c.id)) === null };
});
await casoL('aviso "atualizar" (3 acertos): ATUALIZAR corrige o cadastro e a conta continua ligada', async () => {
  const c = await conta(), p = await paciente({ email: 'velho@exemplo.com' });
  await vincular(c.id);
  const r = await decidir(EQUIPE, await idAviso(c.id), 'atualizar');
  const cad = (await q(`select email from public.pacientes where id = $1`, [p]))[0];
  return { ok: r.status === 'atualizada' && cad.email === c.email && (await ligado(c.id)) === p, detalhe: cad.email };
});
await casoL('aviso "atualizar": CONFERIDO só fecha o aviso (cadastro intacto); DESFAZER solta o vínculo', async () => {
  const c1 = await conta(), p1 = await paciente({ email: 'v1@exemplo.com' }), c2 = await conta({ nome: 'Ana Beatriz Lima', nasc: '1991-02-02' }); await paciente({ nome: 'Ana Beatriz Lima', nasc: '1991-02-02', email: 'v2@exemplo.com' });
  await vincular(c1.id); await vincular(c2.id);
  await decidir(EQUIPE, await idAviso(c1.id), 'conferido'); await decidir(EQUIPE, await idAviso(c2.id), 'desfazer');
  const e1 = (await q(`select email from public.pacientes where id = $1`, [p1]))[0].email;
  return { ok: (await ligado(c1.id)) === p1 && e1 === 'v1@exemplo.com' && (await ligado(c2.id)) === null && (await aviso(c2.id)).status === 'desfeita', detalhe: e1 };
});
await casoL('decisões inválidas: ação trocada de tipo, pedido já resolvido, ação desconhecida e cadastro tomado por outra conta', async () => {
  const erros = [];
  const tenta = async (id, acao) => { try { await decidir(EQUIPE, id, acao); return 'aceitou'; } catch { return 'recusou'; } };
  const c = await conta(); await paciente({ email: 'v5@exemplo.com' }); await vincular(c.id);   // aviso "atualizar"
  const id = await idAviso(c.id);
  erros.push(await tenta(id, 'vincular'));          // ação de "verificar" em aviso "atualizar"
  await decidir(EQUIPE, id, 'conferido');
  erros.push(await tenta(id, 'conferido'));         // já resolvido
  const c2 = await conta({ tel: '71977776666' }), p2 = await paciente({ email: 'v6@exemplo.com' }); await vincular(c2.id);
  const id2 = await idAviso(c2.id);
  erros.push(await tenta(id2, 'apagar-tudo'));      // desconhecida
  await q(`update public.contas_paciente set paciente_id = $1 where id = $2`, [p2, PACIENTE_X]);   // outra conta pegou o cadastro enquanto o pedido esperava
  erros.push(await tenta(id2, 'vincular'));
  return { ok: erros.every((e) => e === 'recusou'), detalhe: erros.join(',') };
});
await casoL('excluir a conta apaga o aviso junto (sem sobra de dado)', async () => {
  const c = await conta({ tel: '71977776666' }); await paciente({ email: 'v7@exemplo.com' }); await vincular(c.id);
  await q(`delete from auth.users where id = $1`, [c.id]);
  return { ok: (await aviso(c.id)) === null };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} casos passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
