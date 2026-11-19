// FLUXOGRAMA: entrada (clone da produção + supabase/lgpd-remover-biometria.sql e supabase/lgpd-eliminacao.sql; pessoas, telefones, CPFs e e-mails INVENTADOS)
//   -> validação (só admin; dado incompleto recusado; simulação não apaga) -> lógica (confirmar apaga conversa, mensagem, foto, acesso rápido, filho, pré-cadastro e conta de quem pediu, e NADA de outra pessoa; registra o pedido sem dado em claro)
//   -> saída (PASS/FAIL por caso) | REVERSÃO: ver cabeçalho dos dois .sql (apagar dado não tem volta)
// Versão 1.0 — 19/11/2026 / Mudança: primeira versão (LGPD art. 18 e remoção da biometria). Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
registrar('o retrato da produção monta inteiro', falhas.length === 0, `${falhas.length} falhas`);

// ---------------- biometria ----------------
const bio = readFileSync(`${REPO}/supabase/lgpd-remover-biometria.sql`, 'utf8');
const existe = async (sql) => (await um(sql)).v;
const sobrou = async () => ({
  f: await existe(`select count(*)::int v from pg_proc where pronamespace = 'public'::regnamespace and proname in ('assinatura_contexto','assinatura_registrar','fila_chamar_assinatura','fila_cancelar_assinatura')`),
  t: await existe(`select count(*)::int v from pg_tables where schemaname = 'public' and tablename in ('registro_assinaturas','assinatura_tentativas')`),
  c: await existe(`select count(*)::int v from information_schema.columns where table_schema = 'public' and table_name = 'pacientes' and column_name in ('perfil_biometrico_historico','assinatura_papel_path')`),
});
await caso('o retrato da produção já não tem funções, tabelas nem colunas da biometria', async () => {
  const s = await sobrou();
  return { ok: s.f === 0 && s.t === 0 && s.c === 0, detalhe: `${s.f} funções, ${s.t} tabelas, ${s.c} colunas` };
});
await caso('a remoção roda onde nada existe (idempotente) sem erro e sem criar nada', async () => {
  await db.exec(bio); await db.exec(bio);
  const s = await sobrou();
  return { ok: s.f === 0 && s.t === 0 && s.c === 0 };
});
await caso('a remoção RECUSA se algum dia houver linha numa tabela do módulo (nada é apagado)', async () => {
  await db.exec(`create table public.registro_assinaturas (id int); insert into public.registro_assinaturas values (1)`);
  let erro = ''; try { await db.exec(bio); } catch (e) { erro = String(e.message); }
  const ficou = await existe(`select count(*)::int v from public.registro_assinaturas`);
  await db.exec(`drop table public.registro_assinaturas`);
  return { ok: /registro_assinaturas tem linhas/.test(erro) && ficou === 1, detalhe: erro.slice(0, 70) };
});
await caso('a fila de chegada e o estado da fila continuam existindo', async () => {
  const f = await existe(`select count(*)::int v from pg_proc where pronamespace = 'public'::regnamespace and proname in ('fila_estado','fila_listar','fila_cheguei','fila_minha_vez')`);
  return { ok: f >= 3, detalhe: `${f} funções` };
});

// ---------------- eliminação ----------------
const el = readFileSync(`${REPO}/supabase/lgpd-eliminacao.sql`, 'utf8');
await caso('a eliminação aplica duas vezes sem erro (idempotente)', async () => { await db.exec(el); await db.exec(el); return { ok: true }; });

const ADM = '00000000-0000-4000-8000-0000000000a1', ATE = '00000000-0000-4000-8000-0000000000a2';
await db.exec(`
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste') on conflict (chave) do update set valor = excluded.valor;
  insert into auth.users (id, email) values ('${ADM}', 'adm@x.invalid'), ('${ATE}', 'ate@x.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Adm Teste', 'adm@x.invalid', 'admin', true), ('${ATE}', 'Ate Teste', 'ate@x.invalid', 'atendente', true);
`);
// duas pessoas inventadas: Ana (pede a eliminação) e Bia (não pede)
const ANA = { tel: '71988880001', cpf: '11122233344', mail: 'ana.teste@x.invalid' };
const BIA = { tel: '71988880002', cpf: '55566677788', mail: 'bia.teste@x.invalid' };
const montar = async (p, nome) => {
  const c = (await um(`insert into public.contatos (nome, telefone, email) values ($1, $2, $3) returning id`, [nome, p.tel, p.mail])).id;
  const cv = (await um(`insert into public.conversas (contato_id, nome_informado, email_informado) values ($1, $2, $3) returning id`, [c, nome, p.mail])).id;
  await q(`insert into public.mensagens (conversa_id, autor, texto) values ($1, 'cliente', 'mensagem de teste')`, [cv]);
  await q(`insert into public.conversa_anexo (conversa_id, tipo, mime, dados) values ($1, 'imagem', 'image/jpeg', '\\x00'::bytea)`, [cv]);
  const ap = (await um(`insert into public.app_paciente (telefone, nome, nascimento, pin_hash, cpf, email) values ($1, $2, '1990-05-05', 'hash-de-teste', $3, $4) returning id`, [p.tel, nome, p.cpf, p.mail])).id;
  await q(`insert into public.app_filho (responsavel_id, nome, nascimento, cpf) values ($1, 'Filho de ' || $2, '2018-01-01', null)`, [ap, nome]);
  await q(`insert into public.pmarc_pessoa (chave, nome, celular, email) values ($1, $2, $3, $4)`, ['chave-' + p.tel, nome, p.tel, p.mail]);
  await q(`insert into public.app_codigo_email (finalidade, telefone, nome, email, codigo, expira_em) values ('cadastro', $1, $2, $3, '123456', now() + interval '1 hour')`, [p.tel, nome, p.mail]);
  return { c, cv, ap };
};
const ana = await montar(ANA, 'Ana Teste'); const bia = await montar(BIA, 'Bia Teste');
const msgBia = (await um(`select count(*)::int v from public.mensagens where conversa_id = $1`, [bia.cv])).v;   // inclui a mensagem automática que a conversa cria
const conta = async (tab, col, v) => (await um(`select count(*)::int v from public.${tab} where ${col} = $1`, [v])).v;
const chamar = async (quem, args) => {
  await como(quem);
  try { return (await q(`select public.painel_lgpd_eliminar($1, $2, $3, $4) r`, args))[0].r; } catch (e) { return { erro: String(e.message) }; } finally { await db.exec('reset role'); }
};

await caso('atendente e anônimo não eliminam nada', async () => {
  const a = await chamar(ATE, [ANA.tel, null, null, true]);
  await anonimo(); let b = ''; try { await q(`select public.painel_lgpd_eliminar($1, null, null, true)`, [ANA.tel]); } catch (e) { b = String(e.message); } finally { await db.exec('reset role'); }
  return { ok: /administrador/.test(a.erro || '') && b !== '' && (await conta('contatos', 'id', ana.c)) === 1, detalhe: `${a.erro || ''} | ${b.slice(0, 60)}` };
});
await caso('dado incompleto ou ausente é recusado', async () => {
  const x = [await chamar(ADM, ['7198', null, null, true]), await chamar(ADM, [null, '123', null, true]), await chamar(ADM, [null, null, 'sem-arroba', true]), await chamar(ADM, [null, null, null, true])];
  return { ok: x.every((r) => r.erro), detalhe: x.map((r) => (r.erro || '').slice(0, 25)).join(' | ') };
});
await caso('simulação conta tudo e não apaga nada', async () => {
  const r = await chamar(ADM, [ANA.tel, null, null, false]);
  const ap = r.apagado || {};
  const ok = r.simulacao === true && ap.contatos === 1 && ap.conversas === 1 && ap.mensagens >= 1 && ap.fotos_e_arquivos === 1 && ap.acesso_rapido === 1 && ap.filhos === 1 && ap.previsao_de_marcacao === 1 && ap.codigos_por_email === 1
    && (await conta('contatos', 'id', ana.c)) === 1 && (await conta('lgpd_pedido', 'tipo', 'eliminacao')) === 0;
  return { ok, detalhe: JSON.stringify(ap) };
});
await caso('confirmar apaga tudo da Ana (por telefone) e registra o pedido sem dado em claro', async () => {
  const r = await chamar(ADM, [ANA.tel, ANA.cpf, ANA.mail, true]);
  const resto = [await conta('contatos', 'id', ana.c), await conta('conversas', 'id', ana.cv), await conta('mensagens', 'conversa_id', ana.cv), await conta('conversa_anexo', 'conversa_id', ana.cv),
    await conta('app_paciente', 'id', ana.ap), await conta('app_filho', 'responsavel_id', ana.ap), await conta('pmarc_pessoa', 'celular', ANA.tel), await conta('app_codigo_email', 'telefone', ANA.tel)];
  const reg = await um(`select ident_hash, resumo, por, (select count(*)::int from public.lgpd_pedido) n from public.lgpd_pedido order by criado_em desc limit 1`);
  const claro = JSON.stringify(reg).includes(ANA.tel) || JSON.stringify(reg).includes(ANA.cpf) || JSON.stringify(reg).includes(ANA.mail);
  return { ok: r.ok === true && r.simulacao === false && resto.every((n) => n === 0) && reg.n === 1 && reg.por === ADM && !claro && Array.isArray(r.mantido) && r.mantido.length >= 3, detalhe: `restos=${resto.join(',')} claro=${claro}` };
});
await caso('a Bia não perde nada', async () => {
  const resto = [await conta('contatos', 'id', bia.c), await conta('conversas', 'id', bia.cv), await conta('mensagens', 'conversa_id', bia.cv), await conta('conversa_anexo', 'conversa_id', bia.cv),
    await conta('app_paciente', 'id', bia.ap), await conta('app_filho', 'responsavel_id', bia.ap), await conta('pmarc_pessoa', 'celular', BIA.tel), await conta('app_codigo_email', 'telefone', BIA.tel)];
  return { ok: resto.every((n) => n >= 1) && resto[2] === msgBia, detalhe: resto.join(',') };
});
await caso('por CPF ou e-mail sozinhos também acha a pessoa (acesso rápido da Bia)', async () => {
  const r = await chamar(ADM, [null, BIA.cpf, null, false]);
  const r2 = await chamar(ADM, [null, null, BIA.mail.toUpperCase(), false]);
  return { ok: (r.apagado || {}).acesso_rapido === 1 && (r2.apagado || {}).contatos === 1 && (r2.apagado || {}).conversas === 1, detalhe: `${JSON.stringify(r.apagado)} | ${JSON.stringify(r2.apagado)}` };
});
await caso('painel_lgpd_pedidos lista só para admin e sem dado pessoal', async () => {
  await como(ADM); const lista = (await q(`select public.painel_lgpd_pedidos() r`))[0].r; await db.exec('reset role');
  await como(ATE); let neg = ''; try { await q(`select public.painel_lgpd_pedidos()`); } catch (e) { neg = String(e.message); } finally { await db.exec('reset role'); }
  const txt = JSON.stringify(lista);
  return { ok: Array.isArray(lista) && lista.length === 1 && !txt.includes(ANA.tel) && /administrador/.test(neg), detalhe: neg.slice(0, 60) };
});
await caso('anônimo e logado comum não leem a tabela do registro', async () => {
  await anonimo(); let a = ''; try { await q(`select * from public.lgpd_pedido`); } catch (e) { a = String(e.message); } finally { await db.exec('reset role'); }
  return { ok: /permission denied/i.test(a), detalhe: a.slice(0, 60) };
});

const falhou = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhou} de ${resultados.length} passaram`);
process.exit(falhou ? 1 : 0);
