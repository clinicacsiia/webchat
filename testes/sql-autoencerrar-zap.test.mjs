// FLUXOGRAMA: entrada (supabase/autoencerrar-chamar-zap.sql sobre encerramento-motivo, despedida, autoencerrar e c1-reentrada, num Postgres embutido) -> validação (modo desligado/simulação/ligado; 23h59 x 24h; remarcação pendente; pessoa unida; conversa antiga sem marco; só a equipe confirma) -> lógica (NUNCA fecha: marca "chamar no zap"; resposta do paciente, nova mensagem da equipe, mudança de estado e transferência tiram a marca; "Já chamei no zap" tira a marca e recomeça as 24 h) -> saída (PASS/FAIL por caso).
// Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial (encerramento automático vira "chamar no WhatsApp")
import { readFileSync } from 'node:fs';
import { criarBanco, funcao, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
await db.exec(`
  create role service_role nologin;
  alter table public.agentes add column nome text;
  alter table public.conversas add column status text not null default 'aguardando', add column agente_id uuid, add column ia_ativa boolean default true,
    add column triagem_resumo text, add column triagem_urgencia text, add column cliente_aguarda_desde timestamptz, add column encerrada_em timestamptz,
    add column alerta_agenda text, add column atualizado_em timestamptz default now(), add column criado_em timestamptz not null default now(), add column primeiro_humano_em timestamptz;
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid, autor text, agente_id uuid, texto text not null check (char_length(texto) between 1 and 4000), opcoes jsonb, criado_em timestamptz not null default now());
  create table public.conversa_grupo (conversa_id uuid primary key, grupo_id uuid);
  create table public.v_agendamento_aberto (conversa_id uuid);
  create table public.v_remarcacao_pendente (conversa_id uuid);
  create table public.conversa_segredo (conversa_id uuid primary key references public.conversas(id) on delete cascade, token text not null default md5(random()::text));
  create table public.conversa_evento (id bigint generated always as identity primary key, conversa_id uuid, tipo text, detalhe jsonb not null default '{}'::jsonb);
  create table public.remarcacoes_herdadas (destino uuid, origem uuid);
  ${funcao('pessoa-unica.sql', 'pessoa_membros')}
  create function public.chat_valida(p uuid, t text) returns void language sql as $$ select 1 $$;
  create function public.chat_respostas(c uuid, a bigint) returns jsonb language sql as $$ select '[]'::jsonb $$;
  create function public.agendamento_preparar_remarcacao(d uuid, o uuid) returns boolean language plpgsql as $$ begin return true; end $$;
  create function public.chat_iniciar(p_nome text, p_telefone text, p_email text default null, p_mensagem text default null, p_aceite boolean default false, p_origem text default null,
    p_unidade text default null, p_medico text default null, p_paciente_tipo text default 'proprio', p_paciente_nome text default null, p_irmaos jsonb default null, p_irmaos_modo text default null) returns jsonb
  language sql as $$ select '{}'::jsonb $$;
`);
const arq = (n) => readFileSync(`${REPO}/supabase/${n}`, 'utf8');
for (const n of ['encerramento-motivo.sql', 'despedida.sql', 'autoencerrar.sql']) await db.exec(arq(n));
await db.exec(`
  create trigger conversas_antes_update before update on public.conversas for each row execute function public.conversa_antes_update();
  create trigger conversas_apos_update after update on public.conversas for each row execute function public.conversa_status_mudou();
`);
await db.exec(arq('c1-reentrada.sql'));
await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(arq('autoencerrar-chamar-zap.sql')); await db.exec(arq('autoencerrar-chamar-zap.sql')); return { ok: true }; });

const EQ = '44444444-4444-4444-4444-444444444444', EQ2 = '55555555-5555-5555-5555-555555555555';
await db.query(`insert into public.agentes (id, papel, nome) values ($1, 'atendente', 'Ana'), ($2, 'atendente', 'Bia')`, [EQ, EQ2]);
const modo = (v) => db.query(`update public.config set valor = $1 where chave = 'autoencerrar_modo'`, [v]);
const conv = async (status = 'em_atendimento') => (await db.query(`insert into public.conversas (status, ia_ativa, agente_id) values ($1, false, $2) returning id`, [status, EQ])).rows[0].id;
const msg = (c, autor, agente = null) => db.query(`insert into public.mensagens (conversa_id, autor, agente_id, texto) values ($1, $2, $3, 'oi')`, [c, autor, agente]);
const lin = async (c) => (await db.query(`select * from public.conversas where id = $1`, [c])).rows[0];
const recuar = (c, minutos) => db.query(`update public.conversas set aguarda_paciente_desde = now() - make_interval(mins => $2) where id = $1`, [c, minutos]);
const rodar = async () => (await db.query(`select public.autoencerrar_vigiar() r`)).rows[0].r;
const limpar = () => db.exec(`delete from public.v_remarcacao_pendente; delete from public.conversa_grupo; delete from public.equipe_notificacao;
  update public.conversas set aguarda_paciente_desde = null, chamar_zap_em = null where status <> 'encerrada'`);
const euSou = (id) => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: id })]);
const H24 = 24 * 60;
const vencida = async () => { const c = await conv(); await msg(c, 'agente', EQ); await recuar(c, H24 + 5); return c; };

await caso('ligado: passou de 24 h -> MARCA para chamar no zap e NÃO fecha, não muda o status e não manda despedida', async () => {
  await limpar(); await modo('ligado');
  const c = await vencida(); const r = await rodar(); const l = await lin(c);
  const desp = (await db.query(`select count(*)::int n from public.mensagens where conversa_id = $1 and autor = 'sistema' and texto not like '%entrou na conversa%'`, [c])).rows[0].n;
  return { ok: r.marcadas === 1 && r.fechadas === 0 && l.status === 'em_atendimento' && l.chamar_zap_em !== null && l.motivo_encerramento === null && desp === 0, detalhe: JSON.stringify(r) };
});
await caso('avisa a atendente responsável (sino) uma vez só; rodar de novo não duplica nem remarca', async () => {
  await limpar(); await modo('ligado');
  const c = await vencida(); await rodar(); const a = (await lin(c)).chamar_zap_em; const r2 = await rodar(); const b = (await lin(c)).chamar_zap_em;
  const n = (await db.query(`select tipo, agente_id from public.equipe_notificacao where conversa_id = $1`, [c])).rows;
  return { ok: r2.marcadas === 0 && String(a) === String(b) && n.length === 1 && n[0].tipo === 'chamar_zap' && n[0].agente_id === EQ };
});
await caso('23h59 não marca; 24h marca', async () => {
  await limpar(); await modo('ligado');
  const a = await conv(), b = await conv(); await msg(a, 'agente', EQ); await msg(b, 'agente', EQ); await recuar(a, H24 - 1); await recuar(b, H24);
  await rodar();
  return { ok: (await lin(a)).chamar_zap_em === null && (await lin(b)).chamar_zap_em !== null };
});
await caso('simulação conta mas não marca; desligado não faz nada', async () => {
  await limpar(); await modo('simulacao'); const c = await vencida(); const r = await rodar();
  await modo('desligado'); const r2 = await rodar();
  return { ok: r.elegiveis === 1 && r.marcadas === 0 && r2.modo === 'desligado' && (await lin(c)).chamar_zap_em === null };
});
await caso('o paciente respondeu (no site) -> a marca sai e o prazo zera', async () => {
  await limpar(); await modo('ligado'); const c = await vencida(); await rodar(); await msg(c, 'cliente');
  const l = await lin(c); return { ok: l.chamar_zap_em === null && l.aguarda_paciente_desde === null && l.status === 'em_atendimento' };
});
await caso('a equipe escreveu de novo -> a marca sai e as 24 h recomeçam', async () => {
  await limpar(); await modo('ligado'); const c = await vencida(); await rodar(); await msg(c, 'agente', EQ);
  const l = await lin(c); return { ok: l.chamar_zap_em === null && l.aguarda_paciente_desde.getTime() > Date.now() - 5000 };
});
await caso('mensagem do assistente automático não tira a marca', async () => {
  await limpar(); await modo('ligado'); const c = await vencida(); await rodar(); await msg(c, 'agente');
  return { ok: (await lin(c)).chamar_zap_em !== null };
});
await caso('remarcação pendente nunca marca; conversa antiga sem marco nunca marca', async () => {
  await limpar(); await modo('ligado');
  const a = await vencida(); await db.query(`insert into public.v_remarcacao_pendente values ($1)`, [a]);
  const b = await conv();
  await rodar();
  return { ok: (await lin(a)).chamar_zap_em === null && (await lin(b)).chamar_zap_em === null };
});
await caso('pessoa unida: só marca quando TODAS as conversas abertas dela venceram', async () => {
  await limpar(); await modo('ligado');
  const a = await conv(), b = await conv(), g = '99999999-9999-9999-9999-999999999999';
  await db.query(`insert into public.conversa_grupo values ($1, $3), ($2, $3)`, [a, b, g]);
  await msg(a, 'agente', EQ); await recuar(a, H24 + 5); await msg(b, 'agente', EQ);
  const r1 = await rodar(); await recuar(b, H24 + 5); const r2 = await rodar();
  return { ok: r1.marcadas === 0 && r2.marcadas === 2 };
});
await caso('mudar de estado (encerrar, reabrir, assumir) tira a marca', async () => {
  await limpar(); await modo('ligado'); const c = await vencida(); await rodar();
  await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'outro', encerramento_origem = 'equipe' where id = $1`, [c]);
  await db.query(`update public.conversas set status = 'aguardando' where id = $1`, [c]);
  await db.query(`update public.conversas set status = 'em_atendimento' where id = $1`, [c]);
  const l = await lin(c); return { ok: l.chamar_zap_em === null && l.aguarda_paciente_desde === null };
});
await caso('transferir para outra atendente reinicia o prazo e tira a marca', async () => {
  await limpar(); await modo('ligado'); const c = await vencida(); await rodar();
  await db.query(`update public.conversas set agente_id = $2 where id = $1`, [c, EQ2]);
  const l = await lin(c); return { ok: l.chamar_zap_em === null && l.aguarda_paciente_desde.getTime() > Date.now() - 5000 };
});
await caso('"Já chamei no zap": tira a marca, grava quem e quando e recomeça as 24 h; depois de 24 h marca de novo', async () => {
  await limpar(); await modo('ligado'); const c = await vencida(); await rodar();
  await euSou(EQ); const n = (await db.query(`select public.chamar_zap_feito($1) n`, [c])).rows[0].n; const l = await lin(c);
  const ok1 = n === 1 && l.chamar_zap_em === null && l.chamar_zap_feito_por === EQ && l.chamar_zap_feito_em !== null && l.aguarda_paciente_desde.getTime() > Date.now() - 5000 && l.status === 'em_atendimento';
  await recuar(c, H24 + 5); await rodar();
  return { ok: ok1 && (await lin(c)).chamar_zap_em !== null };
});
await caso('só a equipe confirma o contato (paciente/anônimo é barrado)', async () => {
  await limpar(); await modo('ligado'); const c = await vencida(); await rodar();
  await euSou('66666666-6666-6666-6666-666666666666');
  let negado = false; try { await db.query(`select public.chamar_zap_feito($1)`, [c]); } catch { negado = true; }
  return { ok: negado && (await lin(c)).chamar_zap_em !== null };
});
await caso('resumo do administrador traz quantas estão marcadas', async () => {
  await limpar(); await modo('ligado'); const c = await vencida(); await rodar();
  const adm = '11111111-1111-1111-1111-111111111111'; await db.query(`insert into public.agentes (id, nome, papel) values ($1, 'Admin', 'admin')`, [adm]);
  await euSou(adm); const r = (await db.query(`select public.autoencerrar_resumo() r`)).rows[0].r;
  return { ok: Number(r.chamar_zap_agora) === 1 && r.ultimas[0].marcadas !== undefined && c !== null, detalhe: JSON.stringify(r) };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
