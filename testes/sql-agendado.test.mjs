// FLUXOGRAMA: entrada (supabase/encerramento-motivo.sql + encerramento-agendado.sql e as funções reais papel_atual, nome_confere, pessoa_membros e conversa_exame_aberto_trg, num Postgres embutido) -> validação (chave config.encerramento_valida_agendado desligada e ligada; usuário do painel x sistema) -> lógica (agendamento vigente pelo chat ou pelo Klingo; exame futuro só deixa encerrar com o motivo Agendado; ambíguo; leitura do Klingo atrasada) -> saída (PASS/FAIL por caso).
// Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-04)
import { readFileSync } from 'node:fs';
import { criarBanco, funcao, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
await db.exec(`
  alter table public.agentes add column nome text;
  alter table public.conversas add column status text not null default 'aguardando', add column agente_id uuid, add column ia_ativa boolean default true,
    add column triagem_resumo text, add column triagem_urgencia text, add column cliente_aguarda_desde timestamptz, add column encerrada_em timestamptz,
    add column alerta_agenda text, add column atualizado_em timestamptz default now(), add column contato_id uuid;
  create table public.contatos (id uuid primary key default gen_random_uuid(), nome text, telefone text);
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid, autor text, texto text);
  create table public.conversa_grupo (conversa_id uuid primary key, grupo_id uuid);
  create table public.v_agendamento_aberto (conversa_id uuid, passou boolean default false);   -- vira tabela só no teste
  create table public.v_remarcacao_pendente (conversa_id uuid);
  create table public.jornada_card (id bigint generated always as identity primary key, paciente_chave text, arquivado_em timestamptz);
  create table public.jornada_exame (id bigint generated always as identity primary key, card_id bigint, status text, agendado_para timestamptz);
  create table public.jornada_paciente (prontuario text primary key, nome text, fone_chave text);
  create table public.pessoa_klingo_vinculo (prontuario text primary key, conversa_id uuid);
  create table public.jornada_sync_estado (id boolean primary key default true, klingo_em timestamptz, klingo_erro text);
  insert into public.jornada_sync_estado (klingo_em) values (now());
  insert into public.config values ('ia_segredo', 'segredo-teste');
  create function public.pessoa_ficha(p uuid) returns jsonb language sql stable as $$ select jsonb_build_object('nome', ct.nome) from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p $$;
  ${funcao('pessoa-unica.sql', 'pessoa_membros')}
  ${funcao('pessoa-unica.sql', 'conversa_exame_aberto_trg')}
  create trigger conversa_exame_aberto before update of status on public.conversas for each row execute function public.conversa_exame_aberto_trg();
`);
const sql1 = readFileSync(`${REPO}/supabase/encerramento-motivo.sql`, 'utf8'), sql2 = readFileSync(`${REPO}/supabase/encerramento-agendado.sql`, 'utf8');

await caso('os dois arquivos aplicam sem erro e podem ser aplicados de novo', async () => { await db.exec(sql1); await db.exec(sql2); await db.exec(sql1); await db.exec(sql2); return { ok: true }; });
await db.exec(`
  create trigger conversas_antes_update before update on public.conversas for each row execute function public.conversa_antes_update();
  create trigger conversas_apos_update after update on public.conversas for each row execute function public.conversa_status_mudou();
`);

const ana = '11111111-1111-1111-1111-111111111111';
await db.query(`insert into public.agentes (id, nome, papel) values ($1, 'Ana', 'atendente')`, [ana]);
const painel = () => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: ana })]);
const sistema = () => db.query(`select set_config('request.jwt.claims', '', false)`);
const chave = (v) => db.query(`update public.config set valor = $1 where chave = 'encerramento_valida_agendado'`, [v]);
const sync = (minAtras, erro = null) => db.query(`update public.jornada_sync_estado set klingo_em = now() - make_interval(mins => $1), klingo_erro = $2`, [minAtras, erro]);
const nova = async (nome = 'Maria Souza', tel = '71988887777') => {
  const ct = (await db.query(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, [nome, tel])).rows[0].id;
  return (await db.query(`insert into public.conversas (status, contato_id) values ('em_atendimento', $1) returning id`, [ct])).rows[0].id;
};
const hash = async (tel) => (await db.query(`select encode(sha256(convert_to(right(regexp_replace($1, '\\D', '', 'g'), 8) || 'segredo-teste', 'UTF8')), 'hex') h`, [tel])).rows[0].h;
const exameKlingo = async (prontuario, status = 'agendado', dias = 2) => {
  const c = (await db.query(`insert into public.jornada_card (paciente_chave) values ($1) returning id`, [prontuario])).rows[0].id;
  await db.query(`insert into public.jornada_exame (card_id, status, agendado_para) values ($1, $2, now() + make_interval(days => $3))`, [c, status, dias]);
};
const paciente = async (prontuario, nome, tel) => db.query(`insert into public.jornada_paciente values ($1, $2, $3) on conflict (prontuario) do nothing`, [prontuario, nome, await hash(tel)]);
const fechar = (id, motivo) => db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = $2 where id = $1`, [id, motivo]);
const estado = async (id) => (await db.query(`select status from public.conversas where id = $1`, [id])).rows[0].status;
const tenta = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };
const limpar = async () => { await db.exec(`delete from public.v_agendamento_aberto; delete from public.jornada_exame; delete from public.jornada_card; delete from public.jornada_paciente; delete from public.pessoa_klingo_vinculo;`); await sync(0); };

await caso('chave desligada: tudo como hoje (exame em aberto bloqueia até o motivo Agendado; Agendado sem agendamento fecha)', async () => {
  await painel(); await chave('nao'); await limpar();
  const a = await nova(); await db.query(`insert into public.v_agendamento_aberto values ($1, false)`, [a]);
  const e1 = await tenta(() => fechar(a, 'agendado'));
  const b = await nova(); await fechar(b, 'agendado');
  return { ok: /EXAME_EM_ABERTO/.test(e1) && (await estado(a)) === 'em_atendimento' && (await estado(b)) === 'encerrada' };
});

await caso('chave ligada: exame FUTURO + Agendado encerra; os outros motivos continuam bloqueados', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova(); await db.query(`insert into public.v_agendamento_aberto values ($1, false)`, [a]);
  const outro = await tenta(() => fechar(a, 'desistiu'));
  await fechar(a, 'agendado');
  return { ok: /EXAME_EM_ABERTO/.test(outro) && (await estado(a)) === 'encerrada' };
});

await caso('chave ligada: exame que JÁ PASSOU continua bloqueando, mesmo como Agendado', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova(); await db.query(`insert into public.v_agendamento_aberto values ($1, true)`, [a]);
  const e = await tenta(() => fechar(a, 'agendado'));
  return { ok: /EXAME_EM_ABERTO/.test(e) && (await estado(a)) === 'em_atendimento' };
});

await caso('sem agendamento nenhum: Agendado é recusado com a mensagem certa e a conversa fica aberta', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova();
  const e = await tenta(() => fechar(a, 'agendado'));
  return { ok: /AGENDADO_SEM_AGENDAMENTO/.test(e) && /Não encontrei agendamento/.test(e) && (await estado(a)) === 'em_atendimento', detalhe: e.slice(0, 70) };
});

await caso('leitura do Klingo atrasada ou com erro: mensagem própria; Apenas informações segue possível', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova();
  await sync(40); const e1 = await tenta(() => fechar(a, 'agendado'));
  await sync(1, 'Klingo retornou HTTP 500'); const e2 = await tenta(() => fechar(a, 'agendado'));
  await fechar(a, 'apenas_informacoes');
  return { ok: /AGENDADO_AGENDA_INDISPONIVEL/.test(e1) && /AGENDADO_AGENDA_INDISPONIVEL/.test(e2) && (await estado(a)) === 'encerrada' };
});

await caso('cartão do Klingo ligado por prontuário confirmado: Agendado encerra', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova(); await exameKlingo('P1'); await db.query(`insert into public.pessoa_klingo_vinculo values ('P1', $1)`, [a]);
  await fechar(a, 'agendado');
  return { ok: (await estado(a)) === 'encerrada' };
});

await caso('cartão do Klingo ligado por nome + telefone: Agendado encerra; telefone de outra pessoa não', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova('Maria Souza Lima', '71988887777'), b = await nova('Maria Souza Lima', '71977776666');
  await paciente('P2', 'MARIA SOUZA LIMA', '71988887777'); await exameKlingo('P2');
  await fechar(a, 'agendado'); const e = await tenta(() => fechar(b, 'agendado'));
  return { ok: (await estado(a)) === 'encerrada' && /AGENDADO_SEM_AGENDAMENTO/.test(e) && (await estado(b)) === 'em_atendimento' };
});

await caso('mesmo telefone, nome diferente (família): não vale', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova('Joana Pereira Dias', '71988887777');
  await paciente('P3', 'CARLOS PEREIRA DIAS', '71988887777'); await exameKlingo('P3');
  const e = await tenta(() => fechar(a, 'agendado'));
  return { ok: /AGENDADO_SEM_AGENDAMENTO/.test(e) };
});

await caso('mais de um paciente possível no Klingo: ambíguo, fica aberta', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova('Maria Souza Lima', '71988887777');
  await paciente('P4', 'MARIA SOUZA LIMA', '71988887777'); await paciente('P5', 'MARIA SOUZA LIMA', '71988887777');
  await exameKlingo('P4'); await exameKlingo('P5');
  const e = await tenta(() => fechar(a, 'agendado'));
  return { ok: /AGENDADO_AMBIGUO/.test(e) && (await estado(a)) === 'em_atendimento' };
});

await caso('exame do Klingo cancelado, atendido ou já passado não conta', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova('Maria Souza Lima', '71988887777');
  await paciente('P6', 'MARIA SOUZA LIMA', '71988887777');
  await exameKlingo('P6', 'cancelado'); await exameKlingo('P6', 'atendido'); await exameKlingo('P6', 'agendado', -3);
  const e = await tenta(() => fechar(a, 'agendado'));
  return { ok: /AGENDADO_SEM_AGENDAMENTO/.test(e) };
});

await caso('pessoa com duas conversas: o agendamento de uma vale para a outra', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova(), b = await nova(); const g = '99999999-9999-9999-9999-999999999999';
  await db.query(`insert into public.conversa_grupo values ($1, $3), ($2, $3)`, [a, b, g]);
  await db.query(`insert into public.v_agendamento_aberto values ($1, false)`, [a]);
  await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'agendado' where id = any ($1)`, [[a, b]]);
  return { ok: (await estado(a)) === 'encerrada' && (await estado(b)) === 'encerrada' };
});

await caso('sistema não é validado nem com a chave ligada', async () => {
  await sistema(); await chave('sim'); await limpar();
  const a = await nova(); await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'agendado' where id = $1`, [a]);
  return { ok: (await estado(a)) === 'encerrada' };
});

await caso('a ordem dos gatilhos é a esperada (exame em aberto, validação, depois o motivo)', async () => {
  const r = (await db.query(`select tgname from pg_trigger where tgrelid = 'public.conversas'::regclass and not tgisinternal and tgtype & 2 = 2 order by tgname`)).rows.map((x) => x.tgname);
  return { ok: r.join() === 'conversa_exame_aberto,conversa_valida_agendado,conversas_antes_update', detalhe: r.join() };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
