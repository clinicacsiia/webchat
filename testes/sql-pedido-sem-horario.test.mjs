// FLUXOGRAMA: entrada (clone da produção + supabase/pedido-sem-horario.sql; pedidos "prontos" com horário escolhido) -> validação (modo teste só mexe no celular da lista) -> lógica (horário passou/ocupado sem atendente: cancela, avisa o paciente e encerra; com atendente: só faixa; horário livre e parado: faixa "Pedido parado") -> saída (contagens)
// Versão 1.0 — 13/11/2026 / Mudança: Implementação inicial (pedido do dono em 13/11/2026)
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, separarSql, REPO } from './banco-producao.mjs';

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + String(e.message).split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'OK ' : 'FALHOU'} ${nome}${d ? ' — ' + d : ''}`); };
const { db } = await criarBancoProducao();
const { um } = ajudantes(db);

// aplica a mudança (partes 1, 2; a parte 3 é a linha da conferência)
const sql = readFileSync(`${REPO}/supabase/pedido-sem-horario.sql`, 'utf8');
for (const c of separarSql(sql)) { if (/cron\.schedule/.test(c)) continue; await db.exec(c + ';'); }
const conf = readFileSync(`${REPO}/supabase/producao/funcoes/agenda_conferencia_aplicar.sql`, 'utf8');
const velha = 'and alerta_agenda is distinct from v_alerta;';
const nova = "and alerta_agenda is distinct from v_alerta and not (v_alerta is null and alerta_agenda like 'Pedido parado%');";
await caso('a linha da conferência existe uma vez no arquivo da produção', async () => ({ ok: conf.split(velha).length === 2 }));
for (const c of separarSql(conf.replace(velha, nova))) await db.exec(c + ';');

const LISTA = Array.from({ length: 8 }, (_, i) => '7198888' + (1001 + i)).join(',');
await db.query(`insert into public.config (chave, valor) values ('klingo_api_telefones_teste', $1) on conflict (chave) do update set valor = excluded.valor`, [LISTA]);
let seq = 0;
const pedido = async ({ fone = null, status = 'aguardando', dias = 7, hora = '13:30', conf = null, parado = '0 hours' } = {}) => {
  seq++; fone = fone || ('7198888' + (1000 + seq));
  const ct = (await um(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, ['Paciente Teste ' + seq, fone])).id;
  const conv = (await um(`insert into public.conversas (contato_id, nome_informado, status, ia_ativa) values ($1, $2, $3, false) returning id`, [ct, 'Paciente Teste ' + seq, status])).id;
  await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, procedimento, status, etapa, conferencia_status, escolha_horario)
    values ($1, 'exame', 'RESSONANCIA DO JOELHO', 'pronto', 'pronto', $2, jsonb_build_array(jsonb_build_object('data', ((now() at time zone 'America/Bahia')::date + $3::int)::text, 'hora', $4::text)))`, [conv, conf, dias, hora]);
  if (parado !== '0 hours') await db.query(`update public.pre_agendamentos set atualizado_em = now() - $2::interval where conversa_id = $1`, [conv, parado]);
  return conv;
};
const est = async (conv) => (await um(`select c.status, c.motivo_encerramento m, c.encerramento_origem o, c.alerta_agenda a, p.status ps,
  (select count(*) from public.mensagens x where x.conversa_id = c.id and x.autor = 'agente' and x.texto like '%foi cancelado%') avisos
  from public.conversas c join public.pre_agendamentos p on p.conversa_id = c.id where c.id = $1`, [conv]));

const passou = await pedido({ dias: -2 });
const tomado = await pedido({ dias: 5, conf: 'horario_tomado' });
const comAtendente = await pedido({ dias: -1, status: 'em_atendimento' });
const livreRecente = await pedido({ dias: 5 });
const livreParado = await pedido({ dias: 5, parado: '30 hours' });
const foraDaLista = await pedido({ dias: -3, fone: '71977776666' });

await caso('modo desligado não faz nada', async () => {
  await db.query(`update public.config set valor = 'desligado' where chave = 'pedido_horario_modo'`);
  const r = (await um(`select public.pedido_horario_vigiar() r`)).r;
  return { ok: r.modo === 'desligado' && (await est(passou)).status === 'aguardando', detalhe: JSON.stringify(r) };
});
await db.query(`update public.config set valor = 'teste' where chave = 'pedido_horario_modo'`);
const r1 = (await um(`select public.pedido_horario_vigiar() r`)).r;
await caso('modo teste: conta só a lista', async () => ({ ok: r1.vistos === 5 && r1.cancelados === 2, detalhe: JSON.stringify(r1) }));
await caso('horário passou, sem atendente: pedido cancelado, paciente avisado uma vez, conversa encerrada pelo sistema', async () => {
  const e = await est(passou); return { ok: e.ps === 'cancelado' && e.status === 'encerrada' && e.o === 'sistema' && Number(e.avisos) === 1, detalhe: JSON.stringify(e) };
});
await caso('horário ocupado no Klingo (futuro), sem atendente: também cancela e avisa', async () => {
  const e = await est(tomado); return { ok: e.ps === 'cancelado' && e.status === 'encerrada' && Number(e.avisos) === 1, detalhe: JSON.stringify(e) };
});
await caso('com atendente na conversa: não cancela, só faixa para o atendente', async () => {
  const e = await est(comAtendente); return { ok: e.ps === 'pronto' && e.status === 'em_atendimento' && /Pedido sem horário/.test(e.a || '') && Number(e.avisos) === 0, detalhe: JSON.stringify(e) };
});
await caso('horário livre e pedido recente: nada acontece', async () => {
  const e = await est(livreRecente); return { ok: e.ps === 'pronto' && e.status === 'aguardando' && !e.a, detalhe: JSON.stringify(e) };
});
await caso('horário livre e parado há 30 h: faixa "Pedido parado", pedido continua pronto', async () => {
  const e = await est(livreParado); return { ok: e.ps === 'pronto' && e.status === 'aguardando' && /^Pedido parado/.test(e.a || ''), detalhe: JSON.stringify(e) };
});
await caso('celular fora da lista nunca é tocado no modo teste', async () => {
  const e = await est(foraDaLista); return { ok: e.ps === 'pronto' && e.status === 'aguardando' && Number(e.avisos) === 0, detalhe: JSON.stringify(e) };
});
await caso('rodar de novo não repete aviso nem mensagem', async () => {
  const r = (await um(`select public.pedido_horario_vigiar() r`)).r;
  return { ok: r.cancelados === 0 && r.avisos_parado === 0 && r.avisos_sem_horario === 0 && Number((await est(passou)).avisos) === 1, detalhe: JSON.stringify(r) };
});
await caso('a conferência da agenda não apaga o aviso "Pedido parado"', async () => {
  const pid = (await um(`select id from public.pre_agendamentos where conversa_id = $1`, [livreParado])).id;
  await db.query(`select public.agenda_conferencia_aplicar($1::jsonb)`, [JSON.stringify({ resultados: [{ id: pid, conf: null }], alvos: [], ocupacao: [] })]).catch(() => {});
  return { ok: /^Pedido parado/.test((await est(livreParado)).a || '') };
});
await caso('modo ligado alcança o celular de fora da lista', async () => {
  await db.query(`update public.config set valor = 'ligado' where chave = 'pedido_horario_modo'`);
  await um(`select public.pedido_horario_vigiar() r`);
  const e = await est(foraDaLista); return { ok: e.ps === 'cancelado' && e.status === 'encerrada', detalhe: JSON.stringify(e) };
});
await caso('só o sistema executa a rotina (anon e authenticated não)', async () => {
  const x = await um(`select has_function_privilege('anon','public.pedido_horario_vigiar()','execute') a, has_function_privilege('authenticated','public.pedido_horario_vigiar()','execute') b, has_function_privilege('service_role','public.pedido_horario_vigiar()','execute') c`);
  return { ok: !x.a && !x.b && x.c };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
