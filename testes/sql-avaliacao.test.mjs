// FLUXOGRAMA: entrada (supabase/encerramento-motivo.sql + despedida.sql + avaliacao.sql e as funções reais papel_atual e pessoa_membros, num Postgres embutido) -> validação (token da conversa; notas 0 a 10 inteiras; canal; chave ligada; fechamento elegível) -> lógica (uma avaliação por fechamento, resposta consistente ao repetir, novo fechamento pode ser avaliado de novo, Não respondido não convida, RLS fechada) -> saída (PASS/FAIL por caso).
// Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-09)
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
    add column alerta_agenda text, add column atualizado_em timestamptz default now();
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid, autor text, texto text not null check (char_length(texto) between 1 and 4000), opcoes jsonb);
  create table public.conversa_grupo (conversa_id uuid primary key, grupo_id uuid);
  create table public.v_agendamento_aberto (conversa_id uuid);
  create table public.v_remarcacao_pendente (conversa_id uuid);
  ${funcao('pessoa-unica.sql', 'pessoa_membros')}
  create function public.chat_valida(p uuid, t text) returns void language plpgsql as $$ begin if t is distinct from 'tok-' || p::text then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if; end $$;
`);
const arq = (n) => readFileSync(`${REPO}/supabase/${n}`, 'utf8');
const todos = ['encerramento-motivo.sql', 'despedida.sql', 'avaliacao.sql'];
await caso('os arquivos aplicam sem erro e podem ser aplicados de novo', async () => { for (const n of todos) await db.exec(arq(n)); for (const n of todos) await db.exec(arq(n)); return { ok: true }; });
await db.exec(`
  create trigger conversas_antes_update before update on public.conversas for each row execute function public.conversa_antes_update();
  create trigger conversas_apos_update after update on public.conversas for each row execute function public.conversa_status_mudou();
`);

const adm = '11111111-1111-1111-1111-111111111111', ate = '22222222-2222-2222-2222-222222222222';
await db.query(`insert into public.agentes (id, nome, papel) values ($1, 'Admin', 'admin'), ($2, 'Atend', 'atendente')`, [adm, ate]);
const como = (id) => db.query(`select set_config('request.jwt.claims', $1, false)`, [id ? JSON.stringify({ sub: id }) : '']);
const ativa = (v) => db.query(`update public.config set valor = $1 where chave = 'avaliacao_ativa'`, [v]);
const nova = async () => (await db.query(`insert into public.conversas (status) values ('em_atendimento') returning id`)).rows[0].id;
const fechar = (id, motivo = 'outro') => db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = $2 where id = $1`, [id, motivo]);
const tok = (id) => 'tok-' + id;
const instante = async (id) => (await db.query(`select opcoes ->> 'encerrada_em' e from public.mensagens where conversa_id = $1 and (opcoes ->> 'tipo') = 'despedida' order by id desc limit 1`, [id])).rows[0]?.e;
const estado = async (id, e) => (await db.query(`select public.chat_avaliacao_estado($1, $2, $3) r`, [id, tok(id), e ?? await instante(id)])).rows[0].r;
const avaliar = (id, a, s, c, t) => db.query(`select public.chat_avaliar($1, $2, $3, $4, $5) r`, [id, t ?? tok(id), a, s, c]);
const tenta = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };
const linhas = async (id) => (await db.query(`select nota_atendimento a, nota_site s, canal from public.avaliacao_atendimento where conversa_id = $1 order by id`, [id])).rows;

await caso('chave desligada: não convida e não grava', async () => {
  await como(adm); await ativa('nao');
  const c = await nova(); await fechar(c);
  const e = await tenta(() => avaliar(c, 5, 5, 'Google'));
  return { ok: (await estado(c)).mostrar === false && /não está disponível/.test(e) && (await linhas(c)).length === 0 };
});

await caso('ligada: convida; 0 e 10 são válidos e independentes; salva só notas e canal', async () => {
  await como(adm); await ativa('sim');
  const c = await nova(); await fechar(c);
  const antes = (await estado(c)).mostrar;
  const r = (await avaliar(c, 0, 10, 'Instagram')).rows[0].r;
  const l = await linhas(c);
  const cols = (await db.query(`select string_agg(column_name, ',' order by ordinal_position) c from information_schema.columns where table_name = 'avaliacao_atendimento'`)).rows[0].c;
  return { ok: antes === true && r.ok === true && r.nova === true && l.length === 1 && l[0].a === 0 && l[0].s === 10 && l[0].canal === 'Instagram' && !/nome|telefone|texto/.test(cols), detalhe: cols };
});

await caso('repetir a mesma solicitação devolve ok e não grava de novo; o botão some', async () => {
  const c = await nova(); await fechar(c);
  const a = (await avaliar(c, 7, 8, 'WhatsApp')).rows[0].r, b = (await avaliar(c, 7, 8, 'WhatsApp')).rows[0].r, d = (await avaliar(c, 1, 1, 'Google')).rows[0].r;
  return { ok: a.nova === true && b.ok === true && b.nova === false && d.ok === true && (await linhas(c)).length === 1 && (await linhas(c))[0].a === 7 && (await estado(c)).mostrar === false && (await estado(c)).avaliou === true };
});

await caso('valores inválidos: ausente, fracionário, fora da faixa e canal inválido ou ausente', async () => {
  const c = await nova(); await fechar(c);
  const r = [await tenta(() => avaliar(c, null, 5, 'Google')), await tenta(() => avaliar(c, 5, null, 'Google')), await tenta(() => avaliar(c, 5.5, 5, 'Google')),
    await tenta(() => avaliar(c, 11, 5, 'Google')), await tenta(() => avaliar(c, 5, -1, 'Google')), await tenta(() => avaliar(c, 5, 5, 'Facebook')), await tenta(() => avaliar(c, 5, 5, null))];
  return { ok: r.every((x) => x !== '') && (await linhas(c)).length === 0, detalhe: r.map((x) => x.slice(0, 18)).join(' | ') };
});

await caso('conversa ainda aberta ou token de outra conversa: recusado', async () => {
  const aberta = await nova(), outra = await nova(); await fechar(outra);
  const e1 = await tenta(() => avaliar(aberta, 5, 5, 'Google'));
  const e2 = await tenta(() => avaliar(outra, 5, 5, 'Google', tok(aberta)));
  const e3 = await tenta(() => db.query(`select public.chat_avaliacao_estado($1, $2, 'x')`, [outra, tok(aberta)]));
  return { ok: /depois do encerramento/.test(e1) && /não encontrada/.test(e2) && /não encontrada/.test(e3) && (await linhas(outra)).length === 0 };
});

await caso('Não respondido (encerramento automático) não convida nem aceita avaliação', async () => {
  const c = await nova(); await fechar(c, 'nao_respondido');
  const e = await tenta(() => avaliar(c, 5, 5, 'Google'));
  return { ok: (await estado(c)).mostrar === false && /não tem convite/.test(e) };
});

await caso('fechamento antigo sem despedida marcada (histórico anterior à atualização) não aceita avaliação', async () => {
  const c = await nova(); await fechar(c); await db.query(`delete from public.mensagens where conversa_id = $1`, [c]);
  const e = await tenta(() => avaliar(c, 5, 5, 'Google'));
  return { ok: /não tem convite/.test(e) };
});

await caso('reabrir e fechar de novo: só o fechamento atual convida, e cada fechamento tem a sua avaliação', async () => {
  const c = await nova(); await fechar(c); const e1 = await instante(c);
  await avaliar(c, 9, 9, 'Google');
  await db.query(`update public.conversas set status = 'aguardando' where id = $1`, [c]);
  const aberta = (await estado(c, e1)).mostrar;
  await db.query(`select pg_sleep(0.01)`); await fechar(c); const e2 = await instante(c);
  const velho = (await estado(c, e1)).mostrar, atual = (await estado(c, e2)).mostrar;
  await avaliar(c, 3, 4, 'WhatsApp');
  return { ok: aberta === false && velho === false && atual === true && (await linhas(c)).length === 2 && e1 !== e2 };
});

await caso('avaliar não muda a conversa nem o histórico', async () => {
  const c = await nova(); await fechar(c);
  const n0 = (await db.query(`select count(*)::int n from public.mensagens where conversa_id = $1`, [c])).rows[0].n;
  await avaliar(c, 6, 6, 'Google');
  const n1 = (await db.query(`select count(*)::int n from public.mensagens where conversa_id = $1`, [c])).rows[0].n;
  const st = (await db.query(`select status, motivo_encerramento m from public.conversas where id = $1`, [c])).rows[0];
  return { ok: n0 === n1 && st.status === 'encerrada' && st.m === 'outro' };
});

await caso('resumo agregado só para administrador; a tabela não é lida direto por quem usa a API', async () => {
  await como(adm);
  const r = (await db.query(`select public.avaliacoes_resumo(30) r`)).rows[0].r;
  await como(ate); const e = await tenta(() => db.query(`select public.avaliacoes_resumo(30)`));
  await db.exec(`set role authenticated`);
  const lidas = (await db.query(`select count(*)::int n from public.avaliacao_atendimento`)).rows[0].n;
  await db.exec(`reset role`);
  return { ok: r.total >= 5 && r.media_atendimento !== null && typeof r.por_canal === 'object' && !!e && lidas === 0, detalhe: JSON.stringify(r) };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
