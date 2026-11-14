// FLUXOGRAMA: entrada (clone do banco de produção, retrato de 14/11/2026 + supabase/webchat-v2-sempre-ligado.sql) -> validação (conversas e telefones inventados, nenhuma linha real) -> processamento (as chaves de modo, o mestre e a lista de telefones de teste NÃO decidem mais nada;
//   a autogestão não mexe em configuração; a trava da página pública continua) -> persistência (só no clone em memória) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Prova que o autoatendimento do Klingo está sempre ligado para toda conversa existente, que klingo_api_resultado continua seguindo a configuração (não há integração),
//   que a rotina e o efeito da autogestão acabaram, que a proteção da página pública (limites e agendamento_externo_modo) continua valendo e que a auditoria de configuração segue funcionando.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um } = ajudantes(db);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste')`);
await db.exec(`insert into cron.job (jobname, schedule, command) values ('klingo-autogestao', '*/10 * * * *', 'select public.klingo_autogestao()') on conflict (jobname) do nothing`);
let sqlErro = null;
const SQL = readFileSync(`${REPO}/supabase/webchat-v2-sempre-ligado.sql`, 'utf8');
try { await db.exec(SQL); await db.exec(SQL); } catch (e) { sqlErro = String(e.message).split('\n')[0]; }   // duas vezes: reaplicar é seguro
registrar('o retrato da produção monta inteiro e a migração webchat-v2-sempre-ligado aplica (duas vezes) sem erro', falhas.length === 0 && !sqlErro, sqlErro ?? '');

const cfg = (chave, valor) => db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]);
const novaConversa = async (tel) => {
  const c = (await q(`insert into public.contatos (nome, telefone) values ('Paciente Teste', $1) returning id`, [tel]))[0].id;
  return (await q(`insert into public.conversas (contato_id) values ($1) returning id`, [c]))[0].id;
};
const CHAVES = ['klingo_api_horarios', 'klingo_api_marcar', 'klingo_api_pre_cadastro', 'klingo_api_pos', 'klingo_api_cancelar', 'klingo_api_remarcar', 'klingo_api_consultar', 'previsao_modo', 'previsao_monitor_modo', 'notificacao_modo'];
const estado = async (conv, chave) => await um(`select public.klingo_modo($1, $2) m, public.klingo_ativo($1, $2) a, public.klingo_sombra($1, $2) s`, [conv, chave]);
const COMUM = await novaConversa('71988880001');

await caso('com TODAS as chaves em "nao" e o mestre em "nao": o paciente comum fica ATIVO em todas as capacidades (as chaves não decidem mais nada)', async () => {
  await cfg('klingo_auto', 'nao'); for (const k of CHAVES) await cfg(k, 'nao');
  const r = []; for (const k of CHAVES) r.push([k, await estado(COMUM, k)]);
  const ruins = r.filter(([, x]) => !(x.m === 'sim' && x.a === true && x.s === false));
  return { ok: ruins.length === 0, detalhe: ruins.map(([k, x]) => `${k}=${x.m}`).join(', ') };
});
await caso('chave em "sombra" ou "teste", telefone fora da lista e percentual 0: continua ATIVO e nunca "sombra"', async () => {
  await cfg('klingo_auto', 'teste'); await cfg('klingo_api_percentual', '0'); await cfg('klingo_api_telefones_teste', '71900000001');
  await cfg('klingo_api_horarios', 'sombra'); await cfg('klingo_api_marcar', 'teste'); await cfg('previsao_monitor_modo', 'sombra');
  const r = [await estado(COMUM, 'klingo_api_horarios'), await estado(COMUM, 'klingo_api_marcar'), await estado(COMUM, 'previsao_monitor_modo')];
  return { ok: r.every((x) => x.m === 'sim' && x.a && !x.s), detalhe: r.map((x) => x.m).join(',') };
});
await caso('conversa que NÃO existe (ou nula) nunca libera nada', async () => {
  const r = [await estado('00000000-0000-4000-8000-00000000dead', 'klingo_api_marcar'), await estado(null, 'klingo_api_marcar')];
  return { ok: r.every((x) => x.m === 'nao' && !x.a), detalhe: r.map((x) => x.m).join(',') };
});
await caso('klingo_api_resultado (sem integração) continua seguindo a configuração: "nao" = desligado; "sim" = ligado', async () => {
  await cfg('klingo_api_resultado', 'nao'); const off = await estado(COMUM, 'klingo_api_resultado');
  await cfg('klingo_api_resultado', 'sim'); const on = await estado(COMUM, 'klingo_api_resultado');
  await cfg('klingo_api_resultado', 'nao');
  return { ok: off.a === false && off.m === 'nao' && on.a === true, detalhe: `nao→${off.m}; sim→${on.m}` };
});
await caso('o mestre klingo_mestre() é "sim" qualquer que seja klingo_auto', async () => {
  await cfg('klingo_auto', 'nao'); const m = (await um(`select public.klingo_mestre() m`)).m;
  return { ok: m === 'sim', detalhe: m };
});

// ------------------------------------------------------------------ autogestão
await caso('a autogestão não existe mais: a rotina some e a função não muda nenhuma configuração (mesmo com medidas ruins)', async () => {
  await cfg('klingo_auto', 'sim'); await cfg('klingo_api_marcar', 'sim'); await cfg('klingo_api_horarios', 'sim');
  const antes = await q(`select chave, valor from public.config where chave like 'klingo_%' order by chave`);
  const r = (await um(`select public.klingo_autogestao() r`)).r;
  const depois = await q(`select chave, valor from public.config where chave like 'klingo_%' order by chave`);
  const rotina = await um(`select count(*)::int n from cron.job where jobname = 'klingo-autogestao'`);
  return { ok: JSON.stringify(antes) === JSON.stringify(depois) && r.ligada === false && rotina.n === 0, detalhe: `rotina=${rotina.n}; resposta=${JSON.stringify(r)}` };
});

// ------------------------------------------------------------------ página pública /agendamento/
const passar = async (ip, acao, cpf = null) => (await um(`select public.klingo_agendamento_passar($1,$2,$3) r`, [ip, acao, cpf])).r;
await caso('página pública: com klingo_auto = "nao" a ESCRITA continua liberada (o mestre não decide mais)', async () => {
  await cfg('klingo_auto', 'nao'); await cfg('agendamento_externo_modo', 'sim');
  const r = await passar('198.51.100.7', 'marcar', '52998224725');
  return { ok: r.ok === true, detalhe: JSON.stringify(r) };
});
await caso('página pública: agendamento_externo_modo = "leitura" bloqueia escrita e libera leitura; "nao" bloqueia tudo (proteção contra abuso continua)', async () => {
  await cfg('agendamento_externo_modo', 'leitura');
  const esc = await passar('198.51.100.8', 'cancelar', '52998224725'), lei = await passar('198.51.100.8', 'catalogo');
  await cfg('agendamento_externo_modo', 'nao');
  const tudo = await passar('198.51.100.8', 'catalogo');
  await cfg('agendamento_externo_modo', 'sim');
  return { ok: esc.ok === false && esc.motivo === 'escrita_desligada' && lei.ok === true && tudo.ok === false && tudo.motivo === 'desligado', detalhe: `escrita=${esc.motivo}; leitura=${lei.ok}; nao=${tudo.motivo}` };
});
await caso('página pública: o limite de ritmo por IP continua valendo (61 chamadas em 1 minuto: a última é recusada)', async () => {
  let ultimo; for (let i = 0; i < 61; i++) ultimo = await passar('198.51.100.9', 'horarios');
  return { ok: ultimo.ok === false && ultimo.motivo === 'ip_ritmo', detalhe: JSON.stringify(ultimo) };
});

// ------------------------------------------------------------------ auditoria
await caso('a trilha de auditoria de configuração continua gravando quem mudou o quê', async () => {
  await cfg('disponibilidade_max_avisos_dia', '2'); await cfg('disponibilidade_max_avisos_dia', '3');
  const l = await um(`select valor_antes, valor_depois from public.config_auditoria where chave = 'disponibilidade_max_avisos_dia' order by id desc limit 1`);
  return { ok: l && l.valor_antes === '2' && l.valor_depois === '3', detalhe: JSON.stringify(l) };
});

// ------------------------------------------------------------------ limpeza (arquivo à parte, rodado pelo painel)
await caso('a LIMPEZA apaga as funções de modo/promoção e as chaves sem efeito, deixa as que ainda têm uso e o sistema segue ligado', async () => {
  await cfg('klingo_api_resultado', 'nao'); await cfg('klingo_webhook', 'nao');
  await db.exec(readFileSync(`${REPO}/supabase/webchat-v2-sempre-ligado-limpeza.sql`, 'utf8'));
  const funcoes = await um(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('klingo_promover','klingo_decidir','klingo_recomendar','klingo_chave_de_modo','klingo_modo_nivel','klingo_aceita_sombra','klingo_modo_chave','klingo_autogestao')`);
  const chaves = await um(`select count(*)::int n from public.config where chave in ('klingo_auto','klingo_autogestao','klingo_so_liberados','klingo_api_percentual','klingo_api_telefones_teste','klingo_api_horarios','klingo_api_marcar','klingo_api_pre_cadastro','klingo_api_pos','klingo_api_cancelar','klingo_api_remarcar','klingo_api_consultar','previsao_modo','previsao_monitor_modo','notificacao_modo')`);
  const ficam = await um(`select count(*)::int n from public.config where chave in ('klingo_api_resultado','klingo_webhook','agendamento_externo_modo')`);
  const aud = await um(`select count(*)::int n from public.config_auditoria where origem = 'limpeza:webchat-v2-sempre-ligado' and operacao = 'delete'`);
  const ativo = await estado(COMUM, 'klingo_api_marcar'); const resultado = await estado(COMUM, 'klingo_api_resultado');
  const pagina = await passar('198.51.100.20', 'horarios');
  return { ok: funcoes.n === 0 && chaves.n === 0 && ficam.n === 3 && aud.n >= 10 && ativo.a === true && resultado.a === false && pagina.ok === true, detalhe: `funções restantes=${funcoes.n}; chaves restantes=${chaves.n}; mantidas=${ficam.n}; auditadas=${aud.n}; marcar=${ativo.m}; laudo=${resultado.m}; página=${pagina.ok}` };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
