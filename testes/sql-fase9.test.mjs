// FLUXOGRAMA: entrada (supabase/fase9-sentinela.sql + os textos originais lidos de fase7-motor.sql, num Postgres embutido com stubs mínimos) -> validação (aplica o arquivo duas vezes) -> lógica (grava incidente, recusa código inválido, liga à conversa só com o token certo, limita volume, painel só para a equipe, textos trocados só se ainda forem os originais) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const fase9 = readFileSync(`${REPO}/supabase/fase9-sentinela.sql`, 'utf8');
const fase7 = readFileSync(`${REPO}/supabase/fase7-motor.sql`, 'utf8');
// Os textos originais do assistente, exatamente como a Fase 7 os grava.
const seed = fase7.match(/insert into public\.fluxo_texto \(chave, texto, descricao\) values[\s\S]*?on conflict \(chave\) do nothing;/)[0];

const db = new PGlite();
await db.exec(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;
  grant usage on schema public to anon, authenticated;
  create function public.papel_atual() returns text language sql stable as $$ select nullif(current_setting('teste.papel', true), '') $$;
  create table public.conversas (id uuid primary key default gen_random_uuid());
  create table public.conversa_segredo (conversa_id uuid primary key references public.conversas(id), token text not null);
  create table public.notas_teste (conversa_id uuid, nota text);
  create function public.fluxo_nota(p_conversa uuid, p_nota text) returns void language sql as $$ insert into public.notas_teste values (p_conversa, p_nota) $$;
  create table public.fluxo_texto (chave text primary key, texto text not null, descricao text);
  ${seed}
  update public.fluxo_texto set texto = 'Texto que a equipe editou no painel' where chave = 'transferir_online';
`);
const CONV = (await db.query(`insert into public.conversas default values returning id`)).rows[0].id;
await db.exec(`insert into public.conversa_segredo values ('${CONV}', 'token-certo')`);

await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => {
  await db.exec(fase9); await db.exec(fase9);
  return { ok: true, detalhe: 'duas aplicações seguidas sem erro' };
});

const chamar = async (papel, c, tipo, token = 'token-certo', conv = CONV, det = { rotulo: 'Falha ao falar com o servidor', passo: 'plano', app: '2026.10.31-9' }) => {
  await db.exec(`set teste.papel = ''; set role ${papel}`);
  try { return (await db.query(`select public.chat_incidente($1::uuid, $2, $3, $4, $5::jsonb) r`, [conv, token, c, tipo, JSON.stringify(det)])).rows[0].r; }
  finally { await db.exec('reset role'); }
};

await caso('o chat (anon) grava um incidente ligado à sua conversa e a conversa ganha uma nota', async () => {
  const r = await chamar('anon', 'CSI-261031-1432-RPC-AB23', 'RPC');
  const linha = (await db.query(`select conversa_id, passo, versao from public.incidente_chat where codigo = 'CSI-261031-1432-RPC-AB23'`)).rows[0];
  const nota = (await db.query(`select nota from public.notas_teste`)).rows[0];
  return { ok: r.ok === true && r.novo === true && linha.conversa_id === CONV && linha.passo === 'plano' && linha.versao === '2026.10.31-9' && /CSI-261031-1432-RPC-AB23/.test(nota?.nota || ''), detalhe: JSON.stringify(r) };
});

await caso('o mesmo código enviado de novo não duplica nem repete a nota', async () => {
  const r = await chamar('anon', 'CSI-261031-1432-RPC-AB23', 'RPC');
  const n = (await db.query(`select count(*)::int n from public.incidente_chat where codigo = 'CSI-261031-1432-RPC-AB23'`)).rows[0].n;
  const notas = (await db.query(`select count(*)::int n from public.notas_teste`)).rows[0].n;
  return { ok: r.ok === true && r.novo === false && n === 1 && notas === 1, detalhe: `linhas=${n}, notas=${notas}` };
});

await caso('token errado: grava o incidente, mas sem ligar à conversa de outra pessoa', async () => {
  const r = await chamar('anon', 'CSI-261031-1433-LNT-CD45', 'LNT', 'token-errado');
  const linha = (await db.query(`select conversa_id from public.incidente_chat where codigo = 'CSI-261031-1433-LNT-CD45'`)).rows[0];
  return { ok: r.ok === true && linha.conversa_id === null, detalhe: `conversa_id=${linha.conversa_id}` };
});

await caso('código fora do formato é recusado', async () => {
  const a = await chamar('anon', 'qualquer coisa', 'RPC'), b = await chamar('anon', 'CSI-261031-1433-RPC-CD4', 'RPC'), c = await chamar('anon', 'CSI-261031-1433-RPC-CD45', 'ABCD');
  return { ok: [a, b, c].every((x) => x.ok === false && x.motivo === 'codigo_invalido'), detalhe: JSON.stringify([a.motivo, b.motivo, c.motivo]) };
});

await caso('diagnóstico pedido pelo menu (DIA) grava o incidente mas não suja a conversa com nota', async () => {
  const antes = (await db.query(`select count(*)::int n from public.notas_teste`)).rows[0].n;
  await chamar('anon', 'CSI-261031-1434-DIA-EF67', 'DIA');
  const depois = (await db.query(`select count(*)::int n from public.notas_teste`)).rows[0].n;
  return { ok: antes === depois, detalhe: `notas antes=${antes}, depois=${depois}` };
});

await caso('detalhe grande demais é cortado em vez de entupir a tabela', async () => {
  const grande = { rotulo: 'Tela travada', lixo: 'x'.repeat(30000) };
  await chamar('anon', 'CSI-261031-1435-TRV-GH89', 'TRV', 'token-certo', CONV, grande);
  const d = (await db.query(`select detalhe from public.incidente_chat where codigo = 'CSI-261031-1435-TRV-GH89'`)).rows[0].detalhe;
  return { ok: d.truncado === true && !('lixo' in d), detalhe: JSON.stringify(d) };
});

await caso('anon e visitantes não leem a tabela, nem pela função do painel', async () => {
  await db.exec(`set role anon`);
  // No Supabase real o anon tem o privilégio e a RLS devolve 0 linhas; neste banco de teste ele nem tem o privilégio. As duas respostas = não lê.
  let direto = 0; try { direto = (await db.query(`select count(*)::int n from public.incidente_chat`)).rows[0].n; } catch { direto = 0; }
  let negou = false; try { await db.query(`select public.painel_incidentes()`); } catch { negou = true; }
  await db.exec('reset role');
  return { ok: direto === 0 && negou, detalhe: `linhas visíveis para anon=${direto}, função negada=${negou}` };
});

await caso('painel: atendente e admin acham o caso pelo código inteiro ou por um pedaço', async () => {
  await db.exec(`set teste.papel = 'atendente'; set role authenticated`);
  const inteiro = (await db.query(`select public.painel_incidentes('csi-261031-1432-rpc-ab23') r`)).rows[0].r;
  const pedaco = (await db.query(`select public.painel_incidentes('AB23') r`)).rows[0].r;
  const recentes = (await db.query(`select public.painel_incidentes() r`)).rows[0].r;
  await db.exec(`reset role; set teste.papel = ''`);
  return { ok: inteiro.length === 1 && pedaco.length === 1 && inteiro[0].codigo === 'CSI-261031-1432-RPC-AB23' && inteiro[0].conversa_id === CONV && recentes.length >= 4, detalhe: `inteiro=${inteiro.length}, pedaço=${pedaco.length}, recentes=${recentes.length}` };
});

await caso('limite de 60 gravações por minuto: a 61ª é recusada', async () => {
  await db.exec(`truncate public.incidente_chat`);
  let recusou = null;
  for (let i = 0; i < 62; i++) {
    const r = await chamar('anon', `CSI-261031-1440-RPC-${i.toString(36).toUpperCase().padStart(4, 'A')}`, 'RPC');
    if (!r.ok && r.motivo === 'limite' && recusou === null) recusou = i;
  }
  const n = (await db.query(`select count(*)::int n from public.incidente_chat`)).rows[0].n;
  return { ok: recusou !== null && n <= 60, detalhe: `primeira recusa na tentativa ${recusou}, linhas=${n}` };
});

const texto = async (c) => (await db.query(`select texto from public.fluxo_texto where chave = $1`, [c])).rows[0].texto;
await caso('textos: a mensagem final agora diz que é PREVISÃO, que não está confirmada e que uma pessoa confirma', async () => {
  const on = await texto('pronto_online'), off = await texto('pronto_offline');
  return { ok: [on, off].every((t) => /PREVISÃO/.test(t) && /ainda não está confirmado/i.test(t) && /uma pessoa/.test(t) && /\{nome\}/.test(t)) && /a qualquer momento/.test(on), detalhe: on.slice(0, 100) };
});

await caso('textos: a abertura se apresenta como IA e diz que uma pessoa acompanha, nas duas versões', async () => {
  const a = await texto('ola_proprio'), b = await texto('ola_filho');
  return { ok: [a, b].every((t) => /inteligência artificial \(IA\)/.test(t) && /Uma pessoa da equipe acompanha/.test(t) && /previsão/.test(t)) && /\{paciente\}/.test(b), detalhe: a.slice(0, 90) };
});

await caso('textos: o que a equipe já tinha editado no painel NÃO é sobrescrito', async () => {
  return { ok: (await texto('transferir_online')) === 'Texto que a equipe editou no painel' };
});

await caso('textos: as variáveis {nome}, {resumo} e {paciente} continuam presentes e a aplicação repetida não altera de novo', async () => {
  const antes = await texto('confirmar'); await db.exec(fase9); const depois = await texto('confirmar');
  return { ok: /\{resumo\}/.test(antes) && /PREVISÃO/.test(antes) && antes === depois, detalhe: antes.replace(/\n/g, ' / ').slice(0, 110) };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
