// FLUXOGRAMA: entrada (supabase/autoencerrar-fechar-48h.sql sobre autoencerrar-chamar-zap.sql, num Postgres embutido) -> validação (chave autoencerrar_fechar_modo desligado/simulação/ligado; 47h59 x 48h; remarcação pendente; pessoa unida; conversa antiga sem marco) -> lógica (24 h só marca; 48 h encerra como Não respondido/inatividade, manda despedida uma vez, avisa a atendente e registra; resposta do paciente ou nova mensagem da equipe impede) -> saída (PASS/FAIL por caso).
// Versão 1.0 — 12/11/2026 / Mudança: Implementação inicial (fechar por inatividade em 48 h)
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
await db.exec(arq('autoencerrar-chamar-zap.sql'));
await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(arq('autoencerrar-fechar-48h.sql')); await db.exec(arq('autoencerrar-fechar-48h.sql')); return { ok: true }; });

const EQ = '44444444-4444-4444-4444-444444444444';
await db.query(`insert into public.agentes (id, papel, nome) values ($1, 'atendente', 'Ana')`, [EQ]);
const cfg = (k, v) => db.query(`update public.config set valor = $2 where chave = $1`, [k, v]);
const conv = async () => (await db.query(`insert into public.conversas (status, ia_ativa, agente_id) values ('em_atendimento', false, $1) returning id`, [EQ])).rows[0].id;
const msg = (c, autor, agente = null) => db.query(`insert into public.mensagens (conversa_id, autor, agente_id, texto) values ($1, $2, $3, 'oi')`, [c, autor, agente]);
const lin = async (c) => (await db.query(`select * from public.conversas where id = $1`, [c])).rows[0];
const recuar = (c, min) => db.query(`update public.conversas set aguarda_paciente_desde = now() - make_interval(mins => $2) where id = $1`, [c, min]);
const rodar = async () => (await db.query(`select public.autoencerrar_vigiar() r`)).rows[0].r;
const limpar = () => db.exec(`delete from public.v_remarcacao_pendente; delete from public.conversa_grupo; delete from public.equipe_notificacao;
  update public.conversas set aguarda_paciente_desde = null, chamar_zap_em = null where status <> 'encerrada'`);
const H = 60, H24 = 24 * H, H48 = 48 * H;
const vencida = async (min = H48 + 5) => { const c = await conv(); await msg(c, 'agente', EQ); await recuar(c, min); return c; };
const despedidas = async (c) => (await db.query(`select count(*)::int n from public.mensagens where conversa_id = $1 and autor = 'sistema' and opcoes->>'tipo' = 'despedida'`, [c])).rows[0].n;

await caso('a chave nasce desligada e o prazo padrão é 48 h', async () => {
  const r = (await db.query(`select valor, public.autoencerrar_fechar_horas() h from public.config where chave = 'autoencerrar_fechar_modo'`)).rows[0];
  return { ok: r.valor === 'desligado' && r.h === 48 };
});
await caso('ligado: 48 h sem resposta -> encerra como Não respondido / inatividade, com despedida, aviso e registro', async () => {
  await limpar(); await cfg('autoencerrar_modo', 'ligado'); await cfg('autoencerrar_fechar_modo', 'ligado');
  const c = await vencida(); const r = await rodar(); const l = await lin(c);
  const fech = (await db.query(`select count(*)::int n from public.autoencerramento_fechada where conversa_id = $1`, [c])).rows[0].n;
  const not = (await db.query(`select tipo from public.equipe_notificacao where conversa_id = $1 and tipo = 'autoencerrada'`, [c])).rows.length;
  const hist = (await db.query(`select motivo, origem from public.conversa_encerramento where conversa_id = $1`, [c])).rows[0];
  return { ok: r.fechadas === 1 && l.status === 'encerrada' && l.motivo_encerramento === 'nao_respondido' && l.encerramento_origem === 'inatividade' && l.chamar_zap_em === null
    && fech === 1 && not === 1 && hist && hist.origem === 'inatividade' && await despedidas(c) <= 1, detalhe: JSON.stringify(r) };
});
await caso('entre 24 h e 48 h só marca "Chamar no WhatsApp"; não fecha', async () => {
  await limpar(); await cfg('autoencerrar_modo', 'ligado'); await cfg('autoencerrar_fechar_modo', 'ligado');
  const c = await vencida(H24 + 5); const r = await rodar(); const l = await lin(c);
  return { ok: r.marcadas === 1 && r.fechadas === 0 && l.status === 'em_atendimento' && l.chamar_zap_em !== null, detalhe: JSON.stringify(r) };
});
await caso('marcada às 24 h e sem resposta, fecha às 48 h (a marca sai junto)', async () => {
  await limpar(); await cfg('autoencerrar_modo', 'ligado'); await cfg('autoencerrar_fechar_modo', 'ligado');
  const c = await vencida(H24 + 5); await rodar(); await recuar(c, H48 + 5); const r = await rodar(); const l = await lin(c);
  return { ok: r.fechadas === 1 && l.status === 'encerrada' && l.chamar_zap_em === null };
});
await caso('47h59 não fecha; 48h fecha', async () => {
  await limpar(); await cfg('autoencerrar_modo', 'desligado'); await cfg('autoencerrar_fechar_modo', 'ligado');
  const a = await vencida(H48 - 1), b = await vencida(H48); await rodar();
  return { ok: (await lin(a)).status === 'em_atendimento' && (await lin(b)).status === 'encerrada' };
});
await caso('fechar funciona sozinho (aviso de 24 h desligado) e desligado não faz nada', async () => {
  await limpar(); await cfg('autoencerrar_modo', 'desligado'); await cfg('autoencerrar_fechar_modo', 'desligado');
  const c = await vencida(); const r0 = await rodar(); const aberta = (await lin(c)).status === 'em_atendimento';
  await cfg('autoencerrar_fechar_modo', 'ligado'); const r1 = await rodar();
  return { ok: r0.modo === 'desligado' && aberta && r1.fechadas === 1 && (await lin(c)).status === 'encerrada' };
});
await caso('simulação conta mas não fecha', async () => {
  await limpar(); await cfg('autoencerrar_modo', 'desligado'); await cfg('autoencerrar_fechar_modo', 'simulacao');
  const c = await vencida(); const r = await rodar();
  return { ok: r.fechar_elegiveis === 1 && r.fechadas === 0 && (await lin(c)).status === 'em_atendimento' };
});
await caso('o paciente respondeu -> não fecha; a equipe escreveu de novo -> as 48 h recomeçam', async () => {
  await limpar(); await cfg('autoencerrar_fechar_modo', 'ligado');
  const a = await vencida(), b = await vencida(); await msg(a, 'cliente'); await msg(b, 'agente', EQ); await rodar();
  return { ok: (await lin(a)).status === 'em_atendimento' && (await lin(b)).status === 'em_atendimento' };
});
await caso('remarcação pendente nunca fecha; conversa antiga sem marco nunca fecha', async () => {
  await limpar(); await cfg('autoencerrar_fechar_modo', 'ligado');
  const a = await vencida(); await db.query(`insert into public.v_remarcacao_pendente values ($1)`, [a]); const b = await conv(); await rodar();
  return { ok: (await lin(a)).status === 'em_atendimento' && (await lin(b)).status === 'em_atendimento' };
});
await caso('pessoa unida: só fecha quando TODAS as conversas abertas dela passaram de 48 h', async () => {
  await limpar(); await cfg('autoencerrar_fechar_modo', 'ligado');
  const a = await conv(), b = await conv(), g = '99999999-9999-9999-9999-999999999999';
  await db.query(`insert into public.conversa_grupo values ($1, $3), ($2, $3)`, [a, b, g]);
  await msg(a, 'agente', EQ); await recuar(a, H48 + 5); await msg(b, 'agente', EQ); await recuar(b, H24);
  const r1 = await rodar(); await recuar(b, H48 + 5); const r2 = await rodar();
  return { ok: r1.fechadas === 0 && r2.fechadas === 2 };
});
await caso('"Já chamei no zap" recomeça a contagem: não fecha logo depois', async () => {
  await limpar(); await cfg('autoencerrar_modo', 'ligado'); await cfg('autoencerrar_fechar_modo', 'ligado');
  const c = await vencida(H24 + 5); await rodar();
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: EQ })]);
  await db.query(`select public.chamar_zap_feito($1)`, [c]); await rodar();
  return { ok: (await lin(c)).status === 'em_atendimento' };
});
await caso('resumo do administrador traz a chave, o prazo e quantas fechariam agora', async () => {
  await limpar(); await cfg('autoencerrar_fechar_modo', 'simulacao'); await vencida();
  const adm = '11111111-1111-1111-1111-111111111111'; await db.query(`insert into public.agentes (id, nome, papel) values ($1, 'Admin', 'admin')`, [adm]);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: adm })]);
  const r = (await db.query(`select public.autoencerrar_resumo() r`)).rows[0].r;
  return { ok: r.fechar_modo === 'simulacao' && r.fechar_horas === 48 && Number(r.fechar_elegiveis_agora) === 1, detalhe: JSON.stringify(r) };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
