// FLUXOGRAMA: entrada (supabase/encerramento-motivo.sql + encerramento-agendado.sql e as funções reais papel_atual, nome_confere, pessoa_membros e conversa_exame_aberto_trg, num Postgres embutido) -> validação (chave config.encerramento_valida_agendado desligada e ligada; usuário do painel x sistema) -> lógica (Agendado NUNCA é recusado; a conferência de agendamento vigente pelo chat ou pelo Klingo roda depois: confirma, avisa se não achou no prazo, se o Klingo está com problema, se o exame sumiu ou mudou de data; exame futuro só deixa encerrar com o motivo Agendado) -> saída (PASS/FAIL por caso).
// Versão 1.1 — 09/11/2026 / Mudança: encerrar como Agendado nunca é recusado; testes da conferência em segundo plano e do aviso
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
  insert into public.config values ('ia_segredo', 'segredo-teste'), ('equipe_push_url', 'https://exemplo.test/avisar'), ('horario_teste', 'sim');
  create function public.horario_trabalho_agora(p timestamptz default now()) returns boolean language sql stable as $$ select coalesce((select valor from public.config where chave = 'horario_teste'), 'sim') = 'sim' $$;
  create function public.fila_aviso_segredo() returns text language sql as $$ select 'segredo-teste' $$;
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
const limpar = async () => { await db.exec(`delete from public.v_agendamento_aberto; delete from public.jornada_exame; delete from public.jornada_card; delete from public.jornada_paciente; delete from public.pessoa_klingo_vinculo; delete from public.conversa_agendado_conferencia;`); await sync(0); };

const linha = async (id) => (await db.query(`select situacao, fonte, codigo, exame_em, aviso_texto, avisada_em, push_em from public.conversa_agendado_conferencia where conversa_id = $1`, [id])).rows[0];
const alerta = async (id) => (await db.query(`select alerta_agenda from public.conversas where id = $1`, [id])).rows[0].alerta_agenda;
const vigiar = async () => (await db.query(`select public.agendado_vigiar() r`)).rows[0].r;
const voltar = (id, min) => db.query(`update public.conversa_agendado_conferencia set encerrada_em = now() - make_interval(mins => $2) where conversa_id = $1`, [id, min]);
const pushes = async () => (await db.query(`select body from net.chamadas order by 1::text`)).rows.map((x) => x.body);
const horario = (v) => db.query(`update public.config set valor = $1 where chave = 'horario_teste'`, [v]);
const sem = /Não achei o agendamento|não achei o agendamento/;

await caso('chave desligada: tudo como hoje (exame em aberto bloqueia até o motivo Agendado; Agendado sem agendamento fecha) e nada é conferido', async () => {
  await painel(); await chave('nao'); await limpar();
  const a = await nova(); await db.query(`insert into public.v_agendamento_aberto values ($1, false)`, [a]);
  const e1 = await tenta(() => fechar(a, 'agendado'));
  const b = await nova(); await fechar(b, 'agendado');
  return { ok: /EXAME_EM_ABERTO/.test(e1) && (await estado(a)) === 'em_atendimento' && (await estado(b)) === 'encerrada' && !(await linha(b)) };
});

await caso('chave ligada: exame FUTURO + Agendado encerra; os outros motivos continuam bloqueados', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova(); await db.query(`insert into public.v_agendamento_aberto values ($1, false)`, [a]);
  const outro = await tenta(() => fechar(a, 'desistiu'));
  await fechar(a, 'agendado');
  return { ok: /EXAME_EM_ABERTO/.test(outro) && (await estado(a)) === 'encerrada' && (await linha(a)).situacao === 'confirmado' && (await linha(a)).fonte === 'chat' };
});

await caso('chave ligada: exame que JÁ PASSOU continua bloqueando, mesmo como Agendado', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova(); await db.query(`insert into public.v_agendamento_aberto values ($1, true)`, [a]);
  const e = await tenta(() => fechar(a, 'agendado'));
  return { ok: /EXAME_EM_ABERTO/.test(e) && (await estado(a)) === 'em_atendimento' };
});

await caso('SEM agendamento nenhum: Agendado ENCERRA (não recusa mais), fica "verificando" e ainda não avisa', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova();
  const e = await tenta(() => fechar(a, 'agendado'));
  const l = await linha(a);
  return { ok: e === '' && (await estado(a)) === 'encerrada' && l.situacao === 'verificando' && l.codigo === 'AGENDADO_SEM_AGENDAMENTO' && (await alerta(a)) === null, detalhe: e.slice(0, 70) };
});

await caso('leitura do Klingo atrasada ou com erro: Agendado encerra do mesmo jeito (fica verificando)', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova(), b = await nova();
  await sync(40); const e1 = await tenta(() => fechar(a, 'agendado'));
  await sync(1, 'Klingo retornou HTTP 500'); const e2 = await tenta(() => fechar(b, 'agendado'));
  return { ok: e1 === '' && e2 === '' && (await estado(a)) === 'encerrada' && (await estado(b)) === 'encerrada' && (await linha(a)).codigo === 'AGENDADO_AGENDA_INDISPONIVEL' && (await linha(b)).codigo === 'AGENDADO_AGENDA_INDISPONIVEL' };
});

await caso('cartão do Klingo ligado por prontuário confirmado: encerra e fica confirmado com a data do exame', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova(); await exameKlingo('P1'); await db.query(`insert into public.pessoa_klingo_vinculo values ('P1', $1)`, [a]);
  await fechar(a, 'agendado'); const l = await linha(a);
  return { ok: (await estado(a)) === 'encerrada' && l.situacao === 'confirmado' && l.fonte === 'klingo' && l.exame_em != null };
});

await caso('cartão do Klingo por nome + telefone: confirma; telefone de outra pessoa encerra mas NÃO confirma', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova('Maria Souza Lima', '71988887777'), b = await nova('Maria Souza Lima', '71977776666');
  await paciente('P2', 'MARIA SOUZA LIMA', '71988887777'); await exameKlingo('P2');
  await fechar(a, 'agendado'); await fechar(b, 'agendado');
  return { ok: (await estado(a)) === 'encerrada' && (await estado(b)) === 'encerrada' && (await linha(a)).situacao === 'confirmado' && (await linha(b)).situacao === 'verificando' };
});

await caso('mesmo telefone, nome diferente (família): não confirma', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova('Joana Pereira Dias', '71988887777');
  await paciente('P3', 'CARLOS PEREIRA DIAS', '71988887777'); await exameKlingo('P3');
  await fechar(a, 'agendado');
  return { ok: (await estado(a)) === 'encerrada' && (await linha(a)).codigo === 'AGENDADO_SEM_AGENDAMENTO' };
});

await caso('mais de um paciente possível no Klingo: encerra, fica verificando como ambíguo', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova('Maria Souza Lima', '71988887777');
  await paciente('P4', 'MARIA SOUZA LIMA', '71988887777'); await paciente('P5', 'MARIA SOUZA LIMA', '71988887777');
  await exameKlingo('P4'); await exameKlingo('P5');
  await fechar(a, 'agendado');
  return { ok: (await estado(a)) === 'encerrada' && (await linha(a)).codigo === 'AGENDADO_AMBIGUO' };
});

await caso('exame do Klingo cancelado, atendido ou já passado não conta', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova('Maria Souza Lima', '71988887777');
  await paciente('P6', 'MARIA SOUZA LIMA', '71988887777');
  await exameKlingo('P6', 'cancelado'); await exameKlingo('P6', 'atendido'); await exameKlingo('P6', 'agendado', -3);
  await fechar(a, 'agendado');
  return { ok: (await estado(a)) === 'encerrada' && (await linha(a)).situacao === 'verificando' };
});

await caso('pessoa com duas conversas: o agendamento de uma vale para a outra', async () => {
  await painel(); await chave('sim'); await limpar();
  const a = await nova(), b = await nova(); const g = '99999999-9999-9999-9999-999999999999';
  await db.query(`insert into public.conversa_grupo values ($1, $3), ($2, $3)`, [a, b, g]);
  await db.query(`insert into public.v_agendamento_aberto values ($1, false)`, [a]);
  await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'agendado' where id = any ($1)`, [[a, b]]);
  return { ok: (await estado(a)) === 'encerrada' && (await estado(b)) === 'encerrada' };
});

await caso('sistema não é conferido nem com a chave ligada (sem linha de conferência)', async () => {
  await sistema(); await chave('sim'); await limpar();
  const a = await nova(); await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'agendado' where id = $1`, [a]);
  return { ok: (await estado(a)) === 'encerrada' && !(await linha(a)) };
});

await caso('a ordem dos gatilhos é a esperada (exame em aberto, conferência, depois o motivo)', async () => {
  const r = (await db.query(`select tgname from pg_trigger where tgrelid = 'public.conversas'::regclass and not tgisinternal and tgtype & 2 = 2 order by tgname`)).rows.map((x) => x.tgname);
  return { ok: r.join() === 'conversa_exame_aberto,conversa_valida_agendado,conversas_antes_update', detalhe: r.join() };
});

// ---------- conferência em segundo plano (agendado_vigiar) ----------
await caso('vigia: dentro do prazo não avisa; passado o prazo avisa na conversa e manda UM push genérico (sem nome)', async () => {
  await painel(); await chave('sim'); await limpar(); await horario('sim'); await db.exec(`delete from net.chamadas`);
  const a = await nova(); await fechar(a, 'agendado');
  const r1 = await vigiar(); const antes = await alerta(a);
  await voltar(a, 130); const r2 = await vigiar(); const l = await linha(a); const p = await pushes();
  const r3 = await vigiar();
  return { ok: r1.avisos === 0 && antes === null && r2.avisos === 1 && l.situacao === 'problema' && sem.test(await alerta(a)) && p.length === 1 && p[0].tipo === 'agenda' && p[0].quantidade === 1 && !JSON.stringify(p).includes('Maria') && r3.avisos === 0 && (await pushes()).length === 1, detalhe: JSON.stringify([r1, r2, p]) };
});

await caso('vigia: fora do horário de trabalho avisa na conversa, mas o push só sai quando o horário começa', async () => {
  await painel(); await chave('sim'); await limpar(); await db.exec(`delete from net.chamadas`); await horario('nao');
  const a = await nova(); await fechar(a, 'agendado'); await voltar(a, 130);
  await vigiar(); const fora = (await pushes()).length;
  await horario('sim'); await vigiar(); const dentro = (await pushes()).length;
  return { ok: fora === 0 && dentro === 1 && /não achei/i.test(await alerta(a)), detalhe: `${fora}/${dentro}` };
});

await caso('vigia: o agendamento aparece depois, mesmo com o aviso já dado: vira confirmado e o aviso some', async () => {
  await painel(); await chave('sim'); await limpar(); await horario('sim');
  const a = await nova('Maria Souza Lima', '71988887777'); await fechar(a, 'agendado'); await voltar(a, 130); await vigiar();
  const antes = await alerta(a);
  await paciente('P7', 'MARIA SOUZA LIMA', '71988887777'); await exameKlingo('P7');
  await vigiar(); const l = await linha(a);
  return { ok: !!antes && l.situacao === 'confirmado' && l.fonte === 'klingo' && (await alerta(a)) === null };
});

await caso('vigia: leitura do Klingo com problema depois do prazo: o aviso diz que não deu para conferir', async () => {
  await painel(); await chave('sim'); await limpar(); await horario('sim');
  const a = await nova(); await sync(1, 'Klingo retornou HTTP 500'); await fechar(a, 'agendado'); await voltar(a, 130);
  await vigiar();
  return { ok: /não consegui conferir/i.test(await alerta(a)) && (await linha(a)).situacao === 'problema' };
});

await caso('vigia: exame confirmado some do Klingo ANTES da data (cancelado): avisa que mudou', async () => {
  await painel(); await chave('sim'); await limpar(); await horario('sim');
  const a = await nova('Maria Souza Lima', '71988887777'); await paciente('P8', 'MARIA SOUZA LIMA', '71988887777'); await exameKlingo('P8', 'agendado', 3);
  await fechar(a, 'agendado'); const r1 = await vigiar();
  await db.exec(`update public.jornada_exame set status = 'cancelado'`); const r2 = await vigiar();
  return { ok: r1.avisos === 0 && r2.avisos === 1 && /mudou no Klingo/.test(await alerta(a)) && (await linha(a)).situacao === 'problema' };
});

await caso('vigia: exame confirmado que simplesmente aconteceu (atendido, data passada) NÃO gera aviso', async () => {
  await painel(); await chave('sim'); await limpar(); await horario('sim');
  const a = await nova('Maria Souza Lima', '71988887777'); await paciente('P9', 'MARIA SOUZA LIMA', '71988887777'); await exameKlingo('P9', 'agendado', 0);   // atendido um pouco antes do horário marcado: não é "exame sumiu"
  await fechar(a, 'agendado');
  await db.exec(`update public.jornada_exame set status = 'atendido', agendado_para = now() - interval '2 hours'`); const r = await vigiar();
  await db.exec(`update public.jornada_exame set agendado_para = now() - interval '3 days'`); await db.exec(`update public.conversa_agendado_conferencia set exame_em = now() - interval '3 days'`); await vigiar();
  return { ok: r.avisos === 0 && (await alerta(a)) === null && (await linha(a)).situacao === 'concluido' };
});

await caso('vigia: a data do exame mudou no Klingo antes do dia: avisa com a data nova', async () => {
  await painel(); await chave('sim'); await limpar(); await horario('sim');
  const a = await nova('Maria Souza Lima', '71988887777'); await paciente('P10', 'MARIA SOUZA LIMA', '71988887777'); await exameKlingo('P10', 'agendado', 3);
  await fechar(a, 'agendado');
  await db.exec(`update public.jornada_exame set agendado_para = now() + interval '6 days'`); const r = await vigiar();
  return { ok: r.avisos === 1 && /mudou no Klingo: agora é em \d\d\/\d\d/.test(await alerta(a)) && (await linha(a)).situacao === 'problema' };
});

await caso('reabrir a conversa apaga a conferência e o aviso que a rotina tinha posto', async () => {
  await painel(); await chave('sim'); await limpar(); await horario('sim');
  const a = await nova(); await fechar(a, 'agendado'); await voltar(a, 130); await vigiar();
  const antes = await alerta(a);
  await sistema(); await db.query(`update public.conversas set status = 'aguardando' where id = $1`, [a]);
  return { ok: !!antes && !(await linha(a)) && (await alerta(a)) === null };
});

await caso('a rotina nunca derruba o encerramento: mesmo sem a tabela de conferência o fechamento passa', async () => {
  await painel(); await chave('sim'); await limpar();
  await db.exec(`alter table public.conversa_agendado_conferencia rename to conferencia_tmp`);
  const a = await nova(); const e = await tenta(() => fechar(a, 'agendado'));
  await db.exec(`alter table public.conferencia_tmp rename to conversa_agendado_conferencia`);
  return { ok: e === '' && (await estado(a)) === 'encerrada', detalhe: e.slice(0, 80) };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
