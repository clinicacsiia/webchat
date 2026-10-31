// FLUXOGRAMA: entrada (supabase/contas-paciente.sql real + supabase/meus-dados.sql, num Postgres embutido com stubs mínimos do Auth e das tabelas do chat) -> validação (aplica o arquivo duas vezes; anônimo, equipe e conta sem login são recusados) -> lógica (cópia traz só os dados da própria conta e nada interno; exclusão apaga só o login e solta o vínculo, o resto fica; registro sem dado pessoal) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { REPO, funcao } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const contas = readFileSync(`${REPO}/supabase/contas-paciente.sql`, 'utf8');
const meusDados = readFileSync(`${REPO}/supabase/meus-dados.sql`, 'utf8');

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
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.jwt(), auth.uid() to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  create table public.agentes (
    id uuid primary key references auth.users(id) on delete cascade,
    nome text not null, email text,
    papel text not null default 'atendente' check (papel in ('admin','atendente','marketing')),
    ativo boolean not null default false, criado_em timestamptz not null default now());
  create table public.config (chave text primary key, valor text not null default '');
  create table public.pacientes (id uuid primary key default gen_random_uuid(), nome text not null, telefones text[] not null default '{}', email text, dt_nasc date, cpf text,
    dados jsonb not null default '{}'::jsonb, validado boolean default false, revisar boolean default false,
    criado_em timestamptz not null default now(), ultima_visita_em timestamptz not null default now());
  create table public.conversas (id uuid primary key default gen_random_uuid(), conta_id uuid references auth.users(id) on delete set null, paciente_tipo text default 'proprio',
    triagem_resumo text, criado_em timestamptz not null default now());
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid not null references public.conversas(id) on delete cascade,
    autor text not null, texto text not null, criado_em timestamptz not null default now(), opcoes jsonb);
  create table public.pre_agendamentos (id uuid primary key default gen_random_uuid(), conversa_id uuid not null unique references public.conversas(id) on delete cascade,
    tipo text, plano text, unidade text, profissional text, status text default 'rascunho', escolha_horario jsonb, paciente jsonb not null default '{}'::jsonb);
  create table public.pre_agendamento_itens (id bigint generated always as identity primary key, conversa_id uuid not null references public.conversas(id) on delete cascade,
    modalidade text, lado text, procedimento text, ativo boolean not null default true);
  create table public.paciente_historico (id bigint generated always as identity primary key, paciente_id uuid not null references public.pacientes(id) on delete cascade,
    ocorreu_em timestamp, criado_em timestamptz not null default now(), exames jsonb, horarios jsonb, plano text, unidade text, profissional text, cancelado boolean not null default false);
  create table public.conversa_anexo (id bigint generated always as identity primary key, conversa_id uuid not null references public.conversas(id) on delete cascade, mime text, dados bytea);
  ${funcao('00-base-snapshot.sql', 'papel_atual')}
  ${funcao('00-base-snapshot.sql', 'novo_usuario')}
  create trigger on_auth_user_created after insert on auth.users for each row execute function public.novo_usuario();
`);
await db.exec(contas);
// Colunas que o login-paciente.sql acrescenta (o arquivo inteiro depende de tabelas que este teste não precisa).
await db.exec(`
  alter table public.contas_paciente add column if not exists nome text;
  alter table public.contas_paciente add column if not exists telefone text;
  alter table public.contas_paciente add column if not exists aceitou_lgpd_em timestamptz;
`);

const como = async (papel, uid, fn) => {
  await db.exec(`set request.jwt.claims = '${uid ? JSON.stringify({ sub: uid }) : ''}'; set role ${papel}`);
  try { return await fn(); } finally { await db.exec('reset role; reset request.jwt.claims'); }
};
const cadastrar = async (email, meta = {}) => (await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify(meta)])).rows[0].id;
const um = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const erroDe = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message.split('\n')[0]; } };

// ---- cenário: um administrador, uma atendente, duas pacientes com conta e uma conversa sem conta ----
const ADM = await cadastrar('adm@clinica.test', { nome: 'Adm' });
await db.query(`insert into public.config (chave, valor) values ('cadastro_equipe_sem_convite', 'nao') on conflict (chave) do update set valor = 'nao'`);
await db.query(`insert into public.equipe_convites (email, papel) values ('atendente@clinica.test', 'atendente')`);
const ATE = await cadastrar('atendente@clinica.test', { nome: 'Atendente' });
await db.query(`update public.agentes set ativo = true where id = $1`, [ATE]);
const ANA = await cadastrar('ana@teste.local', { nome: 'Ana' });
const BIA = await cadastrar('bia@teste.local', { nome: 'Bia' });

const PAC_ANA = (await um(`insert into public.pacientes (nome, telefones, email, dt_nasc, cpf, dados, validado, revisar) values ('Ana Souza', '{71999998888}', 'ana@teste.local', '1950-03-25', '11144477735',
  '{"mae":"Maria Souza","cidade":"Salvador"}'::jsonb, true, false) returning id`)).id;
const PAC_BIA = (await um(`insert into public.pacientes (nome, telefones, cpf) values ('Bia Lima', '{71988887777}', '52998224725') returning id`)).id;
await db.query(`update public.contas_paciente set nome = 'Ana Souza', telefone = '71999998888', paciente_id = $2, aceitou_lgpd_em = now() where id = $1`, [ANA, PAC_ANA]);
await db.query(`update public.contas_paciente set nome = 'Bia Lima', telefone = '71988887777', paciente_id = $2 where id = $1`, [BIA, PAC_BIA]);

const conversa = async (conta, tipo = 'proprio', resumo = null) => (await um(`insert into public.conversas (conta_id, paciente_tipo, triagem_resumo) values ($1, $2, $3) returning id`, [conta, tipo, resumo])).id;
const C_ANA1 = await conversa(ANA, 'proprio', 'RESUMO INTERNO DA IA: paciente difícil');
const C_ANA2 = await conversa(ANA, 'filho');
const C_BIA = await conversa(BIA);
const C_SEM = await conversa(null);
const msg = (c, autor, texto) => db.query(`insert into public.mensagens (conversa_id, autor, texto) values ($1, $2, $3)`, [c, autor, texto]);
await msg(C_ANA1, 'cliente', 'Quero fazer uma ressonância do joelho'); await msg(C_ANA1, 'agente', 'Claro! Escolha o exame.');
await msg(C_ANA1, 'sistema', 'NOTA INTERNA: possível golpe'); await msg(C_ANA2, 'cliente', 'Agora para o meu filho');
await msg(C_BIA, 'cliente', 'SEGREDO DA BIA'); await msg(C_SEM, 'cliente', 'conversa sem conta');
await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, plano, unidade, status, paciente) values ($1, 'exame', 'UNIMED', 'CSI', 'pronto', '{"nome":"Ana Souza","cpf":"11144477735"}'::jsonb)`, [C_ANA1]);
await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, plano, status) values ($1, 'exame', 'AMIL', 'pronto')`, [C_BIA]);
await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, lado, procedimento) values ($1, 'RM', 'D', 'RESSONANCIA DO JOELHO')`, [C_ANA1]);
await db.query(`insert into public.paciente_historico (paciente_id, ocorreu_em, exames, plano, unidade) values ($1, '2026-09-10 08:00', '[{"exame":"RX TORAX"}]'::jsonb, 'UNIMED', 'CSI')`, [PAC_ANA]);
await db.query(`insert into public.conversa_anexo (conversa_id, mime, dados) values ($1, 'image/jpeg', '\\x00')`, [C_ANA1]);

await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => {
  await db.exec(meusDados); await db.exec(meusDados);
  return { ok: true, detalhe: 'duas aplicações seguidas sem erro' };
});

const copia = (uid, papel = 'authenticated') => como(papel, uid, async () => (await um(`select public.conta_paciente_meus_dados() r`)).r);
const excluir = (uid, conf = 'EXCLUIR', papel = 'authenticated') => como(papel, uid, async () => (await um(`select public.conta_paciente_excluir($1) r`, [conf])).r);

await caso('anônimo não consegue chamar nenhuma das duas funções (sem permissão)', async () => {
  const e1 = await erroDe(() => copia(null, 'anon')), e2 = await erroDe(() => excluir(null, 'EXCLUIR', 'anon'));
  return { ok: /permission denied/i.test(e1) && /permission denied/i.test(e2), detalhe: `${e1} | ${e2}` };
});

await caso('a equipe (atendente e administrador) não vê dados de paciente por aqui e não apaga nada', async () => {
  const e1 = await erroDe(() => copia(ATE)), e2 = await erroDe(() => excluir(ATE)), e3 = await erroDe(() => copia(ADM)), e4 = await erroDe(() => excluir(ADM));
  const vivos = (await um(`select count(*)::int n from auth.users where id in ($1, $2)`, [ATE, ADM])).n;
  return { ok: [e1, e2, e3, e4].every((e) => /Entre na sua conta/.test(e)) && vivos === 2, detalhe: `${e1} | vivos=${vivos}` };
});

await caso('cópia: traz a conta, o cadastro, o histórico, os pedidos e as mensagens da própria pessoa', async () => {
  const d = await copia(ANA);
  const ok = d.conta.email === 'ana@teste.local' && d.conta.nome === 'Ana Souza' && d.cadastro.nome === 'Ana Souza' && d.cadastro.cpf === '11144477735'
    && d.cadastro.outros_dados.mae === 'Maria Souza' && d.historico.length === 1 && d.historico[0].convenio === 'UNIMED'
    && d.pedidos.length === 2 && d.mensagens.length === 3 && d.fotos_de_pedido_guardadas === 1;
  const ped = d.pedidos.find((p) => p.exames.length);
  return { ok: ok && ped.exames[0] === 'RESSONANCIA DO JOELHO (D)' && ped.convenio === 'UNIMED' && d.pedidos.some((p) => p.para === 'filho(a)'),
           detalhe: `pedidos=${d.pedidos.length}, mensagens=${d.mensagens.length}, exame=${ped?.exames?.[0]}` };
});

await caso('cópia: as mensagens saem em ordem e com "você" / "clínica" no lugar do papel interno', async () => {
  const d = await copia(ANA);
  const quem = d.mensagens.map((m) => m.quem).join(',');
  return { ok: d.mensagens[0].texto.startsWith('Quero fazer') && quem === 'você,clínica,você', detalhe: quem };
});

await caso('cópia: nada de outra pessoa, de conversa sem conta nem nota interna', async () => {
  const txt = JSON.stringify(await copia(ANA));
  const vaza = ['SEGREDO DA BIA', 'Bia Lima', 'conversa sem conta', 'NOTA INTERNA', 'RESUMO INTERNO', 'triagem', 'revisar', 'validado'].filter((t) => txt.includes(t));
  return { ok: vaza.length === 0, detalhe: vaza.join(', ') || 'nada indevido' };
});

await caso('cópia da outra paciente: só os dados dela', async () => {
  const d = await copia(BIA);
  const txt = JSON.stringify(d);
  return { ok: d.cadastro.nome === 'Bia Lima' && d.mensagens.length === 1 && d.pedidos.length === 1 && !txt.includes('Ana Souza'), detalhe: `mensagens=${d.mensagens.length}` };
});

await caso('cópia: conta sem cadastro de paciente devolve cadastro e histórico vazios (sem erro)', async () => {
  const NOVA = await cadastrar('nova@teste.local', { nome: 'Nova' });
  const d = await copia(NOVA);
  return { ok: d.cadastro === null && d.historico.length === 0 && d.pedidos.length === 0 && d.conta.email === 'nova@teste.local', detalhe: JSON.stringify(d.cadastro) };
});

await caso('cada cópia deixa um registro SEM dado pessoal (só tipo, data e contagens)', async () => {
  const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'conta_paciente_evento' order by ordinal_position`)).rows.map((r) => r.column_name);
  const n = (await um(`select count(*)::int n from public.conta_paciente_evento where tipo = 'copia'`)).n;
  return { ok: n >= 4 && cols.join(',') === 'id,tipo,tinha_cadastro,conversas,criado_em', detalhe: `${cols.join(',')} / ${n} cópias` };
});

await caso('só o administrador lê o registro de pedidos', async () => {
  const adm = await como('authenticated', ADM, async () => (await um(`select count(*)::int n from public.conta_paciente_evento`)).n);
  const ate = await como('authenticated', ATE, async () => (await um(`select count(*)::int n from public.conta_paciente_evento`)).n);
  const pac = await como('authenticated', ANA, async () => (await um(`select count(*)::int n from public.conta_paciente_evento`)).n);
  return { ok: adm > 0 && ate === 0 && pac === 0, detalhe: `admin=${adm}, atendente=${ate}, paciente=${pac}` };
});

await caso('excluir sem a confirmação (ou com palavra errada) recusa e a conta continua', async () => {
  const e1 = await erroDe(() => excluir(ANA, '')), e2 = await erroDe(() => excluir(ANA, 'excluir')), e3 = await erroDe(() => excluir(ANA, null));
  const viva = (await um(`select count(*)::int n from auth.users where id = $1`, [ANA])).n;
  return { ok: [e1, e2, e3].every((e) => /Confirmação ausente/.test(e)) && viva === 1, detalhe: `${e1} | viva=${viva}` };
});

await caso('excluir uma conta não apaga a conta de outra pessoa', async () => {
  const r = await excluir(BIA);
  const ana = (await um(`select count(*)::int n from public.contas_paciente where id = $1`, [ANA])).n;
  const bia = (await um(`select count(*)::int n from auth.users where id = $1`, [BIA])).n;
  return { ok: r.ok === true && ana === 1 && bia === 0, detalhe: `ana=${ana}, bia=${bia}` };
});

await caso('excluir apaga só o login: conta e e-mail saem, o vínculo é solto, cadastro/pedidos/conversas/histórico ficam', async () => {
  const r = await excluir(ANA);
  const q = async (sql, id) => (await um(sql, [id])).n;
  const login = await q(`select count(*)::int n from auth.users where id = $1`, ANA);
  const conta = await q(`select count(*)::int n from public.contas_paciente where id = $1`, ANA);
  const vinculadas = await q(`select count(*)::int n from public.conversas where conta_id = $1`, ANA);
  const cadastro = await q(`select count(*)::int n from public.pacientes where id = $1`, PAC_ANA);
  const pedido = await q(`select count(*)::int n from public.pre_agendamentos where conversa_id = $1`, C_ANA1);
  const mensagens = await q(`select count(*)::int n from public.mensagens where conversa_id = $1`, C_ANA1);
  const historico = await q(`select count(*)::int n from public.paciente_historico where paciente_id = $1`, PAC_ANA);
  const conversasSemConta = (await um(`select count(*)::int n from public.conversas where id in ($1, $2) and conta_id is null`, [C_ANA1, C_ANA2])).n;
  return { ok: r.ok === true && r.continua_guardado.includes('cadastro') && login === 0 && conta === 0 && vinculadas === 0 && conversasSemConta === 2 && cadastro === 1 && pedido === 1 && mensagens === 3 && historico === 1,
           detalhe: `login=${login}, conta=${conta}, conversas soltas=${conversasSemConta}, cadastro=${cadastro}, pedido=${pedido}, mensagens=${mensagens}, histórico=${historico}` };
});

await caso('a exclusão deixa um registro sem dado pessoal e diz se havia cadastro', async () => {
  const e = (await db.query(`select tinha_cadastro, conversas from public.conta_paciente_evento where tipo = 'exclusao' order by id`)).rows;
  return { ok: e.length === 2 && e.every((x) => x.tinha_cadastro === true) && e[1].conversas === 2, detalhe: JSON.stringify(e) };
});

await caso('depois de apagada, a sessão antiga não enxerga mais nada (cópia e exclusão recusadas)', async () => {
  const e1 = await erroDe(() => copia(ANA)), e2 = await erroDe(() => excluir(ANA));
  return { ok: /Entre na sua conta/.test(e1) && /Entre na sua conta/.test(e2), detalhe: e1 };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
