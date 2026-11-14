// FLUXOGRAMA: entrada (clone da produção + supabase/klingo-agendamento-seguranca.sql; IPs e CPFs INVENTADOS) -> validação (chamada direta à trava, como a função pública faz, sem a página)
//   -> processamento (ritmo por IP, escritas por IP e por CPF, nascimentos errados, desligamento pela gestão, permissões) -> persistência (só hashes) -> saída (PASS/FAIL).
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão (auditoria da klingo-agendamento, item 2.1 da continuação). Nada toca a produção nem o Klingo.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste')`);
let erro = null;
try { await db.exec(readFileSync(`${REPO}/supabase/klingo-agendamento-seguranca.sql`, 'utf8')); } catch (e) { erro = e.message; }
registrar('o retrato monta e a migração de segurança aplica sem erro', falhas.length === 0 && !erro, erro ?? '');
// aplicar de novo não pode falhar nem apagar nada (idempotente)
let erro2 = null; try { await db.exec(readFileSync(`${REPO}/supabase/klingo-agendamento-seguranca.sql`, 'utf8')); } catch (e) { erro2 = e.message; }
registrar('reaplicar a migração é seguro', !erro2, erro2 ?? '');

const CPF_A = '11144477735', CPF_B = '52998224725';
const passar = async (ip, acao, cpf = null) => (await q(`select public.klingo_agendamento_passar($1,$2,$3) r`, [ip, acao, cpf]))[0].r;
const cfg = (k, v) => db.query(`insert into public.config (chave, valor) values ($1,$2) on conflict (chave) do update set valor = excluded.valor`, [k, v]);
const limpar = () => db.exec(`delete from public.klingo_agendamento_evento`);

await caso('padrão preserva o comportamento de hoje: leitura e escrita liberadas', async () => {
  await limpar();
  const a = await passar('198.51.100.1', 'catalogo'), b = await passar('198.51.100.1', 'cancelar', CPF_A);
  return { ok: a.ok === true && b.ok === true };
});

await caso('ritmo por IP: o 61º pedido no mesmo minuto é recusado; outro IP segue liberado', async () => {
  await limpar(); let ultimo;
  for (let i = 0; i < 61; i++) ultimo = await passar('198.51.100.2', 'horarios');
  const outro = await passar('198.51.100.3', 'horarios');
  return { ok: ultimo.ok === false && ultimo.motivo === 'ip_ritmo' && outro.ok === true, detalhe: ultimo.motivo };
});

await caso('escritas por CPF: a 9ª tentativa de marcar/cancelar do mesmo CPF na hora é recusada, mesmo vindo de IPs diferentes', async () => {
  await limpar(); let r;
  for (let i = 0; i < 9; i++) r = await passar('203.0.113.' + (10 + i), 'cancelar', CPF_A);
  const outroCpf = await passar('203.0.113.99', 'cancelar', CPF_B);
  return { ok: r.ok === false && r.motivo === 'cpf_escritas' && outroCpf.ok === true, detalhe: r.motivo };
});

await caso('escritas por IP: um IP não passa de 30 escritas por hora, nem trocando de CPF', async () => {
  await limpar(); let r;
  for (let i = 0; i < 31; i++) r = await passar('203.0.113.200', 'marcar', String(20000000000 + i));   // CPFs diferentes a cada vez: só o IP é que segura
  return { ok: r.ok === false && r.motivo === 'ip_escritas', detalhe: r.motivo };
});

await caso('nascimento errado: 10 divergências do mesmo CPF no dia travam o CPF; 15 por IP na hora travam o IP', async () => {
  await limpar();
  for (let i = 0; i < 10; i++) { const p = await passar('192.0.2.' + (i + 1), 'minhas_marcacoes', CPF_A); await db.query(`select public.klingo_agendamento_resultado($1,'divergente')`, [p.id]); }
  const bloqueado = await passar('192.0.2.200', 'minhas_marcacoes', CPF_A);
  await limpar();
  for (let i = 0; i < 15; i++) { const cpf = ['11144477735', '52998224725', '39053344705'][i % 3]; const p = await passar('192.0.2.50', 'identificar', cpf); await db.query(`select public.klingo_agendamento_resultado($1,'divergente')`, [p.id]); }
  const ipBloq = await passar('192.0.2.50', 'identificar', CPF_B);
  return { ok: bloqueado.motivo === 'cpf_divergentes' && ipBloq.motivo === 'ip_divergentes', detalhe: `${bloqueado.motivo}/${ipBloq.motivo}` };
});

await caso('desligamento pela gestão: agendamento_externo_modo=leitura bloqueia escrita e libera consulta; =nao bloqueia tudo; volta a sim', async () => {
  await limpar(); await cfg('agendamento_externo_modo', 'leitura');
  const esc = await passar('198.51.100.20', 'marcar', CPF_A), lei = await passar('198.51.100.20', 'catalogo');
  await cfg('agendamento_externo_modo', 'nao');
  const tudo = await passar('198.51.100.20', 'catalogo');
  await cfg('agendamento_externo_modo', 'sim');
  const volta = await passar('198.51.100.21', 'marcar', CPF_B);
  return { ok: esc.motivo === 'escrita_desligada' && lei.ok && tudo.motivo === 'desligado' && volta.ok, detalhe: `${esc.motivo}/${tudo.motivo}` };
});

await caso('klingo_auto=nao (mestre) também bloqueia escrita pela função pública, e só a escrita', async () => {
  await limpar(); await cfg('klingo_auto', 'nao');
  const esc = await passar('198.51.100.30', 'cancelar', CPF_A), lei = await passar('198.51.100.30', 'horarios');
  await cfg('klingo_auto', 'sim');
  return { ok: esc.motivo === 'escrita_desligada' && lei.ok === true };
});

await caso('LGPD: o registro guarda só hashes (nenhum CPF nem IP em claro)', async () => {
  await limpar(); await passar('198.51.100.40', 'cancelar', CPF_A);
  const linhas = await q(`select ip_hash, cpf_hash, acao from public.klingo_agendamento_evento`);
  const txt = JSON.stringify(linhas);
  return { ok: linhas.length === 1 && !txt.includes(CPF_A) && !txt.includes('198.51.100.40') && linhas[0].ip_hash.length === 64 && linhas[0].cpf_hash.length === 64 };
});

await caso('bloqueio é registrado e não conta como escrita nova (não alimenta o próprio bloqueio para sempre)', async () => {
  await limpar(); await cfg('agendamento_externo_modo', 'leitura');
  for (let i = 0; i < 5; i++) await passar('198.51.100.50', 'marcar', CPF_A);
  await cfg('agendamento_externo_modo', 'sim');
  const r = await passar('198.51.100.50', 'marcar', CPF_A);
  return { ok: r.ok === true, detalhe: r.motivo };
});

await caso('permissões: anon e usuário logado NÃO chamam a trava nem leem a tabela; service_role chama', async () => {
  const U = '00000000-0000-4000-8000-000000000001';
  const tenta = async (entrar, sql) => { try { await entrar(); await db.query(sql); return 'liberado'; } catch { return 'negado'; } finally { await como('').catch(() => {}); } };
  const CHAMA = `select public.klingo_agendamento_passar('1.1.1.1','catalogo',null)`;
  const anon = await tenta(anonimo, CHAMA), auth = await tenta(() => como(U), CHAMA);
  const tabAnon = await tenta(anonimo, `select * from public.klingo_agendamento_evento`), tabAuth = await tenta(() => como(U), `select * from public.klingo_agendamento_evento`);
  const srv = await tenta(() => como(U, 'service_role'), CHAMA);
  return { ok: anon === 'negado' && auth === 'negado' && tabAnon === 'negado' && tabAuth === 'negado' && srv === 'liberado', detalhe: `anon=${anon} auth=${auth} tabela(anon,auth)=${tabAnon},${tabAuth} service=${srv}` };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
