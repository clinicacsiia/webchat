// FLUXOGRAMA: entrada (supabase/c1-reentrada.sql sobre encerramento-motivo, despedida e autoencerrar, num Postgres embutido com dados inventados) -> validação (token da conversa antiga; janela de 2 dias; fechada por "nova conversa" não reabre) -> lógica (encerra a antiga e abre a nova numa chamada, motivo da reentrada informado x automático, transferência reinicia 24 h, inatividade com texto próprio e aviso à equipe, exame em aberto não impede mas remarcação sim) -> saída (PASS/FAIL por caso)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (Etapa C1)
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
  create function public.agendamento_preparar_remarcacao(d uuid, o uuid) returns boolean language plpgsql as $$ begin insert into public.remarcacoes_herdadas values (d, o); return true; end $$;
  -- stub: o chat_iniciar real já existe no banco; aqui só cria a conversa e o token
  create function public.chat_iniciar(p_nome text, p_telefone text, p_email text default null, p_mensagem text default null, p_aceite boolean default false, p_origem text default null,
    p_unidade text default null, p_medico text default null, p_paciente_tipo text default 'proprio', p_paciente_nome text default null, p_irmaos jsonb default null, p_irmaos_modo text default null) returns jsonb
  language plpgsql security definer set search_path to '' as $$
  declare v uuid; t text; begin
    insert into public.conversas (status) values ('aguardando') returning id into v;
    insert into public.conversa_segredo (conversa_id) values (v) returning token into t;
    if nullif(p_mensagem, '') is not null then insert into public.mensagens (conversa_id, autor, texto) values (v, 'cliente', p_mensagem); end if;
    return jsonb_build_object('conversa_id', v, 'token', t, 'motor', 'fluxo', 'respostas', '[]'::jsonb); end $$;
`);
const arq = (n) => readFileSync(`${REPO}/supabase/${n}`, 'utf8');
for (const n of ['encerramento-motivo.sql', 'despedida.sql', 'autoencerrar.sql']) await db.exec(arq(n));
await db.exec(`
  create trigger conversas_antes_update before update on public.conversas for each row execute function public.conversa_antes_update();
  create trigger conversas_apos_update after update on public.conversas for each row execute function public.conversa_status_mudou();
  create function public.stub_evento_criada() returns trigger language plpgsql as $$ begin insert into public.conversa_evento (conversa_id, tipo) values (new.id, 'criada'); return new; end $$;
  create trigger conversas_evento_stub after insert on public.conversas for each row execute function public.stub_evento_criada();
`);
await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(arq('c1-reentrada.sql')); await db.exec(arq('c1-reentrada.sql')); return { ok: true }; });

const AG = '44444444-4444-4444-4444-444444444444', AG2 = '55555555-5555-5555-5555-555555555555';
await db.query(`insert into public.agentes (id, papel, nome) values ($1, 'atendente', 'Ana'), ($2, 'atendente', 'Bia')`, [AG, AG2]);
const nova = async (status = 'aguardando', extra = '') => { const r = (await db.query(`insert into public.conversas (status ${extra ? ', ' + extra.split('=')[0] : ''}) values ($1 ${extra ? ', ' + extra.split('=')[1] : ''}) returning id`, [status])).rows[0].id; await db.query(`insert into public.conversa_segredo (conversa_id) values ($1)`, [r]); return r; };
const tok = async (c) => (await db.query(`select token from public.conversa_segredo where conversa_id = $1`, [c])).rows[0].token;
const lin = async (c) => (await db.query(`select * from public.conversas where id = $1`, [c])).rows[0];
const NC = (ant, t, extra = {}) => db.query(`select public.chat_nova_conversa($1, $2, 'Ana', '71999990000', 'a@b.co', true, $3, null, null, null, 'proprio', null, null, null, $4, $5) r`, [ant, t, extra.previsao ?? true, extra.motivo ?? null, extra.texto ?? null]).then((x) => x.rows[0].r);
const erro = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

await caso('nova conversa com a antiga ABERTA: encerra a antiga (motivo nova_conversa, origem paciente), liga a nova a ela e guarda o aceite da previsão', async () => {
  const a = await nova('aguardando'); const r = await NC(a, await tok(a));
  const ant = await lin(a), n = await lin(r.conversa_id);
  return { ok: ant.status === 'encerrada' && ant.motivo_encerramento === 'nova_conversa' && ant.encerramento_origem === 'paciente' && n.reentrada_de === a && n.previsao_aceita_em !== null && n.status === 'aguardando' };
});
await caso('token errado: não encerra nada e a nova não é criada', async () => {
  const a = await nova('aguardando'); const antes = (await db.query(`select count(*)::int n from public.conversas`)).rows[0].n;
  const e = await erro(() => NC(a, 'token-errado')); const dep = (await db.query(`select count(*)::int n from public.conversas`)).rows[0].n;
  return { ok: e && e.message.includes('Conversa não encontrada') && antes === dep && (await lin(a)).status === 'aguardando' };
});
await caso('motivo informado "outro assunto" + texto: texto vira a PRIMEIRA MENSAGEM e só a categoria é guardada', async () => {
  const a = await nova('aguardando'); const r = await NC(a, await tok(a), { motivo: 'outro_assunto', texto: 'quero remarcar a ultrassom' });
  const n = await lin(r.conversa_id); const m = (await db.query(`select texto from public.mensagens where conversa_id = $1`, [r.conversa_id])).rows;
  return { ok: n.reentrada_motivo === 'outro_assunto' && n.reentrada_texto_informado === true && m.length === 1 && m[0].texto === 'quero remarcar a ultrassom' };
});
await caso('regra automática: anterior do mesmo dia SEM resposta de pessoa -> sem_retorno; COM resposta -> outro_assunto', async () => {
  const a = await nova('aguardando'); const r1 = await NC(a, await tok(a));
  const b = await nova('aguardando'); await db.query(`update public.conversas set primeiro_humano_em = now() where id = $1`, [b]); const r2 = await NC(b, await tok(b));
  return { ok: (await lin(r1.conversa_id)).reentrada_motivo_auto === 'sem_retorno' && (await lin(r2.conversa_id)).reentrada_motivo_auto === 'outro_assunto' };
});
await caso('anterior de OUTRO dia: o motivo não é gravado (a pergunta só vale no mesmo dia)', async () => {
  const a = await nova('encerrada'); await db.query(`update public.conversas set criado_em = now() - interval '3 days' where id = $1`, [a]);
  const r = await NC(a, await tok(a), { motivo: 'sem_retorno' }); const n = await lin(r.conversa_id);
  return { ok: n.reentrada_motivo === null && n.reentrada_motivo_auto === null && n.reentrada_de === a };
});
await caso('duas abas: a segunda chamada devolve a MESMA conversa nova (nada de duas)', async () => {
  const a = await nova('aguardando'); const t = await tok(a);
  const r1 = await NC(a, t), r2 = await NC(a, t);
  const qtd = (await db.query(`select count(*)::int n from public.conversas where reentrada_de = $1`, [a])).rows[0].n;
  return { ok: r1.conversa_id === r2.conversa_id && r2.repetida === true && qtd === 1 };
});
await caso('anterior EM ATENDIMENTO por pessoa: a atendente recebe aviso no sino', async () => {
  const a = await nova('em_atendimento'); await db.query(`update public.conversas set agente_id = $2 where id = $1`, [a, AG]);
  await NC(a, await tok(a));
  const n = (await db.query(`select tipo from public.equipe_notificacao where agente_id = $1`, [AG])).rows;
  return { ok: n.length === 1 && n[0].tipo === 'paciente_abriu_nova' };
});
await caso('remarcação pendente passa para a conversa nova', async () => {
  const a = await nova('aguardando'); await db.query(`insert into public.v_remarcacao_pendente values ($1)`, [a]);
  const r = await NC(a, await tok(a));
  const h = (await db.query(`select * from public.remarcacoes_herdadas where origem = $1`, [a])).rows;
  await db.query(`delete from public.v_remarcacao_pendente`);
  return { ok: h.length === 1 && h[0].destino === r.conversa_id };
});
await caso('estado: encerrada há 1 dia pode voltar; há 3 dias não; fechada pelo paciente não', async () => {
  const a = await nova('encerrada'); await db.query(`update public.conversas set encerrada_em = now() - interval '1 day' where id = $1`, [a]);
  const b = await nova('encerrada'); await db.query(`update public.conversas set encerrada_em = now() - interval '3 days' where id = $1`, [b]);
  const c = await nova('encerrada'); await db.query(`update public.conversas set encerrada_em = now() - interval '1 hour', encerramento_origem = 'paciente' where id = $1`, [c]);
  const s = async (x) => (await db.query(`select public.chat_reentrada_estado($1, $2) r`, [x, await tok(x)])).rows[0].r;
  const [ea, eb, ec] = [await s(a), await s(b), await s(c)];
  return { ok: ea.pode_voltar === true && eb.pode_voltar === false && ec.pode_voltar === false && ea.janela_dias === 2, detalhe: JSON.stringify([ea.pode_voltar, eb.pode_voltar, ec.pode_voltar]) };
});
const enviar = (c, t) => db.query(`select public.chat_enviar($1, $2, 'oi') r`, [c, t]);
await caso('escrever numa conversa encerrada há 1 dia REABRE; há 3 dias é RECUSADO com mensagem clara', async () => {
  const a = await nova('encerrada'); await db.query(`update public.conversas set encerrada_em = now() - interval '1 day' where id = $1`, [a]); await enviar(a, await tok(a));
  const b = await nova('encerrada'); await db.query(`update public.conversas set encerrada_em = now() - interval '3 days' where id = $1`, [b]);
  const e = await erro(async () => enviar(b, await tok(b)));
  return { ok: (await lin(a)).status === 'aguardando' && e && /mais de 2 dias/.test(e.message) && (await lin(b)).status === 'encerrada', detalhe: e && e.message };
});
await caso('conversa fechada pelo paciente ("nova conversa") NÃO reabre por mensagem (aba velha)', async () => {
  const a = await nova('aguardando'); const t = await tok(a); await NC(a, t);
  const e = await erro(() => enviar(a, t));
  return { ok: e && /abriu uma nova/.test(e.message) && (await lin(a)).status === 'encerrada' };
});
await caso('mudar a janela em config.reabrir_dias vale na hora', async () => {
  await db.query(`update public.config set valor = '5' where chave = 'reabrir_dias'`);
  const b = await nova('encerrada'); await db.query(`update public.conversas set encerrada_em = now() - interval '3 days' where id = $1`, [b]); await enviar(b, await tok(b));
  await db.query(`update public.config set valor = '2' where chave = 'reabrir_dias'`);
  return { ok: (await lin(b)).status === 'aguardando' };
});

// ---- inatividade ----
await db.query(`update public.config set valor = 'ligado' where chave = 'autoencerrar_modo'`);
const vencida = async (extraSql = '') => { const c = await nova('em_atendimento'); await db.query(`update public.conversas set agente_id = $2, aguarda_paciente_desde = now() - interval '25 hours' where id = $1`, [c, AG]); return c; };
await caso('inatividade: fecha, publica o TEXTO PRÓPRIO (uma vez, sem despedida única) e avisa a atendente', async () => {
  const c = await vencida(); const r = (await db.query(`select public.autoencerrar_vigiar() r`)).rows[0].r;
  const m = (await db.query(`select texto from public.mensagens where conversa_id = $1 and autor = 'sistema'`, [c])).rows;
  const n = (await db.query(`select tipo from public.equipe_notificacao where conversa_id = $1`, [c])).rows;
  const l = await lin(c);
  return { ok: l.status === 'encerrada' && l.encerramento_origem === 'inatividade' && m.filter((x) => /24 horas/.test(x.texto)).length === 1 && n.length === 1 && n[0].tipo === 'autoencerrada', detalhe: JSON.stringify(r) };
});
await caso('exame/pedido em aberto NÃO impede mais o fechamento; remarcação pendente CONTINUA impedindo', async () => {
  const a = await vencida(); await db.query(`insert into public.v_agendamento_aberto values ($1)`, [a]);
  const b = await vencida(); await db.query(`insert into public.v_remarcacao_pendente values ($1)`, [b]);
  await db.query(`select public.autoencerrar_vigiar()`);
  await db.exec(`delete from public.v_agendamento_aberto; delete from public.v_remarcacao_pendente`);
  return { ok: (await lin(a)).status === 'encerrada' && (await lin(b)).status === 'em_atendimento' };
});
await caso('transferir para outra pessoa REINICIA as 24 h (e quem não aguarda o paciente não ganha prazo)', async () => {
  const c = await vencida(); await db.query(`update public.conversas set agente_id = $2 where id = $1`, [c, AG2]);
  const d = await nova('em_atendimento'); await db.query(`update public.conversas set agente_id = $2 where id = $1`, [d, AG]); await db.query(`update public.conversas set agente_id = $2 where id = $1`, [d, AG2]);
  const n = await lin(c), m = await lin(d);
  await db.query(`select public.autoencerrar_vigiar()`);
  return { ok: (Date.now() - n.aguarda_paciente_desde.getTime()) < 60000 && m.aguarda_paciente_desde === null && (await lin(c)).status === 'em_atendimento' };
});
await caso('simulação/desligado: a rotina não fecha nem avisa', async () => {
  await db.query(`update public.config set valor = 'desligado' where chave = 'autoencerrar_modo'`);
  const c = await vencida(); await db.query(`select public.autoencerrar_vigiar()`);
  return { ok: (await lin(c)).status === 'em_atendimento' };
});

console.log(`\n${resultados.filter(Boolean).length}/${resultados.length} verificações passaram`);
process.exit(resultados.every(Boolean) ? 0 : 1);
