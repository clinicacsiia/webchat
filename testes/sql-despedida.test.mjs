// FLUXOGRAMA: entrada (supabase/encerramento-motivo.sql + despedida.sql e as funções reais papel_atual e pessoa_membros, num Postgres embutido) -> validação (só administrador salva; imagem conferida pelos bytes; limites; RLS fechada nas versões) -> lógica (versão imutável por salvamento, uma despedida por fechamento, texto/imagem/ambos/nenhum, imagem só para quem tem a conversa) -> saída (PASS/FAIL por caso).
// Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-05 e WC-06)
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
  create function public.chat_valida(p uuid, t text) returns void language plpgsql as $$ begin if t is distinct from 'ok' then raise exception 'Token inválido' using errcode = '28000'; end if; end $$;
`);
const sql1 = readFileSync(`${REPO}/supabase/encerramento-motivo.sql`, 'utf8'), sql2 = readFileSync(`${REPO}/supabase/despedida.sql`, 'utf8');
await caso('os arquivos aplicam sem erro e podem ser aplicados de novo', async () => { await db.exec(sql1); await db.exec(sql2); await db.exec(sql1); await db.exec(sql2); return { ok: true }; });
await db.exec(`
  create trigger conversas_antes_update before update on public.conversas for each row execute function public.conversa_antes_update();
  create trigger conversas_apos_update after update on public.conversas for each row execute function public.conversa_status_mudou();
`);

const adm = '11111111-1111-1111-1111-111111111111', ate = '22222222-2222-2222-2222-222222222222', mkt = '33333333-3333-3333-3333-333333333333';
await db.query(`insert into public.agentes (id, nome, papel) values ($1, 'Admin', 'admin'), ($2, 'Atend', 'atendente'), ($3, 'Mkt', 'marketing')`, [adm, ate, mkt]);
const como = (id) => db.query(`select set_config('request.jwt.claims', $1, false)`, [id ? JSON.stringify({ sub: id }) : '']);
const liga = (v) => db.query(`update public.config set valor = $1 where chave = 'despedida_configurada'`, [v]);
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const jpg = Buffer.from('ffd8ffe000104a46494600010100', 'hex').toString('base64');
const salvar = (t, m, b) => db.query(`select public.despedida_salvar($1, $2, $3) r`, [t, m, b]);
const tenta = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };
const nova = async () => (await db.query(`insert into public.conversas (status) values ('em_atendimento') returning id`)).rows[0].id;
const fechar = (id) => db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'outro' where id = $1`, [id]);
const desp = async (id) => (await db.query(`select texto, opcoes from public.mensagens where conversa_id = $1 and (opcoes ->> 'tipo') = 'despedida' order by id`, [id])).rows;
const PADRAO = 'Atendimento encerrado. Se precisar, é só mandar uma nova mensagem.';

await caso('chave desligada: a frase de hoje, uma vez, marcada como despedida sem versão', async () => {
  await como(adm); await liga('nao');
  const c = await nova(); await fechar(c); const d = await desp(c);
  const todas = (await db.query(`select count(*)::int n from public.mensagens where conversa_id = $1 and autor = 'sistema'`, [c])).rows[0].n;
  return { ok: d.length === 1 && d[0].texto === PADRAO && d[0].opcoes.versao === null && d[0].opcoes.imagem === false && todas === 1 };
});

await caso('ligada, mas sem nada salvo: frase padrão (D4)', async () => {
  await como(adm); await liga('sim');
  const c = await nova(); await fechar(c); const d = await desp(c);
  return { ok: d.length === 1 && d[0].texto === PADRAO && d[0].opcoes.versao === null };
});

let v1;
await caso('texto apenas: a mensagem leva o texto e a versão', async () => {
  await como(adm); await liga('sim');
  v1 = (await salvar('Obrigado por falar com a CSI. Volte sempre!', null, null)).rows[0].r.versao;
  const c = await nova(); await fechar(c); const d = await desp(c);
  return { ok: d[0].texto === 'Obrigado por falar com a CSI. Volte sempre!' && String(d[0].opcoes.versao) === String(v1) && d[0].opcoes.imagem === false };
});

let cImg, v2;
await caso('imagem apenas: texto padrão + imagem; só a conversa que a recebeu consegue ver a imagem', async () => {
  await como(adm); v2 = (await salvar(null, 'image/png', png)).rows[0].r.versao;
  cImg = await nova(); await fechar(cImg); const d = await desp(cImg);
  const outra = await nova();
  const minha = (await db.query(`select public.chat_despedida_imagem($1, 'ok', $2) r`, [cImg, v2])).rows[0].r;
  const alheia = (await db.query(`select public.chat_despedida_imagem($1, 'ok', $2) r`, [outra, v2])).rows[0].r;
  const semToken = await tenta(() => db.query(`select public.chat_despedida_imagem($1, 'errado', $2)`, [cImg, v2]));
  return { ok: d[0].texto === PADRAO && d[0].opcoes.imagem === true && minha?.mime === 'image/png' && minha.base64 === png && alheia === null && /Token/.test(semToken) };
});

await caso('texto e imagem juntos', async () => {
  await como(adm); const v = (await salvar('Até logo!', 'image/jpeg', jpg)).rows[0].r.versao;
  const c = await nova(); await fechar(c); const d = await desp(c);
  return { ok: d[0].texto === 'Até logo!' && d[0].opcoes.imagem === true && String(d[0].opcoes.versao) === String(v) };
});

await caso('mudar a configuração depois não altera o que já foi entregue (versão imutável)', async () => {
  await como(adm);
  const antes = await desp(cImg);
  await salvar('Texto novo', null, null);
  const depois = await desp(cImg);
  const img = (await db.query(`select public.chat_despedida_imagem($1, 'ok', $2) r`, [cImg, v2])).rows[0].r;
  return { ok: JSON.stringify(antes) === JSON.stringify(depois) && img?.base64 === png };
});

await caso('os dois vazios voltam para a frase padrão', async () => {
  await como(adm); await salvar('  ', null, null);
  const c = await nova(); await fechar(c); const d = await desp(c);
  return { ok: d[0].texto === PADRAO && d[0].opcoes.versao === null };
});

await caso('repetir o evento de encerramento não duplica a despedida', async () => {
  await como(adm); const c = await nova(); await fechar(c);
  const e = (await db.query(`select encerrada_em from public.conversas where id = $1`, [c])).rows[0].encerrada_em;
  await db.query(`select public.despedida_publicar($1, $2)`, [c, e]); await db.query(`select public.despedida_publicar($1, $2)`, [c, e]);
  return { ok: (await desp(c)).length === 1 };
});

await caso('reabrir e encerrar de novo gera a própria despedida do novo fechamento', async () => {
  await como(adm); await salvar('Primeira', null, null);
  const c = await nova(); await fechar(c);
  await db.query(`update public.conversas set status = 'aguardando' where id = $1`, [c]);
  await db.query(`select pg_sleep(0.01)`); await salvar('Segunda', null, null); await fechar(c);
  const d = await desp(c);
  return { ok: d.length === 2 && d[0].texto === 'Primeira' && d[1].texto === 'Segunda' };
});

await caso('só o administrador salva; atendente lê a configuração; marketing não', async () => {
  await como(ate); const e1 = await tenta(() => salvar('x', null, null));
  const lido = (await db.query(`select public.despedida_atual() r`)).rows[0].r;
  await como(mkt); const e2 = await tenta(() => db.query(`select public.despedida_atual()`));
  return { ok: /administrador/.test(e1) && lido.ativa === true && !!e2 };
});

await caso('validações: texto longo, mime errado, bytes que não são da imagem, arquivo grande, base64 quebrado', async () => {
  await como(adm);
  const r = [
    await tenta(() => salvar('a'.repeat(601), null, null)),
    await tenta(() => salvar(null, 'application/pdf', png)),
    await tenta(() => salvar(null, 'image/png', Buffer.from('isto nao e uma imagem').toString('base64'))),
    await tenta(() => salvar(null, 'image/jpeg', png)),
    await tenta(() => salvar(null, 'image/png', 'A'.repeat(2800001))),
    await tenta(() => salvar(null, 'image/png', '%%%')),
  ];
  return { ok: r.every((x) => x !== ''), detalhe: r.map((x) => x.slice(0, 25)).join(' | ') };
});

await caso('texto com marcação é guardado como texto puro (o chat o mostra sem interpretar)', async () => {
  await como(adm); await salvar('<script>alert(1)</script> Obrigado', null, null);
  const c = await nova(); await fechar(c); const d = await desp(c);
  return { ok: d[0].texto === '<script>alert(1)</script> Obrigado' };
});

await caso('RLS: quem usa a API não lê nem altera as versões direto', async () => {
  await como(adm);
  await db.exec(`set role authenticated`);
  const lidas = (await db.query(`select count(*)::int n from public.despedida_versao`)).rows[0].n;
  const alt = await db.query(`update public.despedida_versao set texto = 'hack'`);
  await db.exec(`reset role`);
  const hack = (await db.query(`select count(*)::int n from public.despedida_versao where texto = 'hack'`)).rows[0].n;
  return { ok: lidas === 0 && (alt.affectedRows ?? 0) === 0 && hack === 0 };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
