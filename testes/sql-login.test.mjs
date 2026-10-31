// FLUXOGRAMA: entrada (contas-paciente.sql + protecao-identidade.sql + login-paciente.sql aplicados em ordem sobre o gatilho ORIGINAL, num Postgres embutido com stubs mínimos do Auth) -> validação (aplica tudo duas vezes; usuários e conversas simulados com JWT por papel) -> lógica (conta_id vem do login e não pode ser forjado; só o cadastro CRIADO pela conversa logada vira o cadastro da conta; convidado e atendimento de filho continuam "novo"; a segunda conversa da conta reaproveita cadastro sem data de nascimento) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, existsSync } from 'node:fs';
import { REPO, funcao } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };
const arq = (n) => readFileSync(`${REPO}/supabase/${n}`, 'utf8');
const ARQUIVOS = ['contas-paciente.sql', 'protecao-identidade.sql', 'login-paciente.sql'];

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
const cadastrar = async (email) => (await q(`insert into auth.users (email) values ($1) returning id`, [email]))[0].id;
// uma conversa aberta por quem tem esse papel/login (o gatilho lê o JWT, como no chat_iniciar)
const abrirConversa = async (papel, uid, { tipo = 'proprio', nome = 'Maria da Silva', email = 'maria@exemplo.com', forjar = null } = {}) => como(papel, uid, async () => {
  const ct = (await q(`insert into public.contatos (nome, telefone, email) values ($1, '71988710544', $2) returning id`, [nome, email]))[0].id;
  const cv = (await q(forjar
    ? `insert into public.conversas (contato_id, nome_informado, email_informado, paciente_tipo, conta_id) values ($1, $2, $3, $4, '${forjar}') returning id`
    : `insert into public.conversas (contato_id, nome_informado, email_informado, paciente_tipo) values ($1, $2, $3, $4) returning id`, [ct, nome, email, tipo]))[0].id;
  await q(`insert into public.pre_agendamentos (conversa_id) values ($1)`, [cv]);
  return cv;
});
const contaDe = async (cv) => (await q(`select conta_id from public.conversas where id = $1`, [cv]))[0].conta_id;
const cadastroDaConta = async (uid) => (await q(`select paciente_id from public.contas_paciente where id = $1`, [uid]))[0]?.paciente_id ?? null;
// o que ia_pre_agendar faz ao ficar "pronto" sem cadastro: cria o paciente a partir da conversa e grava o vínculo
const finalizarComoNovo = async (cv, extra = {}) => {
  const id = (await q(`insert into public.pacientes (nome, telefones, email, dt_nasc, origem_conversa) values ('Maria da Silva', array['7188710544'], 'maria@exemplo.com', '1980-03-25', $1) returning id`, [cv]))[0].id;
  await q(`update public.pre_agendamentos set paciente_id = $1 where conversa_id = $2`, [extra.outroId ?? id, cv]);
  return id;
};
const conferir = async (cv) => (await q(`select public.paciente_conferir($1) r`, [cv]))[0].r;

await caso('os três arquivos aplicam em ordem e podem ser aplicados de novo', async () => {
  for (let i = 0; i < 2; i++) for (const a of ARQUIVOS) await db.exec(arq(a));
  await db.exec(`update public.config set valor = 'nao' where chave = 'cadastro_equipe_sem_convite'`);
  return { ok: true, detalhe: '3 arquivos x 2 aplicações' };
});

const ADM = await cadastrar('primeiro@clinica.test');   // primeiro usuário: administrador ativo
const EQUIPE = await cadastrar('equipe@clinica.test');
await q(`update public.config set valor = 'sim' where chave = 'cadastro_equipe_sem_convite'`);
const ATEND = await cadastrar('atendente@clinica.test');   // pelo caminho de transição vira agente (inativo)
await q(`update public.agentes set ativo = true where id = $1`, [ATEND]);
await q(`update public.config set valor = 'nao' where chave = 'cadastro_equipe_sem_convite'`);
const ANA = await cadastrar('ana@exemplo.com'), BIA = await cadastrar('bia@exemplo.com');

await caso('a conversa guarda a conta de quem a abriu logado (vem do login, não do cliente)', async () => {
  const cv = await abrirConversa('authenticated', ANA);
  return { ok: (await contaDe(cv)) === ANA };
});
await caso('convidado, equipe e quem não é conta de paciente ficam sem conta_id', async () => {
  const a = await contaDe(await abrirConversa('anon', null)), b = await contaDe(await abrirConversa('authenticated', ATEND)), c = await contaDe(await abrirConversa('authenticated', ADM));
  return { ok: a === null && b === null && c === null, detalhe: `convidado=${a}, atendente=${b}, admin=${c}` };
});
await caso('o cliente NÃO consegue forjar a conta de outra pessoa (o gatilho sobrescreve o valor)', async () => {
  const cv = await abrirConversa('authenticated', ANA, { forjar: BIA });
  const cv2 = await abrirConversa('anon', null, { forjar: BIA });
  return { ok: (await contaDe(cv)) === ANA && (await contaDe(cv2)) === null, detalhe: 'logado como Ana e convidado tentaram gravar a conta da Bia' };
});

await caso('o cadastro CRIADO pela conversa logada ("para mim") vira o cadastro da conta', async () => {
  const cv = await abrirConversa('authenticated', ANA);
  const pid = await finalizarComoNovo(cv);
  return { ok: (await cadastroDaConta(ANA)) === pid };
});
await caso('NÃO vincula: cadastro que já existia (outra origem) que a conversa só "adotou" — ninguém toma o cadastro alheio', async () => {
  const dono = await abrirConversa('anon', null), alheio = await finalizarComoNovo(dono);   // cadastro de outra pessoa, criado por outra conversa
  const cv = await abrirConversa('authenticated', BIA);
  await q(`update public.pre_agendamentos set paciente_id = $1 where conversa_id = $2`, [alheio, cv]);   // tentativa de apontar para o cadastro alheio
  return { ok: (await cadastroDaConta(BIA)) === null };
});
await caso('NÃO vincula: atendimento "para meu filho(a)" não vira cadastro da conta', async () => {
  const cv = await abrirConversa('authenticated', BIA, { tipo: 'filho' });
  await finalizarComoNovo(cv);
  return { ok: (await cadastroDaConta(BIA)) === null };
});
await caso('NÃO vincula: convidado nunca vincula nada (sem conta)', async () => {
  const cv = await abrirConversa('anon', null), n0 = (await q(`select count(*)::int n from public.contas_paciente where paciente_id is not null`))[0].n;
  await finalizarComoNovo(cv);
  return { ok: (await q(`select count(*)::int n from public.contas_paciente where paciente_id is not null`))[0].n === n0 };
});
await caso('conta já vinculada NÃO troca de cadastro (o primeiro vale)', async () => {
  const antes = await cadastroDaConta(ANA), cv = await abrirConversa('authenticated', ANA);
  await finalizarComoNovo(cv);
  return { ok: (await cadastroDaConta(ANA)) === antes && antes !== null };
});

// ---- paciente_conferir ----
await caso('conta com cadastro vinculado: segunda conversa é "completo", conta, data conferida pelo login (sem digitar nada)', async () => {
  const cv = await abrirConversa('authenticated', ANA, { nome: 'Outro Nome Digitado', email: 'qualquer@exemplo.com' });
  const r = await conferir(cv);
  return { ok: r.situacao === 'completo' && r.conta === true && r.dt_nasc_conferida === true && r.paciente_id === await cadastroDaConta(ANA), detalhe: JSON.stringify(r.batem) };
});
await caso('o MESMO nome, telefone e e-mail como convidado continua "novo" (a conta é o que vale)', async () => {
  const r = await conferir(await abrirConversa('anon', null));
  return { ok: r.situacao === 'novo' && !r.paciente_id, detalhe: JSON.stringify(r) };
});
await caso('conta SEM cadastro vinculado, conta de outra pessoa e atendimento de filho: "novo"', async () => {
  const semCadastro = await conferir(await abrirConversa('authenticated', BIA));
  const filho = await conferir(await abrirConversa('authenticated', ANA, { tipo: 'filho' }));
  return { ok: semCadastro.situacao === 'novo' && filho.situacao === 'novo', detalhe: `sem cadastro=${semCadastro.situacao}, filho=${filho.situacao}` };
});
await caso('a Bia nunca recebe o cadastro da Ana, mesmo digitando os dados dela', async () => {
  const r = await conferir(await abrirConversa('authenticated', BIA, { nome: 'Maria da Silva', email: 'maria@exemplo.com' }));
  return { ok: !r.paciente_id || r.paciente_id !== await cadastroDaConta(ANA) };
});
await caso('cadastro marcado para revisão deixa de valer para a conta', async () => {
  const pid = await cadastroDaConta(ANA);
  await q(`update public.pacientes set revisar = true where id = $1`, [pid]);
  const r = await conferir(await abrirConversa('authenticated', ANA));
  await q(`update public.pacientes set revisar = false where id = $1`, [pid]);
  return { ok: r.situacao === 'novo' };
});

// ---- funções que a tela chama ----
await caso('conta_paciente_resumo: conta de paciente vê o próprio resumo; anônimo e equipe recebem "sem conta"', async () => {
  const eu = await como('authenticated', ANA, async () => (await q(`select public.conta_paciente_resumo() r`))[0].r);
  const eq = await como('authenticated', ATEND, async () => (await q(`select public.conta_paciente_resumo() r`))[0].r);
  let anon = 'executou'; await como('anon', null, async () => { try { await q(`select public.conta_paciente_resumo()`); } catch { anon = 'recusado'; } });
  return { ok: eu.conta === true && eu.email === 'ana@exemplo.com' && eu.cadastro_salvo === true && eq.conta === false && anon === 'recusado', detalhe: `anon=${anon}, equipe=${JSON.stringify(eq)}` };
});
await caso('conta_paciente_perfil: salva nome e telefone, registra o aceite uma vez só e valida os dados', async () => {
  const r1 = await como('authenticated', BIA, async () => (await q(`select public.conta_paciente_perfil('  Bia Souza ', '(71) 99999-1234', true) r`))[0].r);
  const t1 = (await q(`select aceitou_lgpd_em from public.contas_paciente where id = $1`, [BIA]))[0].aceitou_lgpd_em;
  await como('authenticated', BIA, async () => { await q(`select public.conta_paciente_perfil('Bia Souza', '5571999991234', false)`); });
  const lin = (await q(`select nome, telefone, aceitou_lgpd_em from public.contas_paciente where id = $1`, [BIA]))[0];
  const erros = [];
  await como('authenticated', BIA, async () => { for (const [n, t] of [['A', '71999991234'], ['Bia Souza', '123'], ['', '71999991234']]) { try { await q(`select public.conta_paciente_perfil($1, $2)`, [n, t]); erros.push(n + '/' + t); } catch { /* esperado */ } } });
  return { ok: r1.nome === 'Bia Souza' && r1.telefone === '71999991234' && !!t1 && +lin.aceitou_lgpd_em === +t1 && lin.telefone === '71999991234' && erros.length === 0, detalhe: erros.length ? 'aceitou ' + erros.join(', ') : 'aceite mantido; 3 entradas inválidas recusadas' };
});
await caso('conta_paciente_perfil: equipe e anônimo não conseguem gravar', async () => {
  const falhas = [];
  for (const [papel, uid] of [['authenticated', ATEND], ['authenticated', ADM], ['anon', null]]) await como(papel, uid, async () => { try { await q(`select public.conta_paciente_perfil('Alguém', '71999991234')`); falhas.push(papel + ':' + (uid ? 'equipe' : '-')); } catch { /* esperado */ } });
  return { ok: falhas.length === 0, detalhe: falhas.join(', ') || '3 recusas' };
});

// ---- interruptor ----
await caso('login_paciente_ativo: só liga com login_paciente=sim E cadastro da equipe já só por convite; anônimo pode consultar', async () => {
  const val = async () => como('anon', null, async () => (await q(`select public.login_paciente_ativo() v`))[0].v);
  const set = (k, v) => q(`update public.config set valor = $2 where chave = $1`, [k, v]);
  const lido = [];
  await set('login_paciente', 'nao'); await set('cadastro_equipe_sem_convite', 'nao'); lido.push(await val());   // false: desligado
  await set('login_paciente', 'sim'); await set('cadastro_equipe_sem_convite', 'sim'); lido.push(await val());   // false: equipe ainda sem convite
  await set('login_paciente', 'sim'); await set('cadastro_equipe_sem_convite', 'nao'); lido.push(await val());   // true
  await q(`delete from public.config where chave = 'cadastro_equipe_sem_convite'`); lido.push(await val());       // false: chave ausente falha fechada
  await set('login_paciente', 'nao'); await q(`insert into public.config values ('cadastro_equipe_sem_convite', 'nao') on conflict (chave) do update set valor = 'nao'`);
  const inicial = (await q(`select valor from public.config where chave = 'login_paciente'`))[0].valor;
  return { ok: JSON.stringify(lido) === '[false,false,true,false]' && inicial === 'nao', detalhe: JSON.stringify(lido) };
});
await caso('o arquivo novo cria login_paciente com valor inicial "nao" (nunca nasce ligado)', async () => {
  const novo = await banco(); for (const a of ARQUIVOS) await novo.exec(arq(a));
  const v = (await novo.query(`select valor from public.config where chave = 'login_paciente'`)).rows[0]?.valor;
  return { ok: v === 'nao', detalhe: `valor inicial = ${v}` };
});

// ---- instalador único ----
await caso('supabase/aplicar-login-paciente.sql é exatamente os três arquivos em ordem e aplica do zero', async () => {
  const inst = `${REPO}/supabase/aplicar-login-paciente.sql`;
  if (!existsSync(inst)) return { ok: false, detalhe: 'arquivo ainda não gerado' };
  const esperado = ARQUIVOS.map(arq).join('\n');
  const texto = readFileSync(inst, 'utf8');
  if (!texto.endsWith(esperado)) return { ok: false, detalhe: 'o conteúdo não bate com os 3 arquivos (regerar)' };
  const novo = await banco(); await novo.exec(texto); await novo.exec(texto);
  const n = (await novo.query(`select count(*)::int n from pg_proc where proname in ('conta_paciente_resumo','conta_paciente_perfil','equipe_convidar','paciente_conferir')`)).rows[0].n;
  return { ok: n === 4, detalhe: `${n} de 4 funções criadas, aplicado 2 vezes` };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} casos passaram.`);
process.exit(falhas ? 1 : 0);
